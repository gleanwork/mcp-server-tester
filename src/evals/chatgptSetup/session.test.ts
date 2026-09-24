import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as ControllerModule from './macController.js';
import type * as ConfigModule from '../codexSetup/config.js';
import type * as TraceModule from '../externalHost/builtins/chatgptTrace.js';
import type * as ComputerUseModule from '../cowork/anthropicComputerUse.js';
import {
  findChatgptTrace,
  parseChatgptTrace,
  snapshotChatgptSessions,
} from '../externalHost/builtins/chatgptTrace.js';
import { runExternalHostScenario } from '../externalHost/runtime.js';
import { ChatgptAppSession } from './session.js';
import type { ExternalHostConfig } from '../externalHost/types.js';
import { getChatgptApplicationController } from './macController.js';
import {
  installCodexConfig,
  type CodexExecutionPolicy,
} from '../codexSetup/config.js';
import {
  runAnthropicComputerUseSubmission,
  ComputerUseDriverError,
  type ComputerUseTelemetry,
} from '../cowork/anthropicComputerUse.js';

vi.mock('./macController.js', async (original) => ({
  ...(await original<typeof ControllerModule>()),
  getChatgptApplicationController: vi.fn(),
}));
vi.mock('../codexSetup/config.js', async (original) => ({
  ...(await original<typeof ConfigModule>()),
  installCodexConfig: vi.fn(),
}));
vi.mock('../cowork/anthropicComputerUse.js', async (original) => ({
  ...(await original<typeof ComputerUseModule>()),
  runAnthropicComputerUseSubmission: vi.fn(),
}));
vi.mock('node:timers/promises', () => ({ setTimeout: async () => undefined }));
vi.mock('../externalHost/builtins/chatgptTrace.js', async (original) => ({
  ...(await original<typeof TraceModule>()),
  findChatgptTrace: vi.fn(),
  snapshotChatgptSessions: vi.fn(),
}));

import { createLinuxChatgptProfile } from './linuxProfile.js';
import type * as LinuxProfileModule from './linuxProfile.js';
import { runLinuxChatgptDesktop } from '../chatgpt/linux.js';
import { NativeChatgptDriverError } from '../chatgpt/linux.js';
import type * as LinuxModule from '../chatgpt/linux.js';
import { linuxEnvironment } from '../chatgpt/linuxEnvironment.fixture.js';
import { CodexSetupError } from '../codexSetup/native.js';
vi.mock('./linuxProfile.js', async (original) => ({
  ...(await original<typeof LinuxProfileModule>()),
  createLinuxChatgptProfile: vi.fn(),
}));
vi.mock('../chatgpt/linux.js', async (original) => ({
  ...(await original<typeof LinuxModule>()),
  runLinuxChatgptDesktop: vi.fn(),
}));

