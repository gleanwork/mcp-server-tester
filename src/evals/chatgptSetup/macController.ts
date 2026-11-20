import type { ChatgptApplicationController } from '../chatgpt/driver.js';
import { homedir } from 'node:os';
import { existsSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { z } from 'zod';
import {
  compileSwiftHelper,
  NativeHelperBuildError,
  type NativeHelper,
} from '../nativeHelper.js';
import { CHATGPT_CONTROLLER_SOURCE } from './macControllerSource.js';

const ERROR = 'Unable to control the ChatGPT desktop application safely.';
const StateSchema = z.object({
  running: z.boolean(),
  instances: z.number().int().min(0).max(1),
});

export interface ChatgptApplicationOptions {
  bundleId?: string;
  appPath?: string;
}

const controllers = new Map<string, Promise<ChatgptApplicationController>>();

/** A removed temporary CA bundle can leave the restored app on its splash screen. */
function withoutMissingCaFiles<T extends Record<string, string | undefined>>(
  environment: T
): T {
  const filtered = { ...environment };
  for (const name of [
    'SSL_CERT_FILE',
    'NODE_EXTRA_CA_CERTS',
    'REQUESTS_CA_BUNDLE',
    'CURL_CA_BUNDLE',
  ]) {
    const file = filtered[name];
    if (file && isAbsolute(file) && !existsSync(file)) delete filtered[name];
  }
  return filtered;
}

export async function getChatgptApplicationController(
  options: ChatgptApplicationOptions = {}
): Promise<ChatgptApplicationController> {
  if (process.platform !== 'darwin') throw new Error(ERROR);
  const bundleId = options.bundleId ?? 'com.openai.codex';
  const appPath = resolve(options.appPath ?? '/Applications/ChatGPT.app');
  const key = JSON.stringify([bundleId, appPath]);
  let controller = controllers.get(key);
  if (!controller) {
    controller = compile(bundleId, appPath).catch((error) => {
      controllers.delete(key);
      throw error;
    });
    controllers.set(key, controller);
  }
  return controller;
}

async function compile(
  bundleId: string,
  appPath: string
): Promise<ChatgptApplicationController> {
  let helper: NativeHelper;
  try {
    helper = await compileSwiftHelper({
      name: 'chatgpt',
      source: CHATGPT_CONTROLLER_SOURCE,
    });
  } catch (error) {
    // A build failure says what to fix on the machine, so it reaches the user.
    if (error instanceof NativeHelperBuildError) throw error;
    throw controllerError('compile', error);
  }
  const invoke = async (
    action: 'state' | 'stop' | 'start',
    environment: Record<string, string> = {}
  ): Promise<unknown> => {
    try {
      return await helper.run([action, bundleId, appPath], {
        // NSWorkspace can pass the helper's environment into the app. The
        // terminal may contain proxy or CA settings that the signed-in app did
        // not have before setup, so launch it with only explicit overrides.
        environment: action === 'start' ? 'minimal' : 'inherit',
        timeoutMs: 45_000,
        // Launch credentials travel over a pipe, never in process-list arguments.
        stdin: JSON.stringify(withoutMissingCaFiles(environment)),
      });
    } catch (error) {
      throw controllerError(action, error);
    }
  };
  return {
    async state() {
      const state = StateSchema.parse(await invoke('state'));
      if (state.running !== (state.instances === 1)) throw new Error(ERROR);
      return { running: state.running };
    },
    async stop() {
      z.object({ stopped: z.literal(true) }).parse(await invoke('stop'));
    },
    async start(environment) {
      z.object({ launched: z.literal(true) }).parse(
        await invoke('start', environment)
      );
    },
  };
}

function controllerError(stage: string, error: unknown): Error {
  // Do not include execFile's message: it can echo launch arguments containing secrets.
  const failure = error as {
    code?: unknown;
    signal?: unknown;
    stderr?: unknown;
  };
  const detail =
    typeof failure?.stderr === 'string'
      ? failure.stderr.trim().slice(0, 2000)
      : '';
  const code =
    typeof failure?.code === 'string' || typeof failure?.code === 'number'
      ? String(failure.code)
      : 'unknown';
  const signal = typeof failure?.signal === 'string' ? failure.signal : 'none';
  return new Error(
    `${ERROR} Stage: ${stage}; code: ${code}; signal: ${signal}${detail ? `; ${detail}` : ''}`,
    { cause: error }
  );
}

export function defaultChatgptAppPath(): string {
  return resolve(
    process.env.MST_CHATGPT_APP_PATH ?? '/Applications/ChatGPT.app'
  );
}

export function defaultChatgptBundleId(): string {
  return process.env.MST_CHATGPT_BUNDLE_ID ?? 'com.openai.codex';
}

export function defaultChatgptConfigHome(): string {
  return join(homedir(), '.codex');
}
