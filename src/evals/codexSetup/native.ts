import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

/** Fixed, non-secret setup classifications. Native output is never attached. */
export const CODEX_SETUP_ERROR_CODES = [
  'linux_required',
  'environment_invalid',
  'home_not_fresh',
  'home_unsafe',
  'workspace_unsafe',
  'evidence_dir_unsafe',
  'app_path_invalid',
  'codex_path_invalid',
  'api_key_file_unsafe',
  'api_key_invalid',
  'login_failed',
  'login_timeout',
  'login_unverified',
  'mcp_preflight_failed',
  'mcp_status_unavailable',
  'mcp_server_not_ready',
  'host_tool_policy_unenforced',
  'app_start_failed',
  'app_exited',
  'app_stop_failed',
  'app_not_running',
  'prompt_invalid',
  'prompt_too_large',
  'url_handoff_failed',
  'url_handoff_unverified',
] as const;

export type CodexSetupErrorCode = (typeof CODEX_SETUP_ERROR_CODES)[number];

export class CodexSetupError extends Error {
  constructor(
    readonly code: CodexSetupErrorCode,
    /** Only fixed text, such as an environment variable name. */
    detail?: string
  ) {
    super(
      `ChatGPT native setup failed (${code}${detail ? `: ${detail}` : ''}); no prompt was sent and nothing was retried.`
    );
    this.name = 'CodexSetupError';
  }
}

export interface BoundedRunResult {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  /** Memory-only; callers must classify it and never publish it. */
  output: Buffer;
  failure?: 'timeout' | 'output_limit' | 'spawn_error';
}

export interface BoundedRunOptions {
  env: Record<string, string>;
  cwd: string;
  /** Written to stdin once, then stdin is closed. Never argv. */
  input?: Buffer;
  timeoutMs: number;
  /** Capture stdout and stderr together up to this bound; 0 discards both. */
  maxOutputBytes: number;
}

/** Send a signal to a process group. Returns false when the group is gone. */
export function signalGroup(pgid: number, signal: NodeJS.Signals | 0): boolean {
  try {
    process.kill(-pgid, signal);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false;
    throw error;
  }
}

/** TERM, then KILL, then verify that no process in the owned group remains. */
export async function stopGroup(
  pgid: number,
  graceMs = 5000
): Promise<boolean> {
  for (const signal of ['SIGTERM', 'SIGKILL'] as const) {
    if (!signalGroup(pgid, signal)) return true;
    const deadline = Date.now() + graceMs;
    while (Date.now() < deadline) {
      await delay(50);
      if (!signalGroup(pgid, 0)) return true;
    }
  }
  return !signalGroup(pgid, 0);
}

/**
 * One native command in its own process group with a deadline and output bound.
 * The group is killed on timeout, overflow, and after exit. No retry.
 */
export function runBounded(
  command: string,
  args: readonly string[],
  options: BoundedRunOptions
): Promise<BoundedRunResult> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let failure: BoundedRunResult['failure'];
    let settled = false;
    const capture = options.maxOutputBytes > 0;
    const child = spawn(command, [...args], {
      cwd: options.cwd,
      env: options.env,
      detached: true,
      shell: false,
      stdio: ['pipe', capture ? 'pipe' : 'ignore', capture ? 'pipe' : 'ignore'],
    });
    const killGroup = () => {
      if (child.pid !== undefined) {
        try {
          signalGroup(child.pid, 'SIGKILL');
        } catch {
          // The group is not ours to signal; the leader has already exited.
        }
      }
    };
    const timer = setTimeout(() => {
      failure ??= 'timeout';
      killGroup();
    }, options.timeoutMs);
    const settle = (exitCode: number | null, signal: NodeJS.Signals | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      killGroup();
      resolve({ exitCode, signal, output: Buffer.concat(chunks), failure });
    };
    const collect = (chunk: Buffer) => {
      size += chunk.length;
      if (size > options.maxOutputBytes) {
        failure ??= 'output_limit';
        killGroup();
        return;
      }
      chunks.push(chunk);
    };
    child.stdout?.on('data', collect);
    child.stderr?.on('data', collect);
    child.on('error', () => {
      failure ??= 'spawn_error';
      if (child.pid === undefined) settle(null, null);
    });
    child.on('close', settle);
    child.stdin?.on('error', () => {
      // An uncertain write is classified by the exit status; never retried.
    });
    child.stdin?.end(options.input ?? Buffer.alloc(0));
  });
}
