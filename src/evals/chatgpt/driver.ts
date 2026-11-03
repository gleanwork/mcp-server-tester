import { hasLLMCredential } from '../../llm/endpoint.js';
import {
  runAnthropicComputerUseSubmission,
  type ComputerUseSubmissionResult,
} from '../cowork/anthropicComputerUse.js';
import type { ExternalClientConfig } from '../externalClient/types.js';
import { normalizeClientDriver } from '../externalClient/driverIdentity.js';
import { CHATGPT_MAX_ACTIONS } from './maxActions.js';

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
  config: ExternalClientConfig,
  deadlineAt: number,
  /** macOS: the trusted empty folder the task opens in. */
  workspace?: string
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
    maxActions: chatgptMaxActions(config),
    deadlineAt,
    env: plannerEnvironment(config),
    ...(workspace ? { workspace } : {}),
  });
}

export function chatgptSurface(config: ExternalClientConfig): ChatgptSurface {
  const surface = config.options?.surface ?? 'chatgpt-work';
  if (surface !== 'chatgpt-work' && surface !== 'codex')
    throw new Error('ChatGPT surface must be chatgpt-work or codex.');
  return surface;
}

/**
 * The action budget (`maxActions`) of the driver's OS: Computer Use's on
 * macOS, the accessibility automation's on Linux, each with its own range
 * and default (`CHATGPT_MAX_ACTIONS`).
 */
export function chatgptMaxActions(config: ExternalClientConfig): number {
  const linux = isLinuxChatgpt(config);
  const budget = CHATGPT_MAX_ACTIONS[linux ? 'linux' : 'darwin'];
  const actions = Number(config.options?.maxActions ?? budget.default);
  if (!Number.isInteger(actions) || actions < 1 || actions > budget.max)
    throw new Error(
      `${linux ? 'Native' : 'Computer Use'} action budget must be an integer from 1 to ${budget.max}.`
    );
  return actions;
}

export function isLinuxChatgpt(config: ExternalClientConfig): boolean {
  return normalizeClientDriver(config.driver).platform === 'linux';
}

export function chatgptDesktopEnvironment(
  config: ExternalClientConfig
): NodeJS.ProcessEnv {
  return {
    ...process.env,
    ...readLaunchEnvironment(config.options?.desktopEnvironment),
  };
}

function plannerEnvironment(config: ExternalClientConfig): NodeJS.ProcessEnv {
  return {
    ...process.env,
    ...readLaunchEnvironment(config.options?.computerUseEnvironment),
  };
}

export function validateChatgptConfig(config: ExternalClientConfig): void {
  chatgptSurface(config);
  if (config.options?.chatgptTrace === 'accessibility')
    throw new Error(
      'ChatGPT requires native transcript evidence, not UI answer extraction.'
    );
  if (isLinuxChatgpt(config)) {
    if (config.options?.computerUseModel !== undefined)
      throw new Error(
        'Linux ChatGPT uses native AT-SPI, not a Computer Use planner.'
      );
    chatgptMaxActions(config);
    return;
  }
  if (!hasLLMCredential('anthropic', { env: plannerEnvironment(config) }))
    throw new Error(
      'The Computer Use planner needs ANTHROPIC_API_KEY, or ANTHROPIC_BASE_URL with MST_LLM_AUTH_COMMAND or ANTHROPIC_AUTH_TOKEN for an LLM gateway.'
    );
  chatgptMaxActions(config);
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
