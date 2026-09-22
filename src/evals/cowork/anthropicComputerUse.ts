import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { ensureCoworkPython } from './pythonRuntime.js';
import { promisify } from 'node:util';
import {
  COMPUTER_USE_TOKEN_FIELDS as TOKEN_FIELDS,
  CoworkDriverError,
  type CoworkDriverOptions,
  type ComputerUseTelemetry,
} from './driver.js';
export type { ComputerUseTelemetry } from './driver.js';

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

export interface ComputerUseOptions extends CoworkDriverOptions {
  /** App-specific instructions; the screenshot/action loop remains shared. */
  application?: 'cowork' | 'chatgpt';
  chatgptSurface?: 'chatgpt-work' | 'codex';
  targetModel?: string;
  reasoningEffort?: string;
}

export class ComputerUseDriverError extends CoworkDriverError {
  constructor(
    message: string,
    public override readonly telemetry?: ComputerUseTelemetry
  ) {
    super(message, telemetry);
  }
}

export interface ComputerUseSubmissionResult {
  status: 'submitted';
  action_count: number;
  model: string;
  submission_action: Record<string, unknown>;
  telemetry?: ComputerUseTelemetry;
}

/** Exhausted inspection is not proof that the native task failed. */
export class ComputerUseHitlBudgetError extends ComputerUseDriverError {
  override name = 'ComputerUseHitlBudgetError';
  override readonly kind = 'hitl-budget-exhausted';
}

export interface ComputerUseHitlResult {
  status: 'hitl_checked';
  action_count: number;
  model: string;
  telemetry?: ComputerUseTelemetry;
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
  try {
    const result = await execFileAsync(
      python,
      [
        DRIVER_PATH,
        query,
        '--max-actions',
        String(maxActions),
        '--mode',
        mode,
        ...(options.application ? ['--app', options.application] : []),
        ...(options.chatgptSurface
          ? ['--surface', options.chatgptSurface]
          : []),
        ...(options.targetModel ? ['--target-model', options.targetModel] : []),
        ...(options.reasoningEffort
          ? ['--reasoning-effort', options.reasoningEffort]
          : []),
      ],
      {
        timeout: timeoutMs,
        maxBuffer: 2 * 1024 * 1024,
        env: { ...env, PYTHONUNBUFFERED: '1' },
      }
    );
    stdout = String(result.stdout ?? '');
  } catch (error) {
    const childError = error as { stdout?: string };
    stdout = String(childError.stdout ?? '');
    // Child-process errors contain argv (the query), and provider errors can
    // contain request content. Never copy raw stdout/stderr or error messages.
    const reported = parseLastJsonLine(stdout);
    const telemetry = parseTelemetry(reported?.telemetry, env, 'partial');
    const blocker =
      typeof reported?.error_code === 'string' &&
      /^(model_unavailable|reasoning_unavailable|sign_in_required|permissions_required|app_unavailable|navigation_blocked|screen_recording_required|accessibility_required|action_budget_exhausted|provider_rate_limit|provider_authentication|provider_request_rejected|provider_unavailable)$/.test(
        reported.error_code
      )
        ? reported.error_code
        : undefined;
    const details =
      (error as { killed?: boolean }).killed === true
        ? 'driver terminated before completion; not retrying'
        : 'driver exited unsuccessfully; not retrying';
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
        `HITL inspection reached its ${maxActions}-action budget.`,
        telemetry
      );
    }
    diagnostic(`Computer Use ${label} failed: ${details}`);
    throw new ComputerUseDriverError(
      `Computer Use ${label} failed: ${details}${blocker ? ` (${blocker})` : ''}`,
      telemetry
    );
  }

  diagnostic(
    `Computer Use ${label} exited successfully (stdoutBytes=${stdout.length})`
  );
  const record = parseLastJsonLine(stdout);
  const expectedStatus = mode === 'submit' ? 'submitted' : 'hitl_checked';
  if (record?.status !== expectedStatus) {
    throw new ComputerUseDriverError(
      `Computer Use ${label} did not reach ${expectedStatus}.`,
      parseTelemetry(record?.telemetry, env, 'partial')
    );
  }
  if (!isCount(record.action_count) || !isSafeModel(record.model, env)) {
    throw new ComputerUseDriverError(
      `Computer Use ${label} returned invalid result fields.`,
      parseTelemetry(record.telemetry, env, 'partial')
    );
  }
  const telemetry = parseTelemetry(record.telemetry, env, 'complete');
  const common = {
    action_count: record.action_count,
    model: record.model,
    ...(telemetry ? { telemetry } : {}),
  };
  diagnostic(
    `Computer Use ${label} completed (actions=${common.action_count})`
  );
  if (mode === 'hitl') return { status: 'hitl_checked', ...common };
  const submission = asRecord(record.submission_action);
  if (submission?.action !== 'key' || submission.text !== 'enter') {
    throw new ComputerUseDriverError(
      'Computer Use submission returned an invalid submission boundary.',
      telemetry ? { ...telemetry, accounting: 'partial' } : undefined
    );
  }
  return {
    status: 'submitted',
    ...common,
    submission_action: { action: 'key', text: 'enter' },
  };
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

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isSafeModel(value: unknown, env: NodeJS.ProcessEnv): value is string {
  return (
    typeof value === 'string' &&
    /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,106}$/.test(value) &&
    !Object.entries(env).some(
      ([key, secret]) =>
        secret &&
        /token|key|secret|password|authorization/i.test(key) &&
        value.includes(secret)
    )
  );
}

