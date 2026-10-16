import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, onTestFinished } from 'vitest';
import {
  ComputerUseDriverError,
  ComputerUseHitlBudgetError,
  runAnthropicComputerUseHitl,
  runAnthropicComputerUseReset,
  runAnthropicComputerUseSubmission,
  setComputerUseRuntime,
} from './anthropicComputerUse.js';
import {
  DesktopBlockedError,
  type ComputerUseDesktop,
  type DesktopAction,
  type PlannerRequest,
  type PlannerResponse,
} from './computerUseLoop.js';

/** Offline: a fake desktop and planner stand in for the Mac and the API. */

const IMAGE = {
  type: 'image',
  source: { type: 'base64', media_type: 'image/png', data: 'x' },
} as const;
const FILL = { type: 'tool_use', id: '1', name: 'fill_query', input: {} };
const ENTER = {
  type: 'tool_use',
  id: '2',
  name: 'computer',
  input: { action: 'key', text: 'Return' },
};

interface Fake {
  requests: PlannerRequest[];
  launches: Array<[string, boolean]>;
  executed: DesktopAction[];
  envs: NodeJS.ProcessEnv[];
  urls: string[];
  newChats: number;
}

function useRuntime(
  reply: (
    request: PlannerRequest,
    signal: AbortSignal
  ) => Promise<PlannerResponse>,
  overrides: Partial<ComputerUseDesktop> = {}
): Fake {
  const fake: Fake = {
    requests: [],
    launches: [],
    executed: [],
    envs: [],
    urls: [],
    newChats: 0,
  };
  const desktop: ComputerUseDesktop = {
    checkPermissions: async () => undefined,
    async launch(app, required) {
      fake.launches.push([app, required]);
    },
    async openUrl(url) {
      fake.urls.push(url);
    },
    async newChatgptChat() {
      fake.newChats += 1;
      return true;
    },
    screenshot: async () => ({ ...IMAGE, source: { ...IMAGE.source } }),
    frontmostApp: async () => 'Claude',
    async execute(action) {
      fake.executed.push(action);
      if (action.action === 'screenshot')
        return {
          result: { ...IMAGE, source: { ...IMAGE.source } },
          submitted: false,
        };
      return {
        result: 'done',
        submitted: action.action === 'key' && action.text === 'Return',
      };
    },
    ...overrides,
  };
  onTestFinished(
    setComputerUseRuntime({
      desktop: () => desktop,
      planner: (env) => {
        fake.envs.push(env);
        return {
          prepare: async () => undefined,
          async create(request, signal) {
            fake.requests.push(request);
            return reply(request, signal);
          },
        };
      },
    })
  );
  return fake;
}

const submits = async (): Promise<PlannerResponse> => ({
  model: 'claude-sonnet-4-6',
  usage: { input_tokens: 10 },
  content: [FILL, ENTER],
});
const options = (extra: Record<string, unknown> = {}) => ({
  deadlineAt: Date.now() + 10_000,
  env: { MST_COWORK_CUA_START_DELAY: '0' },
  ...extra,
});

afterEach(() => {
  delete process.env.MST_COWORK_CUA_MODEL;
});

it.each(['chatgpt', 'cowork'] as const)(
  'gives %s its target selection separately from the planner model',
  async (application) => {
    const targetModel =
      application === 'cowork' ? 'claude-opus-4-6' : 'gpt-test';
    const appName = application === 'cowork' ? 'Claude' : 'ChatGPT';
    const fake = useRuntime(
      async (request) =>
        application === 'cowork'
          ? {
              content: [
                {
                  type: 'tool_use',
                  id: '0',
                  name: 'confirm_model',
                  input: { model: targetModel },
                },
                FILL,
                ENTER,
              ],
            }
          : request.messages.length === 1
            ? {
                content: [
                  FILL,
                  {
                    type: 'tool_use',
                    id: '3',
                    name: 'computer',
                    input: { action: 'screenshot' },
                  },
                ],
              }
            : { content: [ENTER] },
      { frontmostApp: async () => appName }
    );
    const result = await runAnthropicComputerUseSubmission(
      'query',
      options({
        application,
        targetModel,
        reasoningEffort: 'medium',
        model: 'claude-sonnet-4-6',
      })
    );
    expect(result).toMatchObject({
      status: 'submitted',
      model: 'claude-sonnet-4-6',
      submission_action: { action: 'key', text: 'enter' },
    });
    expect(fake.requests[0]!.model).toBe('claude-sonnet-4-6');
    const instruction = (
      fake.requests[0]!.messages[0]!.content as Array<{ text?: string }>
    )[0]!.text!;
    expect(instruction).toContain(targetModel);
  }
);

it('launches the session bundle path', async () => {
  const fake = useRuntime(submits);
  await runAnthropicComputerUseSubmission(
    'query',
    options({ appPath: '/private/tmp/mst-test/Claude.app' })
  );
  expect(fake.launches[0]).toEqual(['/private/tmp/mst-test/Claude.app', true]);
});

it('prefers an explicit planner model to the environment default', async () => {
  process.env.MST_COWORK_CUA_MODEL = 'environment-planner';
  const fake = useRuntime(submits);
  await runAnthropicComputerUseSubmission(
    'query',
    options({ model: 'explicit-planner' })
  );
  expect(fake.requests[0]!.model).toBe('explicit-planner');
  await runAnthropicComputerUseSubmission('query', options());
  expect(fake.requests.at(-1)!.model).toBe('environment-planner');
});

