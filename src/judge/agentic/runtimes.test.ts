import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import { commandTool } from './commands.js';
import { insideWorkspace, workspacePermission } from './claudeRuntime.js';
import { runtimeEnv } from './runtime.js';

const codexCalls: {
  options?: Record<string, unknown>;
  thread?: Record<string, unknown>;
  input?: string;
} = {};
vi.mock('@openai/codex-sdk', () => ({
  Codex: class {
    constructor(options: Record<string, unknown>) {
      codexCalls.options = options;
    }
    startThread(thread: Record<string, unknown>) {
      codexCalls.thread = thread;
      return {
        run: async (input: string) => {
          codexCalls.input = input;
          return {
            items: [
              {
                type: 'command_execution',
                command: 'python3 scripts/t.py overview',
                aggregated_output: 'ok',
                exit_code: 0,
              },
              { type: 'agent_message', text: '{"score":7}' },
            ],
            finalResponse: '{"score":7}',
            usage: {
              input_tokens: 100,
              cached_input_tokens: 40,
              output_tokens: 20,
              reasoning_output_tokens: 5,
            },
          };
        },
      };
    }
  },
}));

const claudeCalls: { options?: Record<string, unknown> } = {};
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: ({ options }: { options: Record<string, unknown> }) => {
    claudeCalls.options = options;
    return (async function* () {
      yield {
        type: 'assistant',
        message: {
          content: [
            {
              type: 'tool_use',
              id: 't1',
              name: 'Read',
              input: { file_path: 'case.json' },
            },
          ],
        },
      };
      yield {
        type: 'user',
        message: {
          content: [{ type: 'tool_result', tool_use_id: 't1', content: '{}' }],
        },
      };
      yield {
        type: 'result',
        subtype: 'success',
        result: '{"score":6}',
        structured_output: { score: 6 },
        usage: { input_tokens: 50, output_tokens: 10 },
        total_cost_usd: 0.01,
        duration_ms: 5,
        num_turns: 2,
      };
    })();
  },
  createSdkMcpServer: (o: unknown) => o,
  tool: (name: string) => ({ name }),
}));

let root: string;
let outside: string;
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'mst-ws-test-'));
  outside = await mkdtemp(join(tmpdir(), 'mst-outside-'));
  await mkdir(join(root, 'trace'));
  await writeFile(join(root, 'trace/events.json'), '[]');
  await writeFile(join(outside, 'secret.txt'), 'secret');
  await symlink(join(outside, 'secret.txt'), join(root, 'link.txt'));
});
afterAll(async () => {
  await rm(root, { recursive: true, force: true });
  await rm(outside, { recursive: true, force: true });
});
/** No endpoint or credential from the machine running the tests. */
function clearLLMEnv() {
  for (const name of [
    'ANTHROPIC_API_KEY',
    'ANTHROPIC_AUTH_TOKEN',
    'ANTHROPIC_BASE_URL',
    'OPENAI_API_KEY',
    'OPENAI_BASE_URL',
    'CODEX_API_KEY',
    'MST_LLM_AUTH_COMMAND',
  ])
    vi.stubEnv(name, '');
}
afterEach(() => vi.unstubAllEnvs());

describe('Claude workspace permission', () => {
  it('allows read tools inside the workspace only', async () => {
    const allow = workspacePermission(root, new Set(['mcp__judge__trace']));
    expect(
      (await allow('Read', { file_path: join(root, 'trace/events.json') }))
        .behavior
    ).toBe('allow');
    expect(
      (await allow('Read', { file_path: 'trace/events.json' })).behavior
    ).toBe('allow');
    expect((await allow('Grep', { pattern: 'x' })).behavior).toBe('allow');
    expect(
      (await allow('Glob', { pattern: '**/*', path: root })).behavior
    ).toBe('allow');
    expect(
      (await allow('mcp__judge__trace', { args: ['overview'] })).behavior
    ).toBe('allow');
  });

  it('denies paths outside, symlinks out, and every other tool', async () => {
    const allow = workspacePermission(root, new Set());
    expect((await allow('Read', { file_path: '/etc/passwd' })).behavior).toBe(
      'deny'
    );
    expect((await allow('Read', { file_path: '../x' })).behavior).toBe('deny');
    expect(
      (await allow('Grep', { pattern: 'x', path: outside })).behavior
    ).toBe('deny');
    expect(
      (await allow('Read', { file_path: join(root, 'link.txt') })).behavior
    ).toBe('deny');
    for (const tool of [
      'Bash',
      'Write',
      'Edit',
      'WebFetch',
      'WebSearch',
      'Task',
      'mcp__other__x',
    ])
      expect((await allow(tool, {})).behavior).toBe('deny');
  });

  it('insideWorkspace treats prefixes correctly', () => {
    expect(insideWorkspace('/a/b', '/a/b')).toBe(true);
    expect(insideWorkspace('/a/b', '/a/bc')).toBe(false);
    expect(insideWorkspace('/a/b', 'c/../../b2')).toBe(false);
  });
});