const events: string[] = [];
const controller = {
  state: vi.fn(async () => ({ running: true })),
  stop: vi.fn(async () => undefined),
  start: vi.fn(async (_environment?: Record<string, string>) => undefined),
  openPrompt: vi.fn(async (_prompt: string) => undefined),
};
const beforeStart = vi.fn(async () => undefined);
const disposeProfile = vi.fn(async () => undefined);
const POLICY: CodexExecutionPolicy = {
  approvalPolicy: 'never',
  sandboxMode: 'danger-full-access',
};
function linuxTelemetry(action_count = 3) {
  return {
    telemetry: {
      driver: 'linux-desktop' as const,
      accounting: 'complete' as const,
      duration_ms: 5,
      action_count,
      planner: { status: 'not-applicable' as const },
      cost: { status: 'not-applicable' as const },
    },
  };
}
const restore = vi.fn(async () => undefined);
const plannerUsage: ComputerUseTelemetry = {
  accounting: 'complete',
  response_models: ['claude-sonnet-4-6'],
  planner_response_count: 1,
  usage: { input_tokens: 9000, output_tokens: 30 },
  usage_observation_counts: {
    input_tokens: 1,
    output_tokens: 1,
    cache_read_input_tokens: 0,
    cache_creation_input_tokens: 0,
  },
  duration_ms: 10,
  action_count: 2,
  attempted_action_count: 2,
  executed_action_count: 2,
  refused_action_count: 0,
  cost: { status: 'unavailable' },
};

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv('ANTHROPIC_API_KEY', 'test-controller-key');
  events.length = 0;
  vi.mocked(snapshotChatgptSessions).mockImplementation(async () => {
    events.push('snapshot');
    return new Map();
  });
  vi.mocked(findChatgptTrace).mockImplementation(
    async (_root, _baseline, selector) => {
      const records = [
        {
          type: 'session_meta',
          payload: { id: 'native-session', originator: 'codex_work_desktop' },
        },
        {
          type: 'event_msg',
          payload: { type: 'task_started', turn_id: 'native-turn' },
        },
        {
          type: 'turn_context',
          payload: { turn_id: 'native-turn', model: 'gpt-test', effort: 'low' },
        },
        {
          type: 'event_msg',
          payload: {
            type: 'item_completed',
            turn_id: 'native-turn',
            item: {
              type: 'UserMessage',
              id: 'u',
              content: [
                {
                  text:
                    typeof selector === 'string'
                      ? `[eval-run-marker:${selector}]`
                      : selector.prompt,
                },
              ],
            },
          },
        },
        {
          type: 'token_usage_record',
          payload: {
            turn_id: 'native-turn',
            response_id: 'r',
            turn_token_usage: { input_tokens: 20, output_tokens: 3 },
          },
        },
        {
          type: 'event_msg',
          payload: {
            type: 'task_complete',
            turn_id: 'native-turn',
            duration_ms: 100,
            last_agent_message: 'native answer',
          },
        },
      ];
      return {
        path: '/tmp/native-session.jsonl',
        trace: parseChatgptTrace(
          records
            .map((record) =>
              JSON.stringify({ timestamp: new Date().toISOString(), ...record })
            )
            .join('\n') + '\n',
          selector
        )!,
      };
    }
  );
  controller.state.mockImplementation(async () => {
    events.push('state');
    return { running: true };
  });
  controller.stop.mockImplementation(async () => {
    events.push('stop');
  });
  controller.start.mockImplementation(async () => {
    events.push('start');
  });
  restore.mockImplementation(async () => {
    events.push('restore');
  });
  vi.mocked(getChatgptApplicationController).mockResolvedValue(controller);
  for (const [mock, event] of [
    [controller.openPrompt, 'open'],
    [beforeStart, 'login-and-mcp'],
    [disposeProfile, 'dispose-profile'],
  ] as const)
    mock.mockImplementation(async () => void events.push(event));
  vi.mocked(createLinuxChatgptProfile).mockImplementation(async (env) => {
    events.push('profile');
    return {
      configPath: join(env.codexHome, 'config.toml'),
      install: { credentialStore: 'keyring', trustedProject: '/tmp/ws' },
      controller,
      evidenceDir: env.evidenceDir,
      readiness: {
        executionPolicy: POLICY,
        hostToolPolicy: { disabledPlugins: [], webSearch: 'disabled' },
        login: 'verified',
        mcpPreflight: [],
      },
      beforeStart,
      dispose: disposeProfile,
    };
  });
  vi.mocked(runLinuxChatgptDesktop).mockImplementation(
    async (mode, _config, _deadline, prompt, openPrompt) => {
      events.push(`native-${mode}`);
      await openPrompt?.(mode === 'submit' ? (prompt ?? '') : '');
      return linuxTelemetry();
    }
  );
  vi.mocked(installCodexConfig).mockImplementation(async () => {
    events.push('install');
    return {
      configPath: '/tmp/chatgpt-test/config.toml',
      configName: 'selected',
      serverCount: 2,
      restore,
    };
  });
  vi.mocked(runAnthropicComputerUseSubmission).mockImplementation(async () => {
    events.push('ai-submit');
    return {
      status: 'submitted',
      action_count: 2,
      model: 'claude-sonnet-4-6',
      submission_action: { action: 'key', text: 'enter' },
      telemetry: plannerUsage,
    };
  });
});
afterEach(() => vi.unstubAllEnvs());

