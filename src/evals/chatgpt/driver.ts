import {
  runAnthropicComputerUseSubmission,
  type ComputerUseSubmissionResult,
} from '../cowork/anthropicComputerUse.js';
import type { ExternalHostConfig } from '../externalHost/types.js';
import { normalizeHostDriver } from '../externalHost/driverIdentity.js';
import { NATIVE_MAX_ACTIONS } from './linuxContract.js';

export { ComputerUseDriverError } from '../cowork/anthropicComputerUse.js';

export type ChatgptSurface = 'chatgpt-work' | 'codex';

export interface ChatgptApplicationController {
  state(): Promise<{ running: boolean }>;
  stop(): Promise<void>;
  start(environment?: Record<string, string>): Promise<void>;
  /** Linux only: hand a draft to the running app. Never sends. */
  openPrompt?(prompt: string): Promise<void>;
}

/** App-specific options only; the screenshot/action loop is shared with Cowork. */
export function submitChatgptQuery(
  query: string,
  config: ExternalHostConfig,
  deadlineAt: number
): Promise<ComputerUseSubmissionResult> {
  if (isLinuxChatgpt(config))
    throw new Error(
      'Linux ChatGPT requires the native AT-SPI submission path.'
    );
  return runAnthropicComputerUseSubmission(query, {
    application: 'chatgpt',
    chatgptSurface: chatgptSurface(config),
    targetModel: config.model,
    reasoningEffort: config.reasoningEffort,
    model: stringOption(config.options, 'computerUseModel'),
    maxActions: Number(config.options?.computerUseMaxActions ?? 32),
    deadlineAt,
    env: plannerEnvironment(config),
  });
}

export function chatgptSurface(config: ExternalHostConfig): ChatgptSurface {
  const surface = config.options?.surface ?? 'chatgpt-work';
  if (surface !== 'chatgpt-work' && surface !== 'codex')
    throw new Error('ChatGPT surface must be chatgpt-work or codex.');
  return surface;
}

/** The only validation of the Linux native action budget. */
export function nativeMaxActions(config: ExternalHostConfig): number {
  const actions = Number(
    config.options?.nativeMaxActions ?? NATIVE_MAX_ACTIONS.default
  );
  if (
    !Number.isInteger(actions) ||
    actions < 1 ||
    actions > NATIVE_MAX_ACTIONS.max
  )
    throw new Error(
      `Native action budget must be an integer from 1 to ${NATIVE_MAX_ACTIONS.max}.`
    );
  return actions;
}

export function isLinuxChatgpt(config: ExternalHostConfig): boolean {
  return normalizeHostDriver(config.driver).platform === 'linux';
}

export function chatgptDesktopEnvironment(
  config: ExternalHostConfig
): NodeJS.ProcessEnv {
  return {
    ...process.env,
    ...readLaunchEnvironment(config.options?.desktopEnvironment),
  };
}

function plannerEnvironment(config: ExternalHostConfig): NodeJS.ProcessEnv {
  return {
    ...process.env,
    ...readLaunchEnvironment(config.options?.computerUseEnvironment),
  };
}

export function validateChatgptConfig(config: ExternalHostConfig): void {
  chatgptSurface(config);
  if (config.options?.chatgptTrace === 'accessibility')
    throw new Error(
      'ChatGPT requires native transcript evidence, not UI answer extraction.'
    );
  if (isLinuxChatgpt(config)) {
    if (
      config.options?.computerUseProvider !== undefined ||
      config.options?.computerUseModel !== undefined ||
      config.options?.computerUseMaxActions !== undefined
    )
      throw new Error(
        'Linux ChatGPT uses native AT-SPI, not a Computer Use planner.'
      );
    nativeMaxActions(config);
    return;
  }
  if (
    (config.options?.computerUseProvider ?? 'anthropic-computer-use') !==
    'anthropic-computer-use'
  )
    throw new Error(
      'ChatGPT macOS requires the anthropic-computer-use driver; there is no deterministic UI fallback.'
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
