import { appendFileSync } from 'node:fs';
import {
  CoworkDriverError,
  type CoworkDriverOptions,
  type ComputerUseTelemetry,
} from './driver.js';
import {
  ComputerUseLoopError,
  DEFAULT_COMPUTER_USE_MODEL,
  runComputerUseLoop,
  secretValues,
  type BlockerCode,
  type ComputerUseDesktop,
  type ComputerUseMode,
  type ComputerUsePlanner,
  type ProviderCode,
} from './computerUseLoop.js';
import { infrastructureEnding } from '../trialEnding.js';
import type {
  InfrastructureBreak,
  TrialEnding,
} from '../../types/trialEnding.js';
import {
  abortableSleep,
  anthropicComputerUsePlanner,
} from './computerUsePlanner.js';
import { macComputerUseDesktop } from './macDesktop.js';
export type { ComputerUseTelemetry } from './driver.js';

/**
 * Computer Use for desktop clients on macOS (Cowork, and ChatGPT's macOS app):
 * submit a query, resolve a visible tool approval, or reset the app. The loop
 * runs in this process (computerUseLoop.ts); its planner calls go through
 * `resolveLLMEndpoint()` (computerUsePlanner.ts) and its input through a
 * Swift helper (macDesktop.ts).
 */

export interface ComputerUseOptions extends CoworkDriverOptions {
  /** App-specific instructions; the screenshot/action loop remains shared. */
  application?: 'cowork' | 'chatgpt';
  chatgptSurface?: 'chatgpt-work' | 'codex';
  reasoningEffort?: string;
  /** ChatGPT Codex: the empty, trusted folder a fresh draft opens in. */
  workspace?: string;
}

export class ComputerUseDriverError extends CoworkDriverError {
  constructor(
    message: string,
    public override readonly telemetry?: ComputerUseTelemetry,
    /** What the loop typed when it stopped: a blocker or provider code, and whether the deadline aborted it. */
    readonly stop?: {
      code: BlockerCode | ProviderCode | undefined;
      aborted: boolean;
    }
  ) {
    super(message, telemetry);
  }
}

/** What broke when Computer Use stopped on a typed code, and whether a retry can help. */
const COMPUTER_USE_BREAKS: Record<
  BlockerCode | ProviderCode,
  [InfrastructureBreak, boolean]
> = {
  provider_rate_limit: ['provider', true],
  provider_unavailable: ['provider', true],
  provider_authentication: ['setup', false],
  provider_request_rejected: ['setup', false],
  model_unavailable: ['setup', false],
  reasoning_unavailable: ['setup', false],
  sign_in_required: ['setup', false],
  permissions_required: ['setup', false],
  screen_recording_required: ['setup', false],
  accessibility_required: ['setup', false],
  app_unavailable: ['client-app', true],
  navigation_blocked: ['client-app', true],
  action_budget_exhausted: ['client-app', true],
};

/**
 * How an attempt ended when Computer Use couldn't drive the app (ADR 0010),
 * from what its loop typed: the planner's provider, a setting or permission
 * the desktop needs, or MST's deadline. Any other error is the client app's.
 */