function testConfig(
  model = 'gpt-test',
  options: Record<string, unknown> = {},
  reasoningEffort: 'low' | 'medium' = 'low'
): ExternalHostConfig {
  return {
    driver: 'openai.chatgpt.agent.desktop-app.macos',
    timeoutMs: 1000,
    model,
    reasoningEffort,
    codexSetup: {
      configPath: '/tmp/chatgpt-test/config.toml',
      configs: [
        { name: 'empty', servers: [] },
        {
          name: 'selected',
          servers: [
            { label: 'one', transport: 'stdio', command: 'one' },
            { label: 'two', transport: 'stdio', command: 'two' },
          ],
        },
      ],
    },
    options: {
      codexConfigName: 'selected',
      environment: { TEST_VALUE: 'value' },
      ...options,
    },
  };
}

function run(
  model = 'gpt-test',
  options: Record<string, unknown> = {},
  reasoningEffort: 'low' | 'medium' = 'low'
) {
  return runExternalHostScenario(
    'Say done',
    testConfig(model, options, reasoningEffort)
  );
}

describe('ChatGPT batch app lifecycle', () => {
  it('performs one app/config cycle around three isolated native submissions', async () => {
    const session = new ChatgptAppSession();
    const markers = new Set<string>();
    try {
      await session.prepare(testConfig());
      for (let i = 0; i < 3; i++) {
        const result = await run('gpt-test', {
          managedChatgptSession: session,
        });
        expect(result.success).toBe(true);
        markers.add(result.externalHost.correlation.marker);
      }
      expect(events).toEqual([
        'state',
        'stop',
        'install',
        'start',
        'snapshot',
        'ai-submit',
        'snapshot',
        'ai-submit',
        'snapshot',
        'ai-submit',
      ]);
      expect(restore).not.toHaveBeenCalled();
      expect(markers.size).toBe(3);
      expect(vi.mocked(findChatgptTrace).mock.calls[0]![1]).not.toBe(
        vi.mocked(findChatgptTrace).mock.calls[1]![1]
      );
      expect(
        vi
          .mocked(findChatgptTrace)
          .mock.calls.every((args) => args[4]?.requireFreshSession)
      ).toBe(true);
    } finally {
      await session.dispose();
    }
    await session.dispose(); // Idempotent: never restart or restore twice.
    expect(events.slice(-3)).toEqual(['stop', 'restore', 'start']);
    expect(installCodexConfig).toHaveBeenCalledTimes(1);
    expect(restore).toHaveBeenCalledTimes(1);
    expect(controller.start).toHaveBeenCalledTimes(2);
    expect(session.telemetry).toMatchObject({
      scope: 'batch',
      setupStatus: 'completed',
      cleanupStatus: 'completed',
    });
    expect(
      session.telemetry.events.map(
        ({ phase, operation }) => `${phase}:${operation}`
      )
    ).toEqual([
      'setup:stop',
      'setup:install_config',
      'setup:start',
      'cleanup:stop',
      'cleanup:restore_config',
      'cleanup:start',
    ]);
  });
  it('retains ownership until batch disposal after an uncertain query', async () => {
    const session = new ChatgptAppSession();
    try {
      await session.prepare(testConfig());
      vi.mocked(runAnthropicComputerUseSubmission).mockRejectedValueOnce(
        new Error('uncertain submit')
      );
      const result = await run('gpt-test', { managedChatgptSession: session });
      expect(result.success).toBe(false);
      expect(restore).not.toHaveBeenCalled();
      expect(controller.stop).toHaveBeenCalledTimes(1);
    } finally {
      await session.dispose();
    }
    expect(restore).toHaveBeenCalledTimes(1);
    expect(controller.stop).toHaveBeenCalledTimes(2);
  });
  it('rejects a changed configuration without borrowing the batch app', async () => {
    const session = new ChatgptAppSession();
    try {
      await session.prepare(testConfig());
      const result = await run('gpt-other', { managedChatgptSession: session });
      expect(result.success).toBe(false);
      expect(runAnthropicComputerUseSubmission).not.toHaveBeenCalled();
      expect(restore).not.toHaveBeenCalled();
    } finally {
      await session.dispose();
    }
  });
  it('cannot borrow a disposed batch session', async () => {
    const session = new ChatgptAppSession();
    await session.prepare(testConfig());
    await session.dispose();
    expect(
      (await run('gpt-test', { managedChatgptSession: session })).success
    ).toBe(false);
    expect(runAnthropicComputerUseSubmission).not.toHaveBeenCalled();
  });
});

