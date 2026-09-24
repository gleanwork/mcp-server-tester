import { spawn, type ChildProcess } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import type { ChatgptApplicationController } from '../chatgpt/driver.js';
import {
  CodexSetupError,
  runBounded,
  signalGroup,
  stopGroup,
} from '../codexSetup/native.js';

/** Fixed Chromium flags for an isolated X11/AT-SPI desktop. Never caller-chosen. */
export const LINUX_CHATGPT_APP_FLAGS = [
  '--no-sandbox',
  '--ozone-platform=x11',
  '--force-renderer-accessibility',
  '--disable-gpu',
  '--disable-dev-shm-usage',
] as const;

/** Fixed variables that make the Electron UI visible on the AT-SPI bus. */
export const LINUX_CHATGPT_FIXED_ENVIRONMENT = {
  PATH: '/usr/bin:/bin',
  LANG: 'C.UTF-8',
  NO_AT_BRIDGE: '0',
  ACCESSIBILITY_ENABLED: '1',
  GTK_MODULES: 'gail:atk-bridge',
} as const;

const START_SETTLE_MS = 500;
const HANDOFF_TIMEOUT_MS = 20_000;
/** Linux MAX_ARG_STRLEN is 128 KiB; the URL is one argv element. */
const MAX_URL_BYTES = 120 * 1024;
const TOKEN_KEY = /^MST_CHATGPT_MCP_TOKEN_\d+$/;

export interface LinuxChatgptAppOptions {
  appPath: string;
  /** Validated session and profile variables. Never evaluator secrets. */
  environment: Record<string, string>;
  /** The one MST-created trusted workspace used by every draft deep link. */
  workspace: string;
}

export interface LinuxChatgptAppController extends ChatgptApplicationController {
  /** Hand a draft to the running app. Never sends it. No retry. */
  openPrompt(prompt: string): Promise<void>;
}

/** Python's quote(value, safe='') for the codex:// URL contract. */
export function quoteUrlComponent(value: string): string {
  // Lone surrogates cannot be encoded as strict UTF-8.
  if (
    /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(
      value
    )
  )
    throw new CodexSetupError('prompt_invalid');
  return Array.from(Buffer.from(value, 'utf8'), (byte) =>
    /[A-Za-z0-9_.~-]/.test(String.fromCharCode(byte))
      ? String.fromCharCode(byte)
      : `%${byte.toString(16).toUpperCase().padStart(2, '0')}`
  ).join('');
}

export function chatgptDraftUrl(workspace: string, prompt: string): string {
  let url = `codex://new?path=${quoteUrlComponent(workspace)}`;
  if (prompt) url += `&prompt=${quoteUrlComponent(prompt)}`;
  return url;
}

/** Spawn, own, and stop one ChatGPT app process group in-process. */
export function createLinuxChatgptApp(
  options: LinuxChatgptAppOptions
): LinuxChatgptAppController {
  let child: ChildProcess | undefined;
  const running = () =>
    child !== undefined &&
    child.pid !== undefined &&
    child.exitCode === null &&
    child.signalCode === null;
  const baseEnvironment: Record<string, string> = {
    ...options.environment,
    ...LINUX_CHATGPT_FIXED_ENVIRONMENT,
  };

  function launchEnvironment(
    additions: Record<string, string>
  ): Record<string, string> {
    const environment: Record<string, string> = { ...baseEnvironment };
    for (const [key, value] of Object.entries(additions)) {
      if (key === 'CODEX_HOME') {
        if (value !== baseEnvironment.CODEX_HOME)
          throw new CodexSetupError('environment_invalid', 'CODEX_HOME');
        continue;
      }
      // Only MCP bearer variables reach the app; no other evaluator values.
      if (!TOKEN_KEY.test(key)) continue;
      if (!value || value.length > 16_384 || /[^\x21-\x7e]/.test(value))
        throw new CodexSetupError('environment_invalid', key);
      environment[key] = value;
    }
    return environment;
  }

  return {
    async state() {
      return { running: running() };
    },
    async start(additions = {}) {
      if (running()) throw new CodexSetupError('app_start_failed');
      const environment = launchEnvironment(additions);
      const process = spawn(options.appPath, [...LINUX_CHATGPT_APP_FLAGS], {
        cwd: environment.HOME,
        env: environment,
        detached: true,
        shell: false,
        stdio: 'ignore',
      });
      const spawned = await new Promise<boolean>((resolve) => {
        process.once('spawn', () => resolve(true));
        process.once('error', () => resolve(false));
      });
      if (!spawned || process.pid === undefined)
        throw new CodexSetupError('app_start_failed');
      child = process;
      await delay(START_SETTLE_MS);
      // This is process state, not UI readiness or authentication proof.
      if (!running()) {
        await stopGroup(process.pid).catch(() => false);
        throw new CodexSetupError('app_exited');
      }
    },
    async stop() {
      const current = child;
      if (current?.pid === undefined) return;
      let stopped = false;
      try {
        stopped = await stopGroup(current.pid);
      } catch {
        stopped = false;
      }
      if (!stopped) throw new CodexSetupError('app_stop_failed');
      child = undefined;
    },
    async openPrompt(prompt) {
      if (!running() || child?.pid === undefined)
        throw new CodexSetupError('app_not_running');
      const main = child.pid;
      const url = chatgptDraftUrl(options.workspace, prompt);
      if (Buffer.byteLength(url) > MAX_URL_BYTES)
        throw new CodexSetupError('prompt_too_large');
      // A short-lived second instance delivers the URL over the app's own IPC.
      // It gets no MCP tokens; the main process keeps its original environment.
      const result = await runBounded(
        options.appPath,
        [...LINUX_CHATGPT_APP_FLAGS, url],
        {
          env: baseEnvironment,
          cwd: baseEnvironment.HOME ?? options.workspace,
          timeoutMs: HANDOFF_TIMEOUT_MS,
          maxOutputBytes: 0,
        }
      );
      if (result.failure || result.exitCode !== 0)
        throw new CodexSetupError('url_handoff_failed');
      // Exit zero acknowledges the hand-off only. The AT-SPI driver must still
      // read the exact composer and surface before it can press Send.
      if (!running() || child?.pid !== main || !signalGroup(main, 0))
        throw new CodexSetupError('url_handoff_unverified');
    },
  };
}
