import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ComputerUseDriverError,
  readLaunchEnvironment,
  submitChatgptQuery,
  validateChatgptConfig,
} from './driver.js';
import { runAnthropicComputerUseSubmission } from '../cowork/anthropicComputerUse.js';
import type * as ComputerUseModule from '../cowork/anthropicComputerUse.js';
import type { ExternalHostConfig } from '../externalHost/types.js';

vi.mock('../cowork/anthropicComputerUse.js', async (original) => ({
  ...(await original<typeof ComputerUseModule>()),
  runAnthropicComputerUseSubmission: vi.fn(),
}));

const config: ExternalHostConfig = {
  driver: 'openai.chatgpt.agent.desktop-app.macos',
  model: 'test-chatgpt-model',
  reasoningEffort: 'medium',
};

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv('ANTHROPIC_API_KEY', 'test-planner-key');
});
afterEach(() => vi.unstubAllEnvs());

describe('ChatGPT shared Computer Use adapter', () => {
  it('forwards the exact query, native model, planner options and deadline once', async () => {
    const receipt = {
      status: 'submitted' as const,
      action_count: 2,
      model: 'test-planner-model',
      submission_action: { action: 'key', text: 'Return' },
    };
    vi.mocked(runAnthropicComputerUseSubmission).mockResolvedValue(receipt);
    const query = '  Query with Unicode π\n\nand trailing whitespace.  \n';
    const result = await submitChatgptQuery(
      query,
      {
        ...config,
        options: {
          computerUseModel: 'test-planner-model',
          computerUseMaxActions: 17,
          computerUseEnvironment: { ANTHROPIC_API_KEY: 'test-override-key' },
          environment: { MST_TEST_LAUNCH_ONLY: 'app-only' },
        },
      },
      12345
    );
    expect(result).toBe(receipt);
    expect(runAnthropicComputerUseSubmission).toHaveBeenCalledTimes(1);
    expect(runAnthropicComputerUseSubmission).toHaveBeenCalledWith(query, {
      application: 'chatgpt',
      targetModel: 'test-chatgpt-model',
      reasoningEffort: 'medium',
      model: 'test-planner-model',
      maxActions: 17,
      deadlineAt: 12345,
      env: { ...process.env, ANTHROPIC_API_KEY: 'test-override-key' },
    });
    expect(
      vi.mocked(runAnthropicComputerUseSubmission).mock.calls[0]![1].env
    ).not.toHaveProperty('MST_TEST_LAUNCH_ONLY');
  });

  it('preserves the default action budget and does not retry a driver failure', async () => {
    const error = new ComputerUseDriverError('uncertain submission');
    vi.mocked(runAnthropicComputerUseSubmission).mockRejectedValue(error);
    await expect(submitChatgptQuery('query', config, 123)).rejects.toBe(error);
    expect(runAnthropicComputerUseSubmission).toHaveBeenCalledTimes(1);
    expect(
      vi.mocked(runAnthropicComputerUseSubmission).mock.calls[0]![1]
    ).toMatchObject({
      application: 'chatgpt',
      maxActions: 32,
      deadlineAt: 123,
    });
  });

  it('keeps preflight validation separate from submission and rejects unsupported modes', () => {
    expect(() => validateChatgptConfig(config)).not.toThrow();
    expect(() =>
      validateChatgptConfig({
        ...config,
        options: { computerUseProvider: 'linux-desktop' },
      })
    ).toThrow('macOS requires');
    expect(() =>
      validateChatgptConfig({
        ...config,
        options: { chatgptTrace: 'accessibility' },
      })
    ).toThrow('native transcript');
    expect(() =>
      validateChatgptConfig({
        ...config,
        options: { computerUseMaxActions: 0 },
      })
    ).toThrow('action budget');
    vi.stubEnv('ANTHROPIC_API_KEY', '');
    expect(() => validateChatgptConfig(config)).toThrow('ANTHROPIC_API_KEY');
    expect(runAnthropicComputerUseSubmission).not.toHaveBeenCalled();
  });

  it.each([null, [], { 'bad-name': 'value' }, { TOKEN: 1 }])(
    'rejects malformed environment maps without changing them: %j',
    (environment) => {
      expect(() => readLaunchEnvironment(environment)).toThrow(
        'environment must map'
      );
    }
  );

  it('copies valid environment maps and treats missing maps as empty', () => {
    const environment = { TEST_VALUE: 'value' };
    expect(readLaunchEnvironment(undefined)).toEqual({});
    expect(readLaunchEnvironment(environment)).toEqual(environment);
    expect(readLaunchEnvironment(environment)).not.toBe(environment);
  });
});