describe('ChatGPT Linux native lifecycle', () => {
  let home: string;
  function linuxConfig(): ExternalHostConfig {
    const base = testConfig();
    return {
      ...base,
      driver: 'openai.chatgpt.agent.desktop-app.linux',
      codexSetup: { ...base.codexSetup, configPath: undefined },
      options: {
        ...base.options,
        surface: 'codex',
        desktopEnvironment: linuxEnvironment(home),
      },
    };
  }
  beforeEach(async () => {
    vi.stubEnv('ANTHROPIC_API_KEY', '');
    home = await realpath(await mkdtemp(join(tmpdir(), 'mst-linux-session-')));
    const sessions = join(home, '.codex', 'sessions');
    await mkdir(sessions, { recursive: true });
    await mkdir(join(home, 'evidence'), { mode: 0o700 });
    const transcript = join(sessions, 'rollout-native.jsonl');
    await writeFile(transcript, '{"type":"session_meta"}\n');
    const implementation = vi.mocked(findChatgptTrace).getMockImplementation()!;
    vi.mocked(findChatgptTrace).mockImplementation(async (...args) => {
      const found = await implementation(...args);
      return found ? { ...found, path: transcript } : found;
    });
    // The MST-owned Linux app is never running before setup.
    controller.state.mockImplementation(async () => {
      events.push('state');
      return { running: false };
    });
  });
  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  it('prepares surface once per batch and keeps native controller separate from model accounting', async () => {
    const session = new ChatgptAppSession();
    const config = linuxConfig();
    try {
      await session.prepare(config);
      expect(session.telemetry.nativeSetup).toEqual(linuxTelemetry().telemetry);
      for (let i = 0; i < 2; i++) {
        const result = await runExternalHostScenario('exact query', {
          ...config,
          options: { ...config.options, managedChatgptSession: session },
        });
        expect(result.success).toBe(true);
        expect(result.externalHost).toMatchObject({
          driver: { platform: 'linux' },
          computerUse: undefined,
          nativeController: {
            provider: 'linux-atspi',
            surface: 'codex',
            submission: { status: 'completed' },
          },
          traceSource: 'host-local-transcript',
          artifacts: [
            {
              kind: 'transcript',
              summary: expect.stringMatching(/sha256=[a-f0-9]{64}$/),
              path: expect.stringContaining(join(home, 'evidence')),
            },
          ],
        });
      }
      // Extra snapshots after each trace are the bounded evidence-candidate scan.
      const submit = ['open', 'snapshot', 'native-submit'];
      expect(
        events.filter(
          (event, i) =>
            event !== 'snapshot' || events[i + 1] === 'native-submit'
        )
      ).toEqual([
        ...['profile', 'state', 'install', 'login-and-mcp', 'start'],
        'native-prepare',
        ...submit,
        ...submit,
        'open',
      ]);
      expect(session.sessionsRoot).toBe(join(home, '.codex/sessions'));
      expect(session.evidenceDir).toBe(join(home, 'evidence'));
      expect(vi.mocked(installCodexConfig).mock.calls[0]).toEqual([
        expect.objectContaining({
          configPath: join(home, '.codex/config.toml'),
        }),
        expect.objectContaining({
          credentialStore: 'keyring',
          trustedProject: '/tmp/ws',
        }),
      ]);
      // Prepare opens an empty draft; each submit opens the exact prompt.
      expect(controller.openPrompt.mock.calls.map((call) => call[0])).toEqual([
        '',
        'exact query',
        'exact query',
      ]);
      expect(runAnthropicComputerUseSubmission).not.toHaveBeenCalled();
      expect(getChatgptApplicationController).not.toHaveBeenCalled();
    } finally {
      await session.dispose();
    }
    expect(events.slice(-3)).toEqual(['stop', 'restore', 'dispose-profile']);
  });

  it('fails before any prompt when login or MCP readiness fails', async () => {
    beforeStart.mockRejectedValueOnce(
      new CodexSetupError('mcp_server_not_ready')
    );
    const session = new ChatgptAppSession();
    await expect(session.prepare(linuxConfig())).rejects.toThrow(
      'mcp_server_not_ready'
    );
    for (const fn of [controller.start, runLinuxChatgptDesktop])
      expect(fn).not.toHaveBeenCalled();
    expect(controller.openPrompt).not.toHaveBeenCalled();
    expect(session.telemetry).toMatchObject({
      setupStatus: 'failed',
      nativeReadiness: { login: 'verified', executionPolicy: POLICY },
    });
    await session.dispose();
    expect(events.slice(-2)).toEqual(['restore', 'dispose-profile']);
  });

  it('claims one in-process lease per isolated Linux HOME', async () => {
    const first = new ChatgptAppSession();
    const second = new ChatgptAppSession();
    try {
      await first.prepare(linuxConfig());
      await expect(second.prepare(linuxConfig())).rejects.toThrow(
        'already managing this ChatGPT application'
      );
    } finally {
      await second.dispose();
      await first.dispose();
    }
  });

  it('does not submit or read evidence after failed surface setup', async () => {
    vi.mocked(runLinuxChatgptDesktop).mockRejectedValueOnce(
      new NativeChatgptDriverError('surface failed')
    );
    const result = await runExternalHostScenario('query', linuxConfig());
    expect(result.success).toBe(false);
    expect(runLinuxChatgptDesktop).toHaveBeenCalledTimes(1);
    expect(snapshotChatgptSessions).not.toHaveBeenCalled();
    expect(restore).toHaveBeenCalledTimes(1);
  });

  it('uncertain native send is not retried or interpreted as native evidence', async () => {
    const draftState = {
      observedSurface: 'chatgpt-work' as const,
      composerRootCount: 1,
      sendControlCount: 1,
      textReadable: false,
    };
    vi.mocked(runLinuxChatgptDesktop).mockImplementation(async (mode) => {
      if (mode === 'submit')
        throw new NativeChatgptDriverError('uncertain send', { draftState });
      return linuxTelemetry(0);
    });
    const result = await runExternalHostScenario('query', linuxConfig());
    expect(result.success).toBe(false);
    expect(result.externalHost.nativeController?.submission).toMatchObject({
      status: 'failed',
      draftState,
    });
    expect(result.externalHost.computerUse).toBeUndefined();
    expect(findChatgptTrace).not.toHaveBeenCalled();
    expect(runLinuxChatgptDesktop).toHaveBeenCalledTimes(2);
  });
});