it('resolves the planner from the caller environment', async () => {
  const fake = useRuntime(submits);
  await runAnthropicComputerUseSubmission(
    'query',
    options({
      env: {
        MST_COWORK_CUA_START_DELAY: '0',
        ANTHROPIC_BASE_URL: 'https://gw.test',
      },
    })
  );
  expect(fake.envs[0]!.ANTHROPIC_BASE_URL).toBe('https://gw.test');
});

it.each([
  [
    'a blocker',
    () => new DesktopBlockedError('model_unavailable'),
    '(model_unavailable)',
  ],
  [
    'a provider message',
    () => new Error('private-api-key in a provider reply'),
    undefined,
  ],
])('reports %s as a code, never as text', async (_name, error, code) => {
  useRuntime(async () => {
    throw error();
  });
  const failure = await runAnthropicComputerUseSubmission(
    'private query',
    options()
  ).catch((e: unknown) => e);
  expect(failure).toBeInstanceOf(ComputerUseDriverError);
  const message = (failure as Error).message;
  expect(message).toMatch(
    /^Computer Use submission failed: stopped before completion; not retrying/
  );
  if (code) expect(message).toContain(code);
  expect(message).not.toContain('private');
  expect((failure as ComputerUseDriverError).telemetry?.accounting).toBe(
    'partial'
  );
});

it('checks the deadline before starting', async () => {
  const fake = useRuntime(submits);
  await expect(
    runAnthropicComputerUseSubmission('query', { deadlineAt: Date.now() - 1 })
  ).rejects.toThrow('submission deadline exceeded; not retrying');
  expect(fake.requests).toEqual([]);
  expect(fake.launches).toEqual([]);
});

it('stops at the deadline with partial telemetry', async () => {
  useRuntime(
    (_request, signal) =>
      new Promise((_, reject) =>
        signal.addEventListener('abort', () => reject(signal.reason as Error))
      )
  );
  const failure = await runAnthropicComputerUseSubmission(
    'query',
    options({ deadlineAt: Date.now() + 100 })
  ).catch((e: unknown) => e);
  expect((failure as Error).message).toBe(
    'Computer Use submission failed: deadline reached before completion; not retrying'
  );
  expect((failure as ComputerUseDriverError).telemetry).toMatchObject({
    accounting: 'partial',
    planner_response_count: 0,
  });
});

it('reports an exhausted HITL inspection as its own kind', async () => {
  useRuntime(async () => ({
    content: [
      {
        type: 'tool_use',
        id: '1',
        name: 'computer',
        input: { action: 'left_click', coordinate: [1, 1] },
      },
    ],
  }));
  const failure = await runAnthropicComputerUseHitl(
    options({ maxActions: 1 })
  ).catch((e: unknown) => e);
  expect(failure).toBeInstanceOf(ComputerUseHitlBudgetError);
  expect((failure as ComputerUseHitlBudgetError).kind).toBe(
    'hitl-budget-exhausted'
  );
  expect((failure as Error).message).toBe(
    'HITL inspection reached its 1-action budget.'
  );
});

it('resets with a budget of eight', async () => {
  // A planner that never concludes the app is idle uses the whole budget.
  const fake = useRuntime(async () => ({
    content: [
      {
        type: 'tool_use',
        id: '1',
        name: 'computer',
        input: { action: 'left_click', coordinate: [1, 1] },
      },
    ],
  }));
  const failure = await runAnthropicComputerUseReset(options()).catch(
    (e: unknown) => e
  );
  expect(failure).toBeInstanceOf(ComputerUseDriverError);
  expect(fake.executed).toHaveLength(8);
  expect((failure as ComputerUseDriverError).telemetry?.action_count).toBe(8);
});

it('opens a Codex task in the workspace the caller gives', async () => {
  const fake = useRuntime(
    async (request) =>
      request.messages.length === 1
        ? {
            content: [
              FILL,
              {
                type: 'tool_use',
                id: '3',
                name: 'computer',
                input: { action: 'screenshot' },
              },
            ],
          }
        : { content: [ENTER] },
    { frontmostApp: async () => 'ChatGPT' }
  );
  await runAnthropicComputerUseSubmission(
    'query',
    options({
      application: 'chatgpt',
      chatgptSurface: 'codex',
      workspace: '/private/tmp/mst workspace',
    })
  );
  expect(fake.urls).toEqual([
    'codex://new?path=%2Fprivate%2Ftmp%2Fmst%20workspace',
  ]);
  expect(fake.newChats).toBe(0);
});

it('reports reset_done when nothing is running', async () => {
  const fake = useRuntime(async () => ({ content: [] }));
  const result = await runAnthropicComputerUseReset(options());
  expect(result).toMatchObject({ status: 'reset_done', action_count: 0 });
  expect(fake.requests[0]!.messages[0]!.content).toEqual(
    expect.arrayContaining([expect.objectContaining({ type: 'text' })])
  );
  const text = (
    fake.requests[0]!.messages[0]!.content as Array<{ text?: string }>
  )[0]!.text!;
  expect(text).toContain('Inspect the visible Claude Desktop Cowork window');
});

it('writes action names to MST_COWORK_CUA_LOG_FILE, never the query', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'cu-log-'));
  onTestFinished(() => rm(directory, { recursive: true, force: true }));
  const file = join(directory, 'driver.log');
  useRuntime(submits);
  await runAnthropicComputerUseSubmission(
    'private query',
    options({
      env: { MST_COWORK_CUA_START_DELAY: '0', MST_COWORK_CUA_LOG_FILE: file },
    })
  );
  const log = await readFile(file, 'utf8');
  expect(log).toContain('executing action 1: type');
  expect(log).toContain('submission boundary reached');
  expect(log).not.toContain('private query');
});
