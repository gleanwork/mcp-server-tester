import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { collectClientBatch } from './desktopBatch.js';
import { access, mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import type * as OsModule from 'node:os';
import { join } from 'node:path';
import {
  CHATGPT_APP_CLIENTS,
  CHATGPT_CLIENT,
  CHATGPT_LINUX_CLIENT,
  CODEX_APP_CLIENT,
  CODEX_APP_LINUX_CLIENT,
  chatgptOptionIssues,
} from './chatgptClient.js';
import { runChatgptTurn } from './chatgpt/turn.js';
import type * as ChatgptTurnModule from './chatgpt/turn.js';
import { clientRunToExecution } from './clientTrace.js';
import type { ClientBatchRequest } from './evalFrameworkTypes.js';
import type { ChatgptDesktop } from './chatgpt/desktop.js';
import { linuxEnvironment } from './chatgpt/linuxEnvironment.fixture.js';

const home = vi.hoisted(() => ({ value: '' }));
const lifecycle = vi.hoisted(() => ({
  prepare: vi.fn(),
  restart: vi.fn(),
  dispose: vi.fn(),
}));
vi.mock('./chatgptSetup/session.js', () => ({
  ChatgptAppSession: class {
    constructor(readonly desktop: ChatgptDesktop) {}
    prepare = lifecycle.prepare;
    restart = lifecycle.restart;
    dispose = lifecycle.dispose;
    telemetry = { scope: 'batch', id: 'test-batch' };
  },
}));
vi.mock('node:os', async (original) => ({
  ...(await original<typeof OsModule>()),
  homedir: () => home.value,
}));
vi.mock('./chatgpt/turn.js', async (original) => ({
  ...(await original<typeof ChatgptTurnModule>()),
  runChatgptTurn: vi.fn(),
}));
const context = { evalConfig: { name: 'test', datasets: [], concurrency: 1 } };
const config = {
  type: 'chatgpt',
  model: 'test-chatgpt-model',
  reasoningEffort: 'medium',
};
const requests = (): ClientBatchRequest[] =>
  ['one', 'two'].map((caseId) => ({
    caseId,
    trial: 0,
    config,
    input: {
      prompt: `Answer ${caseId}`,
      servers: [
        {
          transport: 'http',
          label: 'primary',
          serverUrl: 'https://example.test/eval',
          auth: { accessToken: 'fixture-secret' },
        },
      ],
    },
  }));
const metadata = {
  traceSource: 'client-local-transcript' as const,
  traceConfidence: 'high' as const,
  artifacts: [],
  session: { runMarker: 'marker', id: 'session', turnId: 'turn' },
  correlation: {
    strategy: 'prompt_marker' as const,
    marker: 'marker',
    includedInPrompt: true,
  },
};

beforeEach(async () => {
  home.value = await mkdtemp(join(tmpdir(), 'chatgpt-v2-test-'));
  lifecycle.prepare.mockReset().mockResolvedValue(undefined);
  lifecycle.restart.mockReset().mockResolvedValue(undefined);
  lifecycle.dispose.mockReset().mockResolvedValue(undefined);
  vi.mocked(runChatgptTurn)
    .mockReset()
    .mockImplementation(async () => ({
      success: true,
      response: 'answer',
      clientMetadata: {
        ...metadata,
        session: {
          ...metadata.session,
          id:
            vi.mocked(runChatgptTurn).mock.calls.length === 1
              ? 'session'
              : `session-${vi.mocked(runChatgptTurn).mock.calls.length}`,
        },
      },
      usage: {
        inputTokens: 10,
        outputTokens: 5,
        durationMs: 100,
        reasoningOutputTokens: 2,
      },
      toolCalls: [
        {
          name: 'search',
          source: 'mcp',
          server: 'primary',
          arguments: { query: 'test' },
          output: 'evidence',
          durationMs: 20,
          isError: false,
        },
      ],
    }));
});
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await rm(home.value, { recursive: true, force: true });
});

describe('ChatGPT and Codex app sessions', () => {
  it.each([
    ['chatgpt', CHATGPT_CLIENT, 'chatgpt-work'],
    ['codex-app', CODEX_APP_CLIENT, 'codex'],
    ['chatgpt', CHATGPT_LINUX_CLIENT, 'chatgpt-work'],
    ['codex-app', CODEX_APP_LINUX_CLIENT, 'codex'],
  ] as const)(
    '%s opens once and runs the same native turn body',
    async (type, client, surface) => {
      const request = requests()[0]!;
      const linux =
        client === CHATGPT_LINUX_CLIENT || client === CODEX_APP_LINUX_CLIENT;
      const options = {
        config: {
          ...config,
          type,
          ...(linux ? { env: linuxEnvironment(home.value) } : {}),
        },
        input: { servers: request.input.servers },
      };
      const session = await client.open!(options, context);
      try {
        expect(lifecycle.prepare).toHaveBeenCalledOnce();
        expect(session.readiness).toBeUndefined(); // Dispatch checks before opening this app.
        expect(session.diagnose).toBeUndefined(); // No new diagnosis policy for ChatGPT.
        // Mutating the caller's settings cannot change an already opened session.
        options.config.model = 'changed-after-open';
        options.input.servers.length = 0;
        const result = await session.run({
          caseId: 'direct',
          trial: 2,
          input: { prompt: '  original prompt\n' },
        });
        expect(result.continuation).toBe('continue');
        expect(result.result).toMatchObject({
          finalText: 'answer',
          events: [{ server: 'primary', name: 'search' }],
        });
        expect(runChatgptTurn).toHaveBeenLastCalledWith(
          '  original prompt\n',
          expect.objectContaining({
            model: config.model,
            options: expect.objectContaining({ surface }),
          }),
          expect.objectContaining({
            desktop: expect.objectContaining({
              os: linux ? 'linux' : 'darwin',
              product: expect.objectContaining({ client: type, surface }),
            }),
          }),
          { caseId: 'direct' }
        );
        await session.reset();
        await session.run({
          caseId: 'next',
          trial: 0,
          input: { prompt: 'next prompt' },
        });
        expect(lifecycle.restart).toHaveBeenCalledOnce();
        expect(runChatgptTurn).toHaveBeenCalledTimes(2);
        expect(lifecycle.prepare).toHaveBeenCalledOnce();
      } finally {
        await session.close();
      }
      expect(lifecycle.dispose).toHaveBeenCalledOnce();
      expect(session.lifecycle).toEqual({ scope: 'batch', id: 'test-batch' });
    }
  );

  it('keeps duplicate-native-session protection across direct resets', async () => {
    vi.mocked(runChatgptTurn).mockResolvedValue({
      success: true,
      response: 'answer',
      toolCalls: [],
      clientMetadata: metadata,
    });
    const request = requests()[0]!;
    const session = await CHATGPT_CLIENT.open!(
      { config, input: { servers: request.input.servers } },
      context
    );
    const trial = {
      caseId: 'same',
      trial: 0,
      input: { prompt: 'same prompt' },
    };
    try {
      expect((await session.run(trial)).continuation).toBe('continue');
      const duplicate = await session.run({ ...trial, trial: 1 });
      expect(duplicate.continuation).toBe('reset');
      expect(duplicate.result.error).toContain('duplicate attribution');
      await expect(session.run(trial)).rejects.toThrow('requires reset');
      await session.reset();
      expect((await session.run(trial)).result.error).toContain(
        'duplicate attribution'
      );
      expect(runChatgptTurn).toHaveBeenCalledTimes(3);
    } finally {
      await session.close();
    }
  });

  it('cleans up a failed direct open before releasing the shared lease', async () => {
    lifecycle.prepare.mockRejectedValueOnce(new Error('launch failed'));
    await expect(
      CHATGPT_CLIENT.open!({ config, input: { servers: [] } }, context)
    ).rejects.toThrow('launch failed');
    expect(lifecycle.dispose).toHaveBeenCalledOnce();
    expect(runChatgptTurn).not.toHaveBeenCalled();
    await expect(
      access(join(home.value, '.mcp-server-tester/chatgpt-desktop.lock'))
    ).rejects.toThrow();
  });

  it('retains the shared lease on failed direct close', async () => {
    const session = await CODEX_APP_CLIENT.open!(
      { config: { ...config, type: 'codex-app' }, input: { servers: [] } },
      context
    );
    lifecycle.dispose.mockRejectedValueOnce(new Error('restore failed'));
    await expect(session.close()).rejects.toThrow('desktop lock retained');
    await expect(
      CHATGPT_CLIENT.open!({ config, input: { servers: [] } }, context)
    ).rejects.toThrow('locked');
    expect(lifecycle.prepare).toHaveBeenCalledOnce();
  });
});

