import {
  runAnthropicComputerUseSubmission,
  type ComputerUseSubmissionResult,
} from '../cowork/anthropicComputerUse.js';
import type { ExternalHostConfig } from '../externalHost/types.js';

export { ComputerUseDriverError } from '../cowork/anthropicComputerUse.js';

export type ChatgptSurface = 'chatgpt-work' | 'codex';

export interface ChatgptApplicationController {
  state(): Promise<{ running: boolean }>;
  stop(): Promise<void>;
  start(environment?: Record<string, string>): Promise<void>;
}

/** App-specific options only; the screenshot/action loop is shared with Cowork. */
export function submitChatgptQuery(
  query: string,
  config: ExternalHostConfig,
  deadlineAt: number
): Promise<ComputerUseSubmissionResult> {
  return runAnthropicComputerUseSubmission(query, {
    application: 'chatgpt',
    targetModel: config.model,
    reasoningEffort: config.reasoningEffort,
    model: stringOption(config.options, 'computerUseModel'),
    maxActions: Number(config.options?.computerUseMaxActions ?? 32),
    deadlineAt,
    env: plannerEnvironment(config),
  });
}

function plannerEnvironment(config: ExternalHostConfig): NodeJS.ProcessEnv {
  return {
    ...process.env,
    ...readLaunchEnvironment(config.options?.computerUseEnvironment),
  };
}

export function validateChatgptConfig(config: ExternalHostConfig): void {
  const surface = config.options?.surface ?? 'chatgpt-work';
  if (surface !== 'chatgpt-work' && surface !== 'codex')
    throw new Error('ChatGPT surface must be chatgpt-work or codex.');
  if (
    (config.options?.computerUseProvider ?? 'anthropic-computer-use') !==
    'anthropic-computer-use'
  )
    throw new Error(
      'ChatGPT macOS requires the anthropic-computer-use driver; there is no deterministic UI fallback.'
    );
  if (config.options?.chatgptTrace === 'accessibility')
    throw new Error(
      'ChatGPT requires native transcript evidence, not UI answer extraction.'
    );
  if (!plannerEnvironment(config).ANTHROPIC_API_KEY)
    throw new Error(
      'ANTHROPIC_API_KEY is required for the Computer Use planner.'
    );
  const actions = config.options?.computerUseMaxActions ?? 32;
  if (!Number.isInteger(actions) || Number(actions) < 1 || Number(actions) > 64)
    throw new Error(
      'Computer Use action budget must be an integer from 1 to 64.'
    );
}

export function readLaunchEnvironment(value: unknown): Record<string, string> {
  if (value === undefined) return {};
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.entries(value).some(
      ([key, entry]) =>
        !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || typeof entry !== 'string'
    )
  )
    throw new Error(
      'ChatGPT environment must map environment names to strings.'
    );
  return { ...value } as Record<string, string>;
}

export function stringOption(
  options: Record<string, unknown> | undefined,
  key: string
): string | undefined {
  const value = options?.[key];
  return typeof value === 'string' ? value : undefined;
}