describe('runtimeEnv', () => {
  it('passes only the named variables', () => {
    vi.stubEnv('OPENAI_API_KEY', 'sk-test');
    vi.stubEnv('GITHUB_TOKEN', 'gh-secret');
    vi.stubEnv('AWS_SECRET_ACCESS_KEY', 'aws-secret');
    const env = runtimeEnv(['OPENAI_API_KEY']);
    expect(env.OPENAI_API_KEY).toBe('sk-test');
    expect(env).not.toHaveProperty('GITHUB_TOKEN');
    expect(env).not.toHaveProperty('AWS_SECRET_ACCESS_KEY');
    expect(
      Object.keys(env).every((k) =>
        ['PATH', 'TMPDIR', 'LANG', 'OPENAI_API_KEY'].includes(k)
      )
    ).toBe(true);
    // Not the caller's home: its dotfiles stay out of reach of config lookups.
    expect(env).not.toHaveProperty('HOME');
  });
});

describe('commandTool', () => {
  it('runs the program with arguments, no shell, without the caller env', async () => {
    vi.stubEnv('GITHUB_TOKEN', 'gh-secret');
    const tool = commandTool({
      name: 'env',
      description: 'd',
      argv: ['/usr/bin/env'],
    });
    const out = await tool.run({ args: [] }, root);
    expect(out).not.toContain('gh-secret');
    const echo = commandTool({
      name: 'echo',
      description: 'd',
      argv: ['/bin/echo'],
    });
    expect(await echo.run({ args: ['$(id)', ';', 'ls'] }, root)).toBe(
      '$(id) ; ls\n'
    );
  });
});

describe('codexRuntime', () => {
  it('runs read-only, offline, with a fresh home and only its key', async () => {
    clearLLMEnv();
    vi.stubEnv('OPENAI_API_KEY', 'sk-test');
    vi.stubEnv('GITHUB_TOKEN', 'gh-secret');
    const { codexRuntime } = await import('./codexRuntime.js');
    const result = await codexRuntime().run({
      workspace: root,
      system: 'S',
      prompt: 'P',
      model: 'm',
      effort: 'medium',
      maxTurns: 10,
      timeoutMs: 10_000,
      outputSchema: { type: 'object' },
    });
    expect(codexCalls.thread).toMatchObject({
      sandboxMode: 'read-only',
      workingDirectory: root,
      networkAccessEnabled: false,
      webSearchMode: 'disabled',
      approvalPolicy: 'never',
      model: 'm',
      modelReasoningEffort: 'medium',
    });
    const env = codexCalls.options!.env as Record<string, string>;
    expect(env.CODEX_HOME).toMatch(/mst-codex-home-/);
    expect(env.HOME).toBe(env.CODEX_HOME);
    expect(env).not.toHaveProperty('GITHUB_TOKEN');
    // The public API: no base URL override.
    expect(codexCalls.options).not.toHaveProperty('baseUrl');
    expect(env).not.toHaveProperty('OPENAI_API_KEY');
    expect(codexCalls.options!.apiKey).toBe('sk-test');
    expect(codexCalls.input).toBe('S\n\nP');
    expect(result.json).toEqual({ score: 7 });
    expect(result.usage).toMatchObject({
      inputTokens: 100,
      outputTokens: 20,
      cacheReadInputTokens: 40,
      reasoningOutputTokens: 5,
    });
    // The command and its output aren't kept.
    expect(result.steps[0]).toEqual({ tool: 'shell', isError: false });
  });

  it('takes its endpoint from resolveLLMEndpoint, as other OpenAI calls do', async () => {
    clearLLMEnv();
    vi.stubEnv('OPENAI_BASE_URL', 'https://gateway.example/v1');
    vi.stubEnv('MST_LLM_AUTH_COMMAND', 'echo gateway-token');
    const { codexRuntime } = await import('./codexRuntime.js');
    await codexRuntime().run({
      workspace: root,
      prompt: 'p',
      maxTurns: 1,
      timeoutMs: 10_000,
    });
    expect(codexCalls.options).toMatchObject({
      apiKey: 'gateway-token',
      baseUrl: 'https://gateway.example/v1',
    });
  });

  it('needs an API key, and no longer reads CODEX_API_KEY', async () => {
    clearLLMEnv();
    vi.stubEnv('CODEX_API_KEY', 'sk-codex');
    const { codexRuntime } = await import('./codexRuntime.js');
    await expect(
      codexRuntime().run({
        workspace: root,
        prompt: 'p',
        maxTurns: 1,
        timeoutMs: 1000,
      })
    ).rejects.toThrow(/requires an API key. Set OPENAI_API_KEY/);
  });
});