describe('ChatGPT AI-driven macOS lifecycle', () => {
  it('shares the Cowork planner and keeps controller accounting separate from native usage', async () => {
    const result = await run('gpt-test', {
      computerUseModel: 'claude-sonnet-4-6',
      computerUseMaxActions: 40,
    });
    expect(result.success).toBe(true);
    expect(runAnthropicComputerUseSubmission).toHaveBeenCalledWith(
      expect.stringContaining('Say done'),
      expect.objectContaining({
        application: 'chatgpt',
        targetModel: 'gpt-test',
        reasoningEffort: 'low',
        model: 'claude-sonnet-4-6',
        maxActions: 40,
      })
    );
    expect(vi.mocked(runAnthropicComputerUseSubmission).mock.calls[0]![0]).toBe(
      'Say done'
    );
    expect(result.externalHost.correlation).toMatchObject({
      strategy: 'exact_prompt',
      includedInPrompt: false,
      promptUnchanged: true,
    });
    expect(result.externalHost.session).not.toHaveProperty('runMarker');
    if (result.success) {
      expect(result.response).toBe('native answer');
      expect(result.usage).toMatchObject({ inputTokens: 20, outputTokens: 3 });
      expect(result.usage?.totalCostUsd).toBeUndefined();
      expect(result.externalHost.computerUse?.submission.telemetry).toEqual(
        plannerUsage
      );
      expect(result.externalHost.sources?.toolCalls).toBe(
        'host-local-transcript'
      );
    }
    expect(JSON.stringify(result)).not.toContain('test-controller-key');
  });
  it('supports opt-in markers without changing the default', async () => {
    const result = await runExternalHostScenario('Say done', {
      ...testConfig(),
      correlation: { strategy: 'prompt_marker' },
    });
    expect(result.success).toBe(true);
    expect(
      vi.mocked(runAnthropicComputerUseSubmission).mock.calls[0]![0]
    ).toContain('[eval-run-marker:');
    expect(result.externalHost.correlation).toMatchObject({
      strategy: 'prompt_marker',
      includedInPrompt: true,
      promptUnchanged: false,
    });
    expect(result.externalHost.session.runMarker).toBe(
      result.externalHost.correlation.marker
    );
  });
  it.each(['none', 'host_session_metadata'] as const)(
    'rejects unsupported %s correlation before touching the app',
    async (strategy) => {
      const result = await runExternalHostScenario('Say done', {
        ...testConfig(),
        correlation: { strategy },
      });
      expect(result.success).toBe(false);
      expect(controller.stop).not.toHaveBeenCalled();
    }
  );
  it('binds the session and turn on the first observation before waiting for completion', async () => {
    const implementation = vi.mocked(findChatgptTrace).getMockImplementation()!;
    vi.mocked(findChatgptTrace).mockImplementationOnce(async (...args) => {
      const match = await implementation(...args);
      match!.trace.complete = false;
      return match;
    });
    const result = await run();
    expect(result.success).toBe(true);
    expect(vi.mocked(findChatgptTrace).mock.calls[1]![4]?.bound).toEqual({
      path: '/tmp/native-session.jsonl',
      sessionId: 'native-session',
      turnId: 'native-turn',
    });
  });
  it('stops before config install, submits once, and restores before restarting', async () => {
    expect((await run()).success).toBe(true);
    expect(events).toEqual([
      'state',
      'stop',
      'install',
      'start',
      'snapshot',
      'ai-submit',
      'stop',
      'restore',
      'start',
    ]);
    expect(controller.start).toHaveBeenNthCalledWith(1, {
      CODEX_HOME: '/tmp/chatgpt-test',
      TEST_VALUE: 'value',
    });
    expect(controller.start).toHaveBeenNthCalledWith(2);
    expect(installCodexConfig).toHaveBeenCalledWith(expect.anything(), {
      configName: 'selected',
      model: 'gpt-test',
      reasoningEffort: 'low',
    });
    expect(restore).toHaveBeenCalledWith({ archiveChanges: true });
    expect(runAnthropicComputerUseSubmission).toHaveBeenCalledTimes(1);
  });
  it.each(['native-macos', 'linux-desktop'])(
    'rejects %s before any desktop change',
    async (provider) => {
      expect(
        (await run('gpt-test', { computerUseProvider: provider })).success
      ).toBe(false);
      expect(controller.stop).not.toHaveBeenCalled();
      expect(installCodexConfig).not.toHaveBeenCalled();
    }
  );
  it('rejects reserved MCP namespaces in direct external-host configuration before touching the app', async () => {
    const result = await runExternalHostScenario('Say done', {
      ...testConfig(),
      codexSetup: {
        configPath: '/tmp/chatgpt-test/config.toml',
        servers: [{ transport: 'stdio', label: 'cua_repl', command: 'node' }],
      },
      options: {},
    });
    expect(result.success).toBe(false);
    expect(controller.stop).not.toHaveBeenCalled();
    expect(installCodexConfig).not.toHaveBeenCalled();
  });
  it('requires planner credentials before stopping the app', async () => {
    vi.stubEnv('ANTHROPIC_API_KEY', '');
    const result = await run();
    expect(result.success).toBe(false);
    expect(controller.stop).not.toHaveBeenCalled();
  });
  it('does not use UI answer extraction as a fallback', async () => {
    expect(
      (await run('gpt-test', { chatgptTrace: 'accessibility' })).success
    ).toBe(false);
    expect(runAnthropicComputerUseSubmission).not.toHaveBeenCalled();
  });
  it.each([
    ['gpt-other', 'low'],
    ['gpt-test', 'medium'],
  ] as const)(
    'fails mismatched native model/effort %s/%s',
    async (model, effort) => {
      const result = await run(model, {}, effort);
      expect(result.success).toBe(false);
      expect(result.externalHost.failureKind).toBe('host_run_failed');
      expect(restore).toHaveBeenCalledTimes(1);
    }
  );
  it('fails ambiguous native evidence and restores config', async () => {
    vi.mocked(findChatgptTrace).mockRejectedValueOnce(
      new Error('Ambiguous matching ChatGPT sessions')
    );
    expect((await run()).externalHost.failureKind).toBe(
      'ambiguous_matching_sessions'
    );
    expect(restore).toHaveBeenCalledTimes(1);
  });
  it('never retries an uncertain agent submission and retains partial controller telemetry', async () => {
    vi.mocked(runAnthropicComputerUseSubmission).mockRejectedValueOnce(
      new ComputerUseDriverError('uncertain submission', {
        ...plannerUsage,
        accounting: 'partial',
      })
    );
    const result = await run();
    expect(result.success).toBe(false);
    expect(
      result.externalHost.computerUse?.submission.telemetry?.accounting
    ).toBe('partial');
    expect(runAnthropicComputerUseSubmission).toHaveBeenCalledTimes(1);
    expect(findChatgptTrace).not.toHaveBeenCalled();
    expect(restore).toHaveBeenCalledTimes(1);
  });
  it('preserves initially stopped app state', async () => {
    controller.state.mockResolvedValue({ running: false });
    expect((await run()).success).toBe(true);
    expect(controller.start).toHaveBeenCalledTimes(1);
    expect(controller.stop).toHaveBeenCalledTimes(1);
  });
  it('does not install after a failed graceful stop', async () => {
    controller.stop.mockRejectedValue(new Error('declined termination'));
    expect((await run()).success).toBe(false);
    expect(installCodexConfig).not.toHaveBeenCalled();
    expect(controller.start).not.toHaveBeenCalled();
  });
  it('restores after a failed launch and restarts the previous app', async () => {
    controller.start.mockRejectedValueOnce(new Error('launch failed'));
    expect((await run()).success).toBe(false);
    expect(restore).toHaveBeenCalledTimes(1);
    expect(controller.start).toHaveBeenCalledTimes(2);
  });
  it('never restores underneath an app that cannot stop during cleanup', async () => {
    controller.stop
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('still running'));
    const result = await run();
    expect(result.externalHost.failureKind).toBe('cleanup_failed');
    expect(restore).not.toHaveBeenCalled();
  });
  it('does not restart after a restoration failure', async () => {
    restore.mockRejectedValueOnce(new Error('archive failed'));
    expect((await run()).success).toBe(false);
    expect(controller.start).toHaveBeenCalledTimes(1);
  });
});
