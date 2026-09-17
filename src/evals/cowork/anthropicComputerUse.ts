import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { ensureCoworkPython } from './pythonRuntime.js';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
function resolveDriverPath(env: NodeJS.ProcessEnv): string {
  const configuredRoot = env.MST_COWORK_DRIVER_ROOT;
  if (configuredRoot) {
    return join(configuredRoot, 'scripts', 'cowork_computer_use.py');
  }

  return createRequire(
    typeof __filename === 'string' ? __filename : import.meta.url
  ).resolve('@gleanwork/mcp-server-tester/cowork-runtime');
}

export interface ComputerUseOptions {
  deadlineAt: number;
  maxActions?: number;
  model?: string;
  env?: NodeJS.ProcessEnv;
}

export interface ComputerUseSubmissionResult {
  status: 'submitted';
  action_count: number;
  model: string;
  submission_action: Record<string, unknown>;
}

/** Exhausted inspection is not proof that the native task failed. */
export class ComputerUseHitlBudgetError extends Error {
  override name = 'ComputerUseHitlBudgetError';
}

export interface ComputerUseHitlResult {
  status: 'hitl_checked';
  action_count: number;
  model: string;
}

export async function runAnthropicComputerUseSubmission(
  query: string,
  options: ComputerUseOptions
): Promise<ComputerUseSubmissionResult> {
  return runComputerUseDriver(query, options, 'submit', 'submission');
}

export async function runAnthropicComputerUseHitl(
  options: ComputerUseOptions & { task?: string }
): Promise<ComputerUseHitlResult> {
  return runComputerUseDriver(
    options.task ??
      'Resolve any visible HITL prompt for the submitted Cowork task.',
    options,
    'hitl',
    'HITL check'
  );
}

function runComputerUseDriver(
  query: string,
  options: ComputerUseOptions,
  mode: 'submit',
  label: string
): Promise<ComputerUseSubmissionResult>;
function runComputerUseDriver(
  query: string,
  options: ComputerUseOptions,
  mode: 'hitl',
  label: string
): Promise<ComputerUseHitlResult>;
async function runComputerUseDriver(
  query: string,
  options: ComputerUseOptions,
  mode: 'submit' | 'hitl',
  label: string
): Promise<ComputerUseSubmissionResult | ComputerUseHitlResult> {
  const env = {
    ...process.env,
    ...options.env,
    ...(options.model ? { MST_COWORK_CUA_MODEL: options.model } : {}),
  };
  if (options.deadlineAt <= Date.now())
    throw new Error(`Computer Use ${label} deadline exceeded; not retrying.`);
  const python = await ensureCoworkPython(env);
  const DRIVER_PATH = resolveDriverPath(env);
  const timeoutMs = options.deadlineAt - Date.now();
  if (timeoutMs <= 0)
    throw new Error(`Computer Use ${label} deadline exceeded; not retrying.`);
  const maxActions = options.maxActions ?? (mode === 'hitl' ? 12 : 24);
  diagnostic(
    `starting Computer Use ${label} (script=${DRIVER_PATH}, maxActions=${maxActions}, timeoutMs=${timeoutMs})`
  );
  let stdout = '';
  let stderr = '';
  try {
    const result = await execFileAsync(
      python,
      [DRIVER_PATH, query, '--max-actions', String(maxActions), '--mode', mode],
      {
        timeout: timeoutMs,
        maxBuffer: 2 * 1024 * 1024,
        env: { ...env, PYTHONUNBUFFERED: '1' },
      }
    );
    stdout = String(result.stdout ?? '');
    stderr = String(result.stderr ?? '');
  } catch (error) {
    const childError = error as { stdout?: string; stderr?: string };
    stdout = String(childError.stdout ?? '');
    stderr = String(childError.stderr ?? '');
    const redact = (text: string): string => {
      for (const [key, value] of Object.entries(env)) {
        if (value && /token|key|secret|password|authorization/i.test(key))
          text = text.split(value).join('[REDACTED]');
      }
      return text;
    };
    const details = [
      formatError(error),
      stdout ? `stdout=${stdout.slice(-1000)}` : '',
      stderr ? `stderr=${stderr.slice(-1000)}` : '',
    ]
      .filter(Boolean)
      .map(redact)
      .join('; ');
    const reported = parseLastJsonLine(stdout);
    if (
      mode === 'hitl' &&
      reported?.status === 'failed' &&
      typeof reported.error === 'string' &&
      /^Computer Use HITL check exceeded \d+ actions after attempting a visible prompt$/.test(
        reported.error
      )
    ) {
      diagnostic(
        'HITL inspection budget reached; native completion remains the success criterion.'
      );
      throw new ComputerUseHitlBudgetError(
        `HITL inspection reached its ${maxActions}-action budget.`
      );
    }
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