describe('claudeRuntime', () => {
  it('confines tools, loads no settings, and passes only its env', async () => {
    clearLLMEnv();
    vi.stubEnv('ANTHROPIC_API_KEY', 'sk-ant-test');
    vi.stubEnv('GITHUB_TOKEN', 'gh-secret');
    // Not passed through: only the endpoint MST resolved is.
    vi.stubEnv('CLAUDE_CODE_USE_BEDROCK', '1');
    const { claudeRuntime } = await import('./claudeRuntime.js');
    const result = await claudeRuntime().run({
      workspace: root,
      prompt: 'P',
      maxTurns: 10,
      timeoutMs: 10_000,
      outputSchema: { type: 'object' },
      commands: [
        { name: 'trace', description: 'd', argv: ['python3', 'scripts/t.py'] },
      ],
    });
    const o = claudeCalls.options!;
    expect(o.tools).toEqual(['Read', 'Grep', 'Glob']);
    expect(o.settingSources).toEqual([]);
    expect(o.strictMcpConfig).toBe(true);
    expect(o.persistSession).toBe(false);
    expect(o.permissionMode).toBe('default');
    expect(o.allowedTools).toEqual(['mcp__judge__trace']);
    expect(o.disallowedTools).toEqual(
      expect.arrayContaining(['Bash', 'Write', 'Edit', 'WebFetch', 'WebSearch'])
    );
    const env = o.env as Record<string, string>;
    expect(env.ANTHROPIC_API_KEY).toBe('sk-ant-test');
    expect(env.CLAUDE_CONFIG_DIR).toMatch(/mst-claude-home-/);
    expect(env.HOME).toBe(process.env.HOME);
    expect(env).not.toHaveProperty('GITHUB_TOKEN');
    expect(env).not.toHaveProperty('CLAUDE_CODE_USE_BEDROCK');
    expect(env).not.toHaveProperty('ANTHROPIC_BASE_URL');
    expect(result.json).toEqual({ score: 6 });
    expect(result.turns).toBe(2);
    expect(result.usage.totalCostUsd).toBe(0.01);
    // The path it read and what it got aren't kept.
    expect(result.steps).toEqual([{ tool: 'Read' }]);
  });

  it('sends a gateway its base URL and bearer token', async () => {
    clearLLMEnv();
    vi.stubEnv('ANTHROPIC_BASE_URL', 'https://gateway.example/anthropic');
    vi.stubEnv('ANTHROPIC_AUTH_TOKEN', 'gw-token');
    const { claudeRuntime } = await import('./claudeRuntime.js');
    await claudeRuntime().run({
      workspace: root,
      prompt: 'P',
      maxTurns: 1,
      timeoutMs: 10_000,
    });
    const env = claudeCalls.options!.env as Record<string, string>;
    expect(env).toMatchObject({
      ANTHROPIC_BASE_URL: 'https://gateway.example/anthropic',
      ANTHROPIC_AUTH_TOKEN: 'gw-token',
    });
    expect(env).not.toHaveProperty('ANTHROPIC_API_KEY');
  });

  it('needs a credential', async () => {
    clearLLMEnv();
    const { claudeRuntime } = await import('./claudeRuntime.js');
    await expect(
      claudeRuntime().run({
        workspace: root,
        prompt: 'P',
        maxTurns: 1,
        timeoutMs: 1000,
      })
    ).rejects.toThrow(/requires an API key. Set ANTHROPIC_API_KEY/);
  });
});