describe('ChatGPT V2 batch client', () => {
  it('keeps the single-run blank prompt check before setup', async () => {
    await expect(
      CHATGPT_CLIENT.run!({ prompt: '  ', servers: [] }, config, context)
    ).rejects.toThrow('ChatGPT requires a non-empty input.');
    expect(lifecycle.prepare).not.toHaveBeenCalled();
    expect(runChatgptTurn).not.toHaveBeenCalled();
  });
  it('takes its options directly, not nested under options', () => {
    expect(
      CHATGPT_CLIENT.schema.parse({
        type: 'chatgpt',
        model: 'm',
        requireMcpCalls: true,
      })
    ).toMatchObject({ requireMcpCalls: true, correlation: 'exact_prompt' });
    expect(() =>
      CHATGPT_CLIENT.schema.parse({
        type: 'chatgpt',
        model: 'm',
        options: { requireMcpCalls: true },
      })
    ).toThrow(
      '`clientOptions.options` is gone: set its keys in `clientOptions` directly'
    );
  });
  it('routes Linux through the native identity and isolated batch lifecycle', async () => {
    const batch = requests();
    for (const request of batch)
      request.config = {
        ...config,
        type: 'codex-app',
        env: linuxEnvironment(home.value),
      };
    await collectClientBatch(CODEX_APP_LINUX_CLIENT, batch, context);
    expect(lifecycle.prepare).toHaveBeenCalledTimes(1);
    expect(lifecycle.dispose).toHaveBeenCalledTimes(1);
    expect(runChatgptTurn).toHaveBeenCalledTimes(2);
    for (const [prompt, external] of vi.mocked(runChatgptTurn).mock.calls) {
      expect(prompt).toMatch(/^Answer (one|two)$/);
      expect(external.os).toBe('linux');
      expect(external.options?.surface).toBe('codex');
      // The native automation's default budget.
      expect(external.options?.maxActions).toBe(24);
      expect(external.options?.desktopEnvironment).toMatchObject({
        HOME: home.value,
      });
    }
  });

  it('rejects an incomplete Linux environment before lifecycle or query execution', async () => {
    vi.stubEnv('AT_SPI_BUS_ADDRESS', '');
    await expect(
      collectClientBatch(CHATGPT_LINUX_CLIENT, requests(), context)
    ).rejects.toThrow('environment_invalid');
    expect(lifecycle.prepare).not.toHaveBeenCalled();
    expect(runChatgptTurn).not.toHaveBeenCalled();
  });

  it.each([
    ['chatgpt', 'macOS', 'chatgpt-work', CHATGPT_CLIENT],
    ['codex-app', 'macOS', 'codex', CODEX_APP_CLIENT],
    ['chatgpt', 'Linux', 'chatgpt-work', CHATGPT_LINUX_CLIENT],
    ['codex-app', 'Linux', 'codex', CODEX_APP_LINUX_CLIENT],
  ] as const)(
    '%s on %s drives the %s surface, without prompt instructions',
    async (type, platform, surface, client) => {
      const batch = requests().slice(0, 1);
      batch[0]!.config = {
        ...config,
        type,
        ...(platform === 'Linux' ? { env: linuxEnvironment(home.value) } : {}),
      };
      await collectClientBatch(client, batch, context);
      expect(runChatgptTurn).toHaveBeenCalledWith(
        'Answer one',
        expect.objectContaining({
          options: expect.objectContaining({ surface }),
        }),
        expect.anything(),
        expect.anything()
      );
    }
  );
  it.each([
    [
      'chatgpt',
      'codex',
      '`clientOptions.surface` is gone: use the `codex-app` client for the Codex surface, and remove `surface`.',
    ],
    [
      'chatgpt',
      'chatgpt-work',
      '`clientOptions.surface` is gone: remove it. `chatgpt` always drives ChatGPT Work.',
    ],
    [
      'codex-app',
      'codex',
      '`clientOptions.surface` is gone: remove it. `codex-app` always drives the Codex surface.',
    ],
    [
      'codex-app',
      'chatgpt-work',
      '`clientOptions.surface` is gone: use the `chatgpt` client for ChatGPT Work, and remove `surface`.',
    ],
  ] as const)(
    '%s rejects surface %s, naming what replaces it, before app setup',
    async (type, surface, message) => {
      const client = type === 'chatgpt' ? CHATGPT_CLIENT : CODEX_APP_CLIENT;
      const batch = requests().slice(0, 1);
      batch[0]!.config = { ...config, type, surface };
      await expect(collectClientBatch(client, batch, context)).rejects.toThrow(
        message
      );
      expect(lifecycle.prepare).not.toHaveBeenCalled();
      expect(runChatgptTurn).not.toHaveBeenCalled();
    }
  );
  it('names the Codex app in its errors', async () => {
    await expect(
      collectClientBatch(CODEX_APP_CLIENT, requests(), {
        evalConfig: { ...context.evalConfig, concurrency: 2 },
      })
    ).rejects.toThrow('Codex app desktop requires concurrency 1.');
  });
  it('shares the desktop lease with chatgpt: one app, one batch at a time', async () => {
    let started!: () => void;
    const preparing = new Promise<void>((resolve) => (started = resolve));
    let release!: () => void;
    lifecycle.prepare.mockImplementationOnce(async () => {
      started();
      await new Promise<void>((resolve) => (release = resolve));
    });
    // ChatGPT holds the app while Codex app tries to start.
    const chatgpt = collectClientBatch(CHATGPT_CLIENT, requests(), context);
    await preparing;
    await access(join(home.value, '.mcp-server-tester/chatgpt-desktop.lock'));
    await expect(
      collectClientBatch(CODEX_APP_CLIENT, requests(), context)
    ).rejects.toThrow(
      `Codex app desktop is locked by another run or an interrupted run (${join(home.value, '.mcp-server-tester/chatgpt-desktop.lock')})`
    );
    release();
    await chatgpt;
    expect(lifecycle.prepare).toHaveBeenCalledTimes(1);
    // Released, the app is Codex app's to drive.
    await collectClientBatch(CODEX_APP_CLIENT, requests(), context);
    expect(lifecycle.prepare).toHaveBeenCalledTimes(2);
  });
  it('defaults to exact-prompt matching and passes the eval query without any suffix', async () => {
    const batch = requests().slice(0, 1);
    batch[0]!.input.prompt =
      '  Find snake_case docs — α\nDo not change this.  ';
    await collectClientBatch(CHATGPT_CLIENT, batch, context);
    const [prompt, actual] = vi.mocked(runChatgptTurn).mock.calls[0]!;
    expect(prompt).toBe(batch[0]!.input.prompt);
    expect(prompt).not.toContain('Evaluation MCP routing');
    expect(actual.correlation).toEqual({
      strategy: 'exact_prompt',
      includeInPrompt: false,
    });
  });
  it('exposes prompt markers only as an opt-in correlation mode', async () => {
    const batch = requests().slice(0, 1);
    batch[0]!.config = { ...config, correlation: 'prompt_marker' };
    await collectClientBatch(CHATGPT_CLIENT, batch, context);
    expect(vi.mocked(runChatgptTurn).mock.calls[0]![1].correlation).toEqual({
      strategy: 'prompt_marker',
      includeInPrompt: true,
    });
  });
  it('prepares once before cases, shares only app state, and disposes once after them', async () => {
    const traces = await collectClientBatch(
      CHATGPT_CLIENT,
      requests(),
      context
    );
    expect(lifecycle.prepare).toHaveBeenCalledTimes(1);
    expect(lifecycle.dispose).toHaveBeenCalledTimes(1);
    expect(lifecycle.prepare.mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(runChatgptTurn).mock.invocationCallOrder[0]!
    );
    expect(lifecycle.dispose.mock.invocationCallOrder[0]).toBeGreaterThan(
      vi.mocked(runChatgptTurn).mock.invocationCallOrder[1]!
    );
    const calls = vi.mocked(runChatgptTurn).mock.calls;
    expect(calls[0]![2]).toBe(calls[1]![2]);
    expect(traces.map((r) => r.telemetry?.batchCase)).toEqual([
      { index: 0, caseId: 'one', count: 2 },
      { index: 1, caseId: 'two', count: 2 },
    ]);
    expect(traces[0]!.telemetry?.batchLifecycle).toEqual({
      scope: 'batch',
      id: 'test-batch',
    });
  });
  it.each(['servers', 'credentials', 'environment'])(
    'opens separate sessions for different %s',
    async (difference) => {
      const batch = requests();
      if (difference === 'servers') batch[1]!.input.servers = [];
      else if (difference === 'credentials')
        batch[1]!.input.servers = [
          {
            transport: 'http',
            label: 'primary',
            serverUrl: 'https://example.test/eval',
            auth: { accessToken: 'different' },
          },
        ];
      else batch[1]!.input.env = { ANTHROPIC_API_KEY: 'different' };
      await collectClientBatch(CHATGPT_CLIENT, batch, context);
      expect(lifecycle.prepare).toHaveBeenCalledTimes(2);
      expect(lifecycle.dispose).toHaveBeenCalledTimes(2);
    }
  );
  it('rejects duplicate native sessions and restarts before the next query', async () => {
    vi.mocked(runChatgptTurn).mockResolvedValue({
      success: true,
      response: 'answer',
      toolCalls: [],
      clientMetadata: metadata,
    });
    const batch = [...requests(), { ...requests()[0]!, caseId: 'three' }];
    const traces = await collectClientBatch(CHATGPT_CLIENT, batch, context);
    expect(traces[1]!.error).toContain('duplicate attribution');
    // The reused session id stays claimed, so case three is also refused.
    // Restarts happen only before a later case, never after the last one.
    expect(traces[2]!.error).toContain('duplicate attribution');
    expect(runChatgptTurn).toHaveBeenCalledTimes(3);
    expect(lifecycle.restart).toHaveBeenCalledTimes(1);
    expect(lifecycle.dispose).toHaveBeenCalledTimes(1);
  });
  it('retains evidence and a recovery lock when batch cleanup fails', async () => {
    lifecycle.dispose.mockRejectedValueOnce(new Error('restore failed'));
    const traces = await collectClientBatch(
      CHATGPT_CLIENT,
      requests(),
      context
    );
    expect(traces.every((r) => r.error?.includes('batch cleanup failed'))).toBe(
      true
    );
    expect(traces[0]!.finalText).toBe('answer');
    expect(traces[0]!.telemetry?.clientMetadata).toBeDefined();
    await expect(
      access(join(home.value, '.mcp-server-tester/chatgpt-desktop.lock'))
    ).resolves.toBeUndefined();
    await expect(
      collectClientBatch(CHATGPT_CLIENT, requests(), context)
    ).rejects.toThrow('locked');
  });
  it('cleans up partial setup before releasing the desktop lease', async () => {
    lifecycle.prepare.mockRejectedValueOnce(new Error('launch failed'));
    await expect(
      collectClientBatch(CHATGPT_CLIENT, requests(), context)
    ).rejects.toThrow('launch failed');
    expect(runChatgptTurn).not.toHaveBeenCalled();
    expect(lifecycle.dispose).toHaveBeenCalledTimes(1);
    await expect(
      access(join(home.value, '.mcp-server-tester/chatgpt-desktop.lock'))
    ).rejects.toThrow();
  });
  it('forwards controller settings independently of the evaluated model', async () => {
    const batch = requests().slice(0, 1);
    batch[0]!.config = {
      ...config,
      computerUseModel: 'claude-sonnet-4-6',
      maxActions: 40,
    };
    await collectClientBatch(CHATGPT_CLIENT, batch, {
      ...context,
      env: { ANTHROPIC_API_KEY: 'controller-secret' },
    });
    expect(vi.mocked(runChatgptTurn).mock.calls[0]![1]).toMatchObject({
      model: 'test-chatgpt-model',
      options: {
        computerUseModel: 'claude-sonnet-4-6',
        maxActions: 40,
        computerUseEnvironment: { ANTHROPIC_API_KEY: 'controller-secret' },
      },
    });
    expect(
      vi.mocked(runChatgptTurn).mock.calls[0]![1].options?.environment
    ).not.toHaveProperty('ANTHROPIC_API_KEY');
  });
  it.each([
    ['chatgpt', 'anthropic-computer-use'],
    ['chatgpt', 'linux-desktop'],
    ['codex-app', 'anthropic-computer-use'],
  ] as const)(
    '%s rejects computerUseProvider %s: the trial machine decides',
    async (type, provider) => {
      const client = type === 'chatgpt' ? CHATGPT_CLIENT : CODEX_APP_CLIENT;
      const batch = requests().slice(0, 1);
      batch[0]!.config = { ...config, type, computerUseProvider: provider };
      await expect(collectClientBatch(client, batch, context)).rejects.toThrow(
        '`clientOptions.computerUseProvider` is gone: remove it. The OS of the machine that runs the trial decides how a desktop client runs'
      );
      expect(lifecycle.prepare).not.toHaveBeenCalled();
      expect(runChatgptTurn).not.toHaveBeenCalled();
    }
  );
  it.each([
    ['chatgpt', 'darwin'],
    ['chatgpt', 'linux'],
    ['codex-app', 'darwin'],
    ['codex-app', 'linux'],
  ] as const)(
    "runs %s parsed on another OS on the trial machine's OS, %s",
    async (product, platformName) => {
      // The coordinator parses the config on the other OS.
      vi.spyOn(process, 'platform', 'get').mockReturnValue(
        platformName === 'linux' ? 'darwin' : 'linux'
      );
      const client = CHATGPT_APP_CLIENTS[product];
      const parsed = client.schema.parse({
        ...config,
        type: product,
        ...(platformName === 'linux'
          ? { env: linuxEnvironment(home.value) }
          : {}),
      }) as Record<string, unknown>;
      vi.spyOn(process, 'platform', 'get').mockReturnValue(platformName);
      const batch = requests().slice(0, 1);
      batch[0]!.config = { ...parsed, type: product };
      await collectClientBatch(client, batch, context);
      expect(runChatgptTurn).toHaveBeenCalledWith(
        'Answer one',
        expect.objectContaining({ os: platformName }),
        expect.objectContaining({
          desktop: expect.objectContaining({
            os: platformName,
            product: expect.objectContaining({ client: product }),
          }),
        }),
        expect.anything()
      );
    }
  );
  it('checks the options each OS uses against the OS it is given', () => {
    const macOnly = { computerUseModel: 'planner', maxActions: 8 };
    const linuxOnly = { maxActions: 8, plugins: [{}] };
    expect(chatgptOptionIssues(macOnly, 'darwin')).toEqual([]);
    expect(chatgptOptionIssues(linuxOnly, 'linux')).toEqual([]);
    expect(chatgptOptionIssues(macOnly, 'linux')).toEqual([
      'computerUseModel is the planner of Computer Use on macOS, and this trial runs on Linux, which has no planner.',
    ]);
    expect(chatgptOptionIssues(linuxOnly, 'darwin')).toEqual([
      'plugins install into the fresh profile ChatGPT runs on Linux, and this trial runs on macOS, which runs the installed app.',
    ]);
  });
  it("checks maxActions against the trial OS's range, which says its default", () => {
    for (const maxActions of [1, 64])
      for (const os of ['darwin', 'linux'] as const)
        expect(chatgptOptionIssues({ maxActions }, os)).toEqual([]);
    expect(chatgptOptionIssues({ maxActions: 65 }, 'darwin')).toEqual([
      'maxActions is 65, and on macOS, where this trial runs, it is 1 to 64 (default 32).',
    ]);
    expect(chatgptOptionIssues({ maxActions: 65 }, 'linux')).toEqual([
      'maxActions is 65, and on Linux, where this trial runs, it is 1 to 64 (default 24).',
    ]);
    // An OS the app doesn't run on has no range; the platform rejects it.
    expect(chatgptOptionIssues({ maxActions: 65 }, 'win32')).toEqual([]);
  });
  it.each([
    ['darwin', 'chatgpt', CHATGPT_CLIENT, 32],
    ['linux', 'chatgpt', CHATGPT_LINUX_CLIENT, 24],
    ['darwin', 'codex-app', CODEX_APP_CLIENT, 32],
    ['linux', 'codex-app', CODEX_APP_LINUX_CLIENT, 24],
  ] as const)(
    "gives the automation the trial OS's default maxActions on %s for %s, or the one set",
    async (os, type, client, fallback) => {
      const env = os === 'linux' ? { env: linuxEnvironment(home.value) } : {};
      const batch = requests().slice(0, 1);
      batch[0]!.config = { ...config, type, ...env };
      await collectClientBatch(client, batch, context);
      batch[0]!.config = { ...config, type, ...env, maxActions: 9 };
      await collectClientBatch(client, batch, context);
      expect(
        vi
          .mocked(runChatgptTurn)
          .mock.calls.map(([, external]) => external.options?.maxActions)
      ).toEqual([fallback, 9]);
    }
  );
  it.each([
    [
      'macOS',
      CODEX_APP_CLIENT,
      { maxActions: 65 },
      'maxActions is 65, and on macOS, where this trial runs, it is 1 to 64 (default 32).',
    ],
    [
      'Linux',
      CODEX_APP_LINUX_CLIENT,
      { maxActions: 65 },
      'maxActions is 65, and on Linux, where this trial runs, it is 1 to 64 (default 24).',
    ],
    [
      'Linux',
      CODEX_APP_LINUX_CLIENT,
      { computerUseModel: 'planner' },
      'computerUseModel is the planner of Computer Use on macOS',
    ],
  ] as const)(
    'on %s, rejects an option the OS cannot use before the app is prepared',
    async (platform, client, options, message) => {
      const batch = requests().slice(0, 1);
      batch[0]!.config = {
        ...config,
        type: 'codex-app',
        ...options,
        ...(platform === 'Linux' ? { env: linuxEnvironment(home.value) } : {}),
      };
      await expect(collectClientBatch(client, batch, context)).rejects.toThrow(
        `Codex app can't run this trial: ${message}`
      );
      expect(lifecycle.prepare).not.toHaveBeenCalled();
      expect(runChatgptTurn).not.toHaveBeenCalled();
    }
  );
  it('gives the app the reasoningEffort set, and rejects one it lacks before the app is prepared', async () => {
    const batch = requests().slice(0, 1);
    batch[0]!.config = {
      ...config,
      type: 'codex-app',
      reasoningEffort: 'ultra',
    };
    await collectClientBatch(CODEX_APP_CLIENT, batch, context);
    expect(vi.mocked(runChatgptTurn).mock.calls[0]![1].reasoningEffort).toBe(
      'ultra'
    );
    lifecycle.prepare.mockClear();
    batch[0]!.config = { ...config, reasoningEffort: 'minimal' };
    await expect(
      collectClientBatch(CHATGPT_CLIENT, batch, context)
    ).rejects.toThrow(
      "chatgpt doesn't support reasoningEffort `minimal`: it accepts low, medium, high, xhigh, max, ultra."
    );
    expect(lifecycle.prepare).not.toHaveBeenCalled();
  });
  it('runs ordered cases and preserves model, evidence, timing and unknown cost', async () => {
    const traces = await collectClientBatch(
      CHATGPT_CLIENT,
      requests(),
      context
    );
    expect(runChatgptTurn).toHaveBeenCalledTimes(2);
    expect(vi.mocked(runChatgptTurn).mock.calls[0]![1]).toMatchObject({
      model: 'test-chatgpt-model',
      reasoningEffort: 'medium',
      codexSetup: {
        servers: [
          {
            transport: 'http',
            label: 'primary',
            bearerTokenEnvVar: 'MST_CHATGPT_MCP_TOKEN_0',
          },
        ],
      },
      options: {
        environment: { MST_CHATGPT_MCP_TOKEN_0: 'fixture-secret' },
        maxActions: 32,
      },
    });
    expect(JSON.stringify(traces)).not.toContain('fixture-secret');
    expect(traces[0]!.usage?.totalCostUsd).toBeUndefined();
    expect(traces[0]!.telemetry?.clientMetadata).toMatchObject({
      session: { id: 'session', turnId: 'turn' },
    });
    expect(
      clientRunToExecution(traces[0]!, 'structured').response
    ).toMatchObject({
      toolCalls: [
        {
          name: 'search',
          source: 'mcp',
          server: 'primary',
          durationMs: 20,
          output: 'evidence',
        },
      ],
    });
    await expect(
      collectClientBatch(CHATGPT_CLIENT, requests().slice(0, 1), context)
    ).resolves.toHaveLength(1);
  });
  it('returns native events, times and telemetry directly without a result envelope', async () => {
    const startedAt = '2026-11-05T15:00:00.000Z';
    const completedAt = '2026-11-05T15:00:00.200Z';
    const modelCalls = [
      { id: 'request-1', model: config.model, durationMs: 150 },
    ];
    const search = {
      name: 'primary.search',
      source: 'mcp' as const,
      server: 'primary',
      rawName: 'mcp__primary__search',
      arguments: { query: 'test' },
      output: '',
      isError: false,
      id: 'call-1',
      durationMs: 0,
      startedAt,
      completedAt,
    };
    const discovery = {
      kind: 'tool_search' as const,
      name: 'find_tools',
      source: 'builtin' as const,
      arguments: {},
      results: [{ name: 'search', server: 'primary' }],
    };
    const clientMetadata = {
      ...metadata,
      session: { ...metadata.session, startedAt, completedAt },
    };
    vi.mocked(runChatgptTurn).mockResolvedValueOnce({
      success: true,
      response: '',
      clientMetadata,
      toolCalls: [search, discovery],
      modelCalls,
      usage: { inputTokens: 10, outputTokens: 5, durationMs: 200 },
      llmDurationMs: 150,
      mcpDurationMs: 0,
    });
    const [result] = await collectClientBatch(
      CHATGPT_CLIENT,
      requests().slice(0, 1),
      context
    );
    expect(result).toMatchObject({
      finalText: '',
      events: [{ ...search, kind: 'tool_call', name: 'search' }, discovery],
      modelCalls,
      startedAt,
      completedAt,
      usage: { inputTokens: 10, outputTokens: 5, durationMs: 200 },
      llmDurationMs: 150,
      telemetry: {
        clientMetadata,
        mcpDurationMs: 0,
        caseExecution: { status: 'completed', continuation: 'allowed' },
        mcpSelection: { status: 'passed', configuredMcpCallCount: 1 },
      },
    });
    expect(result!.error).toBeUndefined();
    expect(result!.ending).toBeUndefined();
    expect(result).not.toHaveProperty('toolCalls');
    expect(result).not.toHaveProperty('success');
  });
  it('keeps failed native turns as partial client results without evaluating server selection', async () => {
    const startedAt = '2026-11-05T15:00:00.000Z';
    const completedAt = '2026-11-05T15:00:00.200Z';
    const modelCalls = [{ id: 'partial-request', model: config.model }];
    const conversationHistory = [
      { role: 'assistant' as const, content: 'partial answer' },
    ];
    const call = {
      name: 'search',
      source: 'mcp' as const,
      server: 'external',
      rawName: 'mcp__external__search',
      arguments: {},
      output: 'failed',
      isError: true,
      id: 'call-1',
      durationMs: 20,
    };
    vi.mocked(runChatgptTurn).mockResolvedValueOnce({
      success: false,
      error: 'Native turn timed out.',
      clientMetadata: {
        ...metadata,
        failureKind: 'timeout',
        session: { ...metadata.session, startedAt, completedAt },
      },
      toolCalls: [call],
      modelCalls,
      usage: {
        inputTokens: 10,
        outputTokens: 2,
        cacheReadInputTokens: 6,
        durationMs: 200,
      },
      conversationHistory,
    });
    const [result] = await collectClientBatch(
      CHATGPT_CLIENT,
      requests().slice(0, 1),
      context
    );
    expect(result).toMatchObject({
      finalText: '',
      error: 'Native turn timed out.',
      events: [{ ...call, kind: 'tool_call' }],
      modelCalls,
      startedAt,
      completedAt,
      usage: {
        inputTokens: 4,
        outputTokens: 2,
        cacheReadInputTokens: 6,
        durationMs: 200,
      },
      telemetry: {
        caseExecution: { status: 'failed', continuation: 'restart' },
        mcpSelection: {
          status: 'not-evaluated',
          unexpectedServers: ['external'],
        },
        content: { conversationHistory },
      },
    });
    expect(result).not.toHaveProperty('llmDurationMs');
    expect(result!.telemetry).not.toHaveProperty('mcpDurationMs');
    expect(result!.telemetry).not.toHaveProperty('conversationHistory');
  });
  it('subtracts native cache reads from V2 uncached input, retaining native totals', async () => {
    vi.mocked(runChatgptTurn).mockResolvedValueOnce({
      success: true,
      response: 'answer',
      toolCalls: [],
      clientMetadata: {
        ...metadata,
        telemetry: { inputTokens: 10, cacheReadInputTokens: 6 },
      },
      usage: {
        inputTokens: 10,
        outputTokens: 2,
        cacheReadInputTokens: 6,
        durationMs: 100,
      },
    });
    const [trace] = await collectClientBatch(
      CHATGPT_CLIENT,
      requests().slice(0, 1),
      context
    );
    expect(trace!.usage).toMatchObject({
      inputTokens: 4,
      cacheReadInputTokens: 6,
    });
    expect(trace!.telemetry?.clientMetadata).toMatchObject({
      telemetry: { inputTokens: 10 },
    });
  });
  it('keeps the conversation under telemetry content, which stored results drop', async () => {
    const conversationHistory = [
      { role: 'user' as const, content: 'the prompt' },
      { role: 'assistant' as const, content: 'answer' },
    ];
    vi.mocked(runChatgptTurn).mockResolvedValueOnce({
      success: true,
      response: 'answer',
      toolCalls: [],
      clientMetadata: metadata,
      conversationHistory,
    });
    const [trace] = await collectClientBatch(
      CHATGPT_CLIENT,
      requests().slice(0, 1),
      context
    );
    expect(trace!.telemetry?.content).toEqual({ conversationHistory });
    expect(trace!.telemetry).not.toHaveProperty('conversationHistory');
  });
  it('fails out-of-selection MCP calls without blocking later completed measurements', async () => {
    vi.mocked(runChatgptTurn).mockResolvedValueOnce({
      success: true,
      response: 'plausible answer',
      clientMetadata: metadata,
      toolCalls: [
        {
          name: 'search',
          server: 'other-plugin',
          source: 'mcp',
          arguments: {},
        },
      ],
    });
    const traces = await collectClientBatch(
      CHATGPT_CLIENT,
      requests(),
      context
    );
    expect(traces[0]!.error).toContain('outside');
    expect(runChatgptTurn).toHaveBeenCalledTimes(2);
    expect(traces[1]!.error).toBeUndefined();
    expect(traces[0]!.telemetry?.caseExecution).toEqual({
      status: 'completed',
      continuation: 'allowed',
    });
    expect(traces[0]!.telemetry?.mcpSelection).toMatchObject({
      status: 'failed',
      unexpectedServers: ['other-plugin'],
    });
  });
  it('measures three cases despite client-tool-only and wrong-server failures', async () => {
    vi.mocked(runChatgptTurn)
      .mockResolvedValueOnce({
        success: true,
        response: 'Cannot access the desktop app',
        clientMetadata: metadata,
        toolCalls: [
          {
            name: 'js',
            rawName: 'cua_repl.js',
            source: 'builtin',
            server: 'cua_repl',
            arguments: {},
            isError: true,
          },
        ],
      })
      .mockResolvedValueOnce({
        success: true,
        response: 'answer via another plugin',
        clientMetadata: {
          ...metadata,
          session: { ...metadata.session, id: 'second', turnId: 'second-turn' },
        },
        toolCalls: [
          {
            name: 'search',
            source: 'mcp',
            server: 'other-plugin',
            arguments: {},
          },
        ],
      });
    const batch = [...requests(), { ...requests()[0]!, caseId: 'three' }].map(
      (r) => ({
        ...r,
        config: { ...config, requireMcpCalls: true },
      })
    );
    const traces = await collectClientBatch(CHATGPT_CLIENT, batch, context);
    expect(runChatgptTurn).toHaveBeenCalledTimes(3);
    expect(traces.map((r) => r.telemetry?.caseExecution)).toEqual(
      Array(3).fill({ status: 'completed', continuation: 'allowed' })
    );
    expect(traces[0]!.error).toContain('without calling');
    expect(traces[0]!.error).not.toContain('outside');
    expect(traces[1]!.error).toContain('outside');
    expect(traces[2]!.error).toBeUndefined();
    expect(traces[0]!.telemetry?.mcpSelection).toMatchObject({
      status: 'failed',
      configuredMcpCallCount: 0,
      externalMcpCallCount: 0,
      builtinToolCallCount: 1,
      unexpectedServers: [],
    });
    expect(traces[2]!.telemetry?.mcpSelection).toMatchObject({
      status: 'passed',
      configuredMcpCallCount: 1,
    });
    expect(
      clientRunToExecution(traces[0]!, 'structured').response
    ).toMatchObject({
      toolCalls: [
        {
          source: 'builtin',
          name: 'js',
          rawName: 'cua_repl.js',
          server: undefined,
          isError: true,
        },
      ],
    });
    expect(lifecycle.prepare).toHaveBeenCalledTimes(1);
    expect(lifecycle.dispose).toHaveBeenCalledTimes(1);
  });
  it('allows built-in tools alongside configured MCP calls without relaxing the MCP requirement', async () => {
    vi.mocked(runChatgptTurn).mockResolvedValueOnce({
      success: true,
      response: 'answer',
      clientMetadata: metadata,
      toolCalls: [
        {
          name: 'js',
          rawName: 'cua_repl.js',
          source: 'builtin',
          server: 'cua_repl',
          arguments: {},
        },
        { name: 'search', source: 'mcp', server: 'primary', arguments: {} },
      ],
    });
    const batch = requests().slice(0, 1);
    batch[0]!.config = { ...config, requireMcpCalls: true };
    const [trace] = await collectClientBatch(CHATGPT_CLIENT, batch, context);
    expect(trace!.error).toBeUndefined();
    expect(trace!.telemetry?.mcpSelection).toMatchObject({
      status: 'passed',
      configuredMcpCallCount: 1,
      builtinToolCallCount: 1,
    });
  });
  it('restarts the app after a failed case and runs later cases independently', async () => {
    vi.mocked(runChatgptTurn).mockResolvedValueOnce({
      success: true,
      response: 'answer',
      toolCalls: [],
      clientMetadata: metadata,
      usage: {
        inputTokens: 1,
        outputTokens: 1,
        cacheReadInputTokens: 2,
        durationMs: 1,
      },
    });
    const batch = [
      ...requests(),
      {
        ...requests()[0]!,
        caseId: 'three',
        input: { ...requests()[0]!.input, input: 'Answer three' },
      },
    ];
    const traces = await collectClientBatch(CHATGPT_CLIENT, batch, context);
    expect(traces[0]!.error).toContain('cached input exceeds');
    expect(traces[0]!.telemetry?.caseExecution).toEqual({
      status: 'failed',
      continuation: 'restart',
    });
    // One restart, before case 2 only; the failed case is never resent.
    expect(lifecycle.restart).toHaveBeenCalledTimes(1);
    expect(runChatgptTurn).toHaveBeenCalledTimes(3);
    expect(vi.mocked(runChatgptTurn).mock.calls.map((call) => call[0])).toEqual(
      batch.map((request) => request.input.prompt)
    );
    for (const trace of traces.slice(1)) {
      expect(trace.error).toBeUndefined();
      expect(trace.telemetry?.caseExecution).toEqual({
        status: 'completed',
        continuation: 'allowed',
      });
    }
  });
  it('ends a failed turn as its failure kind says (ADR 0010)', async () => {
    vi.mocked(runChatgptTurn).mockResolvedValueOnce({
      success: false,
      error: 'No fresh ChatGPT session matched the prompt.',
      toolCalls: [],
      clientMetadata: { ...metadata, failureKind: 'no_matching_session' },
    });
    const traces = await collectClientBatch(
      CHATGPT_CLIENT,
      requests(),
      context
    );
    expect(traces[0]!.ending).toEqual({
      kind: 'infrastructure',
      broke: 'client-app',
      retryable: true,
      reason: 'No fresh ChatGPT session matched the prompt.',
    });
    // A completed turn has no ending of its own: a trial.
    expect(traces[1]!.ending).toBeUndefined();
  });

  it('sends nothing more when the app cannot be restarted after a failed case', async () => {
    vi.mocked(runChatgptTurn).mockResolvedValueOnce({
      success: false,
      error: 'surface_mismatch',
      toolCalls: [],
      clientMetadata: metadata,
    });
    lifecycle.restart.mockRejectedValueOnce(new Error('app_exited'));
    const traces = await collectClientBatch(
      CHATGPT_CLIENT,
      requests(),
      context
    );
    expect(traces[0]!.error).toContain('surface_mismatch');
    for (const trace of traces.slice(1)) {
      expect(trace.error).toContain('could not be reset');
      expect(trace.error).toContain('app_exited');
      expect(trace.telemetry?.caseExecution).toEqual({
        status: 'not-submitted',
        continuation: 'blocked',
      });
    }
    expect(runChatgptTurn).toHaveBeenCalledTimes(1);
    expect(lifecycle.restart).toHaveBeenCalledTimes(1);
    expect(lifecycle.dispose).toHaveBeenCalledTimes(1);
  });
  it('counts plugin MCP servers as eval servers when no direct server is configured', async () => {
    vi.stubEnv('ACME_TOKEN', 'plugin-secret');
    vi.mocked(runChatgptTurn).mockResolvedValueOnce({
      success: true,
      response: 'answer',
      clientMetadata: metadata,
      toolCalls: [
        { name: 'search', source: 'mcp', server: 'acme_mcp', arguments: {} },
      ],
    });
    const plugins = [
      {
        name: 'acme',
        marketplace: { source: 'acme/plugins', ref: 'f'.repeat(40) },
        mcp: {
          acme_mcp: {
            url: 'https://example.test/eval',
            auth: { accessTokenEnv: 'ACME_TOKEN' },
            files: { 'c.json': { token: '${bearerToken}' } },
          },
        },
      },
    ];
    // Plugins install into the fresh profile ChatGPT runs on Linux.
    const batch = requests()
      .slice(0, 1)
      .map((r) => ({
        ...r,
        config: {
          ...config,
          plugins,
          requireMcpCalls: true,
          env: linuxEnvironment(home.value),
        },
        input: { ...r.input, servers: [] },
      }));
    const [trace] = await collectClientBatch(
      CHATGPT_LINUX_CLIENT,
      batch,
      context
    );
    expect(trace!.error).toBeUndefined();
    expect(trace!.telemetry?.mcpSelection).toMatchObject({
      status: 'passed',
      selectedServers: ['acme_mcp'],
      configuredMcpCallCount: 1,
    });
    const prepared = lifecycle.prepare.mock.calls[0]![0];
    expect(prepared.pluginCredentials).toEqual({
      'acme/acme_mcp': 'plugin-secret',
    });
    // The token reaches setup only through pluginCredentials, never the app env.
    expect(JSON.stringify(prepared.options)).not.toContain('plugin-secret');
    expect(JSON.stringify(trace)).not.toContain('plugin-secret');
  });
  it('fails before the app starts when a plugin credential is missing', async () => {
    const batch = requests()
      .slice(0, 1)
      .map((r) => ({
        ...r,
        config: {
          ...config,
          plugins: [
            {
              name: 'acme',
              marketplace: { source: 'acme/plugins', ref: 'f'.repeat(40) },
              mcp: {
                acme_mcp: {
                  url: 'https://example.test/eval',
                  auth: { accessTokenEnv: 'MISSING_ACME_TOKEN' },
                },
              },
            },
          ],
          env: linuxEnvironment(home.value),
        },
      }));
    await expect(
      collectClientBatch(CHATGPT_LINUX_CLIENT, batch, context)
    ).rejects.toMatchObject({
      code: 'plugin_credential_missing',
    });
    expect(lifecycle.prepare).not.toHaveBeenCalled();
  });
  it('rejects Cowork-only blockMcpServers in the ChatGPT schema', () => {
    const plugin = {
      name: 'acme',
      marketplace: { source: 'acme/plugins', ref: 'f'.repeat(40) },
    };
    expect(
      CHATGPT_CLIENT.schema.safeParse({ ...config, plugins: [plugin] }).success
    ).toBe(true);
    expect(
      CHATGPT_CLIENT.schema.safeParse({
        ...config,
        plugins: [{ ...plugin, blockMcpServers: ['acme_mcp'] }],
      }).success
    ).toBe(false);
  });
  it('requires MCP calls when the eval explicitly requests them', async () => {
    vi.mocked(runChatgptTurn).mockResolvedValueOnce({
      success: true,
      response: 'no tools',
      clientMetadata: metadata,
      toolCalls: [],
    });
    const batch = requests().slice(0, 1);
    batch[0]!.config = { ...config, requireMcpCalls: true };
    const [trace] = await collectClientBatch(CHATGPT_CLIENT, batch, context);
    expect(trace!.error).toContain('without calling');
  });
  it('fails before touching the app when a different process holds the desktop', async () => {
    await mkdir(join(home.value, '.mcp-server-tester'));
    await writeFile(
      join(home.value, '.mcp-server-tester/chatgpt-desktop.lock'),
      'another run'
    );
    await expect(
      collectClientBatch(CHATGPT_CLIENT, requests(), context)
    ).rejects.toThrow('locked');
    expect(runChatgptTurn).not.toHaveBeenCalled();
  });
  it('rejects concurrency and opens separate sessions for different models', async () => {
    await expect(
      collectClientBatch(CHATGPT_CLIENT, requests(), {
        evalConfig: { ...context.evalConfig, concurrency: 2 },
      })
    ).rejects.toThrow('concurrency 1');
    const mixed = requests();
    mixed[1]!.config = { ...config, model: 'other' };
    await collectClientBatch(CHATGPT_CLIENT, mixed, context);
    expect(lifecycle.prepare).toHaveBeenCalledTimes(2);
    expect(lifecycle.dispose).toHaveBeenCalledTimes(2);
  });
  it.each([undefined, null, 'primitive failure'])(
    'does not silently accept a non-Error rejection: %s',
    async (reason) => {
      vi.mocked(runChatgptTurn).mockRejectedValueOnce(reason);
      await expect(
        collectClientBatch(CHATGPT_CLIENT, requests(), context)
      ).rejects.toThrow();
      expect(lifecycle.dispose).toHaveBeenCalledTimes(1);
      await expect(
        access(join(home.value, '.mcp-server-tester/chatgpt-desktop.lock'))
      ).rejects.toThrow();
    }
  );
  it('redacts MCP and environment secrets from case and recovery errors', async () => {
    vi.stubEnv('OPENAI_API_KEY', 'env-api-key-value');
    vi.mocked(runChatgptTurn).mockResolvedValueOnce({
      success: false,
      error: 'upstream 401 for fixture-secret using env-api-key-value',
      toolCalls: [],
      clientMetadata: metadata,
    });
    lifecycle.restart.mockRejectedValueOnce(
      new Error('restart saw fixture-secret')
    );
    const traces = await collectClientBatch(
      CHATGPT_CLIENT,
      requests(),
      context
    );
    expect(traces[0]!.error).toBe(
      'upstream 401 for [REDACTED] using [REDACTED]'
    );
    expect(traces[1]!.error).toContain(
      'could not be reset after an earlier failed case: restart saw [REDACTED]'
    );
    expect(JSON.stringify(traces)).not.toMatch(
      /fixture-secret|env-api-key-value/
    );
  });
  it('redacts secrets from cleanup and unexpected execution errors', async () => {
    vi.mocked(runChatgptTurn).mockRejectedValueOnce(
      new Error('crash with fixture-secret')
    );
    lifecycle.dispose.mockRejectedValueOnce(
      new Error('dispose saw fixture-secret')
    );
    const error = await collectClientBatch(
      CHATGPT_CLIENT,
      requests(),
      context
    ).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(AggregateError);
    const messages = (error as AggregateError).errors.map(
      (inner: Error) => `${inner.message}\n${inner.stack ?? ''}`
    );
    expect(messages.join('\n')).not.toContain('fixture-secret');
    expect(messages[0]).toContain('crash with [REDACTED]');
    expect(messages[1]).toContain('dispose saw [REDACTED]');
  });
  it('releases its lease after unexpected execution errors', async () => {
    vi.mocked(runChatgptTurn).mockRejectedValueOnce(new Error('crash'));
    await expect(
      collectClientBatch(CHATGPT_CLIENT, requests(), context)
    ).rejects.toThrow('crash');
    await expect(
      collectClientBatch(CHATGPT_CLIENT, requests(), context)
    ).resolves.toHaveLength(2);
  });
});

describe('ChatGPT server translation', () => {
  it('retains explicit MCP provenance when multiple servers are configured', async () => {
    const batch = requests().slice(0, 1);
    batch[0]!.input.servers.push({
      transport: 'stdio',
      label: 'second',
      command: 'node',
    });
    const traces = await collectClientBatch(CHATGPT_CLIENT, batch, context);
    expect(
      clientRunToExecution(traces[0]!, 'structured', batch[0]!.input.servers)
        .response
    ).toMatchObject({
      toolCalls: [
        {
          name: 'primary.search',
          source: 'mcp',
          server: 'primary',
          durationMs: 20,
        },
      ],
    });
  });
});