export function computerUseEnding(error: unknown, reason: string): TrialEnding {
  const stop = error instanceof ComputerUseDriverError ? error.stop : undefined;
  if (stop?.aborted) return infrastructureEnding('deadline', reason);
  const [broke, retryable] = stop?.code
    ? COMPUTER_USE_BREAKS[stop.code]
    : (['client-app', true] as const);
  return infrastructureEnding(broke, reason, retryable);
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

/** What a reset run reports: the app has no task running and no prompt open. */
export interface ComputerUseResetResult {
  status: 'reset_done';
  action_count: number;
  model: string;
  telemetry?: ComputerUseTelemetry;
}

/** Test seam: the real Mac and planner unless a test replaces them. */
export interface ComputerUseRuntime {
  desktop(): ComputerUseDesktop;
  planner(env: NodeJS.ProcessEnv): ComputerUsePlanner;
  /** The loop's waits. Defaults to real, abortable timers. */
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}

const macRuntime: ComputerUseRuntime = {
  desktop: () =>
    macComputerUseDesktop({
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    }),
  planner: (env) => anthropicComputerUsePlanner({ env }),
};
let runtime = macRuntime;

/** Replaces the desktop and planner, for tests. Returns a function that restores them. */
export function setComputerUseRuntime(next: ComputerUseRuntime): () => void {
  runtime = next;
  return () => {
    runtime = macRuntime;
  };
}

export async function runAnthropicComputerUseSubmission(
  query: string,
  options: ComputerUseOptions
): Promise<ComputerUseSubmissionResult> {
  return runComputerUseDriver(query, options, 'submit', 'submission');
}

/**
 * After a failed case, stop a still-running task and decline any open
 * permission prompt, so the next case's fresh task is independent. Never
 * types or submits.
 */
export async function runAnthropicComputerUseReset(
  options: ComputerUseOptions
): Promise<ComputerUseResetResult> {
  return runComputerUseDriver(
    'Leave Cowork with no task running and no prompt open.',
    { ...options, maxActions: options.maxActions ?? 8 },
    'reset',
    'reset'
  );
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
function runComputerUseDriver(
  query: string,
  options: ComputerUseOptions,
  mode: 'reset',
  label: string
): Promise<ComputerUseResetResult>;
async function runComputerUseDriver(
  query: string,
  options: ComputerUseOptions,
  mode: ComputerUseMode,
  label: string
): Promise<
  ComputerUseSubmissionResult | ComputerUseHitlResult | ComputerUseResetResult
> {
  if (options.deadlineAt <= Date.now())
    throw new ComputerUseDriverError(
      `Computer Use ${label} deadline exceeded; not retrying.`,
      undefined,
      { code: undefined, aborted: true }
    );
  const env: NodeJS.ProcessEnv = { ...process.env, ...options.env };
  const maxActions = options.maxActions ?? (mode === 'hitl' ? 12 : 24);
  const timeoutMs = options.deadlineAt - Date.now();
  const startDelay = Number(env.MST_COWORK_CUA_START_DELAY ?? 3);
  diagnostic(
    `starting Computer Use ${label} (maxActions=${maxActions}, timeoutMs=${timeoutMs})`
  );
  const deadline = new AbortController();
  const timer = setTimeout(
    () => deadline.abort(new Error(`Computer Use ${label} deadline reached`)),
    timeoutMs
  );
  const log = fileLog(env.MST_COWORK_CUA_LOG_FILE);
  try {
    const outcome = await runComputerUseLoop(
      {
        query,
        maxActions,
        mode,
        application: options.application ?? 'cowork',
        chatgptSurface: options.chatgptSurface ?? 'chatgpt-work',
        ...(options.targetModel ? { targetModel: options.targetModel } : {}),
        ...(options.reasoningEffort
          ? { reasoningEffort: options.reasoningEffort }
          : {}),
        model:
          options.model ??
          env.MST_COWORK_CUA_MODEL ??
          DEFAULT_COMPUTER_USE_MODEL,
        ...(options.appPath ? { appPath: options.appPath } : {}),
        approveWriteTools: options.approveWriteTools === true,
        ...(options.workspace ? { workspace: options.workspace } : {}),
        startDelayMs:
          Number.isFinite(startDelay) && startDelay >= 0
            ? startDelay * 1000
            : 3000,
        secrets: secretValues(env),
      },
      {
        desktop: runtime.desktop(),
        planner: runtime.planner(env),
        sleep: runtime.sleep ?? abortableSleep,
        log,
        signal: deadline.signal,
      }
    );
    diagnostic(
      `Computer Use ${label} completed (actions=${outcome.action_count})`
    );
    const common = {
      action_count: outcome.action_count,
      model: outcome.model,
      telemetry: outcome.telemetry,
    };
    if (outcome.status === 'hitl_checked')
      return { status: 'hitl_checked', ...common };
    if (outcome.status === 'reset_done')
      return { status: 'reset_done', ...common };
    return {
      status: 'submitted',
      ...common,
      submission_action: { action: 'key', text: 'enter' },
    };
  } catch (error) {
    if (!(error instanceof ComputerUseLoopError)) throw error;
    // The loop's own messages hold action and app names only; provider and
    // process details stay out of results, which reach reports.
    log(`driver failed: ${error.message}`);
    if (mode === 'hitl' && error.hitlBudget) {
      diagnostic(
        'HITL inspection budget reached; native completion remains the success criterion.'
      );
      throw new ComputerUseHitlBudgetError(
        `HITL inspection reached its ${maxActions}-action budget.`,
        error.telemetry
      );
    }
    const details = error.aborted
      ? 'deadline reached before completion; not retrying'
      : 'stopped before completion; not retrying';
    diagnostic(`Computer Use ${label} failed: ${details}`);
    throw new ComputerUseDriverError(
      `Computer Use ${label} failed: ${details}${error.code ? ` (${error.code})` : ''}`,
      error.telemetry,
      { code: error.code, aborted: error.aborted }
    );
  } finally {
    clearTimeout(timer);
  }
}

function diagnostic(message: string): void {
  process.stderr.write(`[mst:cowork-cu] ${message}\n`);
}

/**
 * The loop's step-by-step log (action and app names, never query text), kept
 * only when `MST_COWORK_CUA_LOG_FILE` names a file.
 */
function fileLog(path: string | undefined): (message: string) => void {
  return (message) => {
    if (!path) return;
    try {
      appendFileSync(path, `${new Date().toISOString()} ${message}\n`);
    } catch {
      // Diagnosis only: a log that can't be written never fails a case.
    }
  };
}
