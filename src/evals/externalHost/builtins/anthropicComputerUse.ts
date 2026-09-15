import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const DRIVER_PATH = join(
  process.env.MST_COWORK_DRIVER_ROOT ?? process.cwd(),
  'scripts',
  'cowork_computer_use.py'
);

export interface ComputerUseSubmissionResult {
  status: 'submitted';
  action_count: number;
  model: string;
  submission_action: Record<string, unknown>;
}

export async function runAnthropicComputerUseSubmission(
  query: string,
  options: { deadlineAt: number; maxActions?: number }
): Promise<ComputerUseSubmissionResult> {
  const timeoutMs = Math.max(1, options.deadlineAt - Date.now());
  const scriptPath = DRIVER_PATH;
  diagnostic(
    `starting Computer Use driver (script=${scriptPath}, maxActions=${options.maxActions ?? 24}, timeoutMs=${timeoutMs})`
  );
  let stdout = '';
  let stderr = '';
  try {
    const result = await execFileAsync(
      process.env.MST_COWORK_PYTHON ?? 'python3',
      [scriptPath, query, '--max-actions', String(options.maxActions ?? 24)],
      {
        timeout: timeoutMs,
        maxBuffer: 2 * 1024 * 1024,
        env: { ...process.env, PYTHONUNBUFFERED: '1' },
      }
    );
    stdout = String(result.stdout ?? '');
    stderr = String(result.stderr ?? '');
  } catch (error) {
    const childError = error as { stdout?: string; stderr?: string };
    stdout = String(childError.stdout ?? '');
    stderr = String(childError.stderr ?? '');
    const details = [
      formatError(error),
      stdout ? `stdout=${stdout.slice(-1000)}` : '',
      stderr ? `stderr=${stderr.slice(-1000)}` : '',
    ]
      .filter(Boolean)
      .join('; ');
    diagnostic(`Computer Use driver failed: ${details}`);
    throw new Error(`Computer Use submission failed: ${details}`);
  }

  diagnostic(
    `Computer Use driver exited successfully (stdoutBytes=${stdout.length})`
  );
  const record = parseLastJsonLine(stdout);
  if (record?.status !== 'submitted') {
    const detail = JSON.stringify(record ?? stdout.slice(-1000));
    diagnostic(`Computer Use driver stopped before submission: ${detail}`);
    throw new Error(
      `Computer Use submission did not reach its once-only submit boundary: ${detail}`
    );
  }
  const actionCount =
    typeof record.action_count === 'number' ? record.action_count : 'unknown';
  diagnostic(
    `Computer Use submission boundary reached (actions=${actionCount})`
  );
  return record as unknown as ComputerUseSubmissionResult;
}

function diagnostic(message: string): void {
  process.stderr.write(`[mst:cowork-cu] ${message}\n`);
}

function parseLastJsonLine(
  stdout: string
): Record<string, unknown> | undefined {
  for (const line of stdout.trim().split('\n').reverse()) {
    try {
      const value = JSON.parse(line) as unknown;
      if (value && typeof value === 'object')
        return value as Record<string, unknown>;
    } catch {
      // Ignore planner logging and inspect the next line.
    }
  }
  return undefined;
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