/** Invalid telemetry is omitted, never coerced or allowed to change execution. */
function parseTelemetry(
  value: unknown,
  env: NodeJS.ProcessEnv,
  accounting: ComputerUseTelemetry['accounting']
): ComputerUseTelemetry | undefined {
  const record = asRecord(value);
  if (
    !record ||
    (record.accounting !== 'complete' && record.accounting !== 'partial')
  )
    return undefined;
  const counts = [
    'planner_response_count',
    'action_count',
    'attempted_action_count',
    'executed_action_count',
    'refused_action_count',
  ] as const;
  for (const field of counts) if (!isCount(record[field])) return undefined;
  if (
    typeof record.duration_ms !== 'number' ||
    !Number.isFinite(record.duration_ms) ||
    record.duration_ms < 0 ||
    !Array.isArray(record.response_models) ||
    record.response_models.length > (record.planner_response_count as number)
  )
    return undefined;
  const responseModels: string[] = [];
  for (const model of record.response_models) {
    if (
      !isSafeModel(model, env) ||
      !/^claude-[a-z0-9][a-z0-9.-]{0,99}$/.test(model)
    )
      return undefined;
    if (!responseModels.includes(model)) responseModels.push(model);
  }
  const usage = asRecord(record.usage);
  const coverage = asRecord(record.usage_observation_counts);
  if (!usage || !coverage) return undefined;
  const safeUsage: ComputerUseTelemetry['usage'] = {};
  const safeCoverage = {} as ComputerUseTelemetry['usage_observation_counts'];
  for (const field of TOKEN_FIELDS) {
    const count = coverage[field];
    if (!isCount(count) || count > (record.planner_response_count as number))
      return undefined;
    safeCoverage[field] = count;
    if (usage[field] !== undefined) {
      if (!isCount(usage[field]) || count === 0) return undefined;
      safeUsage[field] = usage[field];
    } else if (count !== 0) return undefined;
  }
  const actions = record.action_count as number;
  const attempted = record.attempted_action_count as number;
  const executed = record.executed_action_count as number;
  const refused = record.refused_action_count as number;
  if (
    attempted > actions ||
    executed > attempted ||
    refused > actions - attempted
  )
    return undefined;
  return {
    accounting: accounting === 'partial' ? 'partial' : record.accounting,
    response_models: responseModels,
    planner_response_count: record.planner_response_count as number,
    usage: safeUsage,
    usage_observation_counts: safeCoverage,
    duration_ms: record.duration_ms,
    action_count: actions,
    attempted_action_count: attempted,
    executed_action_count: executed,
    refused_action_count: refused,
    cost: { status: 'unavailable' },
  };
}
