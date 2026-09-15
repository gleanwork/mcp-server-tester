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

export interface ComputerUseHitlResult {
  status: 'hitl_checked';
  action_count: number;
  model: string;
}

export async function runAnthropicComputerUseSubmission(
  query: string,
  options: { deadlineAt: number; maxActions?: number }
): Promise<ComputerUseSubmissionResult> {
  return runComputerUseDriver(query, options, 'submit', 'submission');
}

export async function runAnthropicComputerUseHitl(options: {
  deadlineAt: number;
  maxActions?: number;
}): Promise<ComputerUseHitlResult> {
  return runComputerUseDriver(
    'Resolve any visible HITL prompt for the submitted Cowork task.',
    options,
    'hitl',
    'HITL check'
  );
}

function runComputerUseDriver(
  query: string,
  options: { deadlineAt: number; maxActions?: number },
  mode: 'submit',
  label: string
): Promise<ComputerUseSubmissionResult>;
function runComputerUseDriver(
  query: string,
  options: { deadlineAt: number; maxActions?: number },
  mode: 'hitl',
  label: string
): Promise<ComputerUseHitlResult>;
async function runComputerUseDriver(
  query: string,
  options: { deadlineAt: number; maxActions?: number },
  mode: 'submit' | 'hitl',
  label: string
): Promise<ComputerUseSubmissionResult | ComputerUseHitlResult> {
  const timeoutMs = Math.max(1, options.deadlineAt - Date.now());
  const maxActions = options.maxActions ?? (mode === 'hitl' ? 12 : 24);
  diagnostic(
    `starting Computer Use ${label} (script=${DRIVER_PATH}, maxActions=${maxActions}, timeoutMs=${timeoutMs})`
  );
  let stdout = '';
  let stderr = '';
  try {
    const result = await execFileAsync(
      process.env.MST_COWORK_PYTHON ?? 'python3',
      [DRIVER_PATH, query, '--max-actions', String(maxActions), '--mode', mode],
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
    diagnostic(`Computer Use ${label} failed: ${details}`);
    throw new Error(`Computer Use ${label} failed: ${details}`);
  }

  diagnostic(
    `Computer Use ${label} exited successfully (stdoutBytes=${stdout.length})`
  );
  const record = parseLastJsonLine(stdout);
  const expectedStatus = mode === 'submit' ? 'submitted' : 'hitl_checked';
  if (record?.status !== expectedStatus) {
    const detail = JSON.stringify(record ?? stdout.slice(-1000));
    diagnostic(`Computer Use ${label} stopped unexpectedly: ${detail}`);
    throw new Error(
      `Computer Use ${label} did not reach ${expectedStatus}: ${detail}`
    );
  }
  diagnostic(
    `Computer Use ${label} completed (actions=${typeof record.action_count === 'number' ? record.action_count : 'unknown'})`
  );
  return record as unknown as
    | ComputerUseSubmissionResult
    | ComputerUseHitlResult;
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
