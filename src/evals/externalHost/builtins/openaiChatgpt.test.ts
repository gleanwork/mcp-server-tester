import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  ExternalHostCapabilityContext,
  ExternalHostFailureKind,
} from '../types.js';
import { normalizeHostDriver } from '../driverIdentity.js';
import { findChatgptTrace } from './chatgptTrace.js';
import type * as TraceModule from './chatgptTrace.js';
import {
  chatgptBindingDeadline,
  chatgptRunState,
  OPENAI_CHATGPT_CAPABILITIES,
  type ChatgptRunState,
} from './openaiChatgpt.js';
import { linuxEnvironment } from '../../chatgpt/linuxEnvironment.fixture.js';
import { submitChatgptQuery } from '../../chatgpt/driver.js';
import type * as DriverModule from '../../chatgpt/driver.js';
import { runLinuxChatgptDesktop } from '../../chatgpt/linux.js';
import type * as LinuxModule from '../../chatgpt/linux.js';
import { ChatgptAppSession } from '../../chatgptSetup/session.js';
import { NativeTraceError } from '../nativeTraceError.js';
import { NativeChatgptDriverError } from '../../chatgpt/linux.js';
import { validateLinuxChatgptConfig } from '../../chatgptSetup/linuxProfile.js';
import type * as LinuxProfileModule from '../../chatgptSetup/linuxProfile.js';
import type {
  ComputerUseTelemetry,
  SemanticDesktopTelemetry,
} from '../../cowork/driver.js';

const clock = vi.hoisted(() => ({ now: 1000 }));
vi.mock('node:timers/promises', () => ({
  setTimeout: vi.fn(async (ms: number) => {
    clock.now += ms;
  }),
}));
vi.mock('./chatgptTrace.js', async (original) => ({
  ...(await original<typeof TraceModule>()),
  findChatgptTrace: vi.fn(),
}));
vi.mock('../../chatgpt/driver.js', async (original) => ({
  ...(await original<typeof DriverModule>()),
  submitChatgptQuery: vi.fn(),
}));
vi.mock('../../chatgpt/linux.js', async (original) => ({
  ...(await original<typeof LinuxModule>()),
  runLinuxChatgptDesktop: vi.fn(),
}));
// The platform adapter captures the validator at load, so wrap it here.
vi.mock('../../chatgptSetup/linuxProfile.js', async (original) => {
  const actual = await original<typeof LinuxProfileModule>();
  return {
    ...actual,
    validateLinuxChatgptConfig: vi.fn(actual.validateLinuxChatgptConfig),
  };
});

const capture = OPENAI_CHATGPT_CAPABILITIES.find(
  (capability) => capability.id === 'builtin:openai.chatgpt.nativeTrace'
)!.run!;

function context(
  home: string,
  linux: boolean,
  timeoutMs = 180_000
): ExternalHostCapabilityContext {
  const slug = `openai.chatgpt.agent.desktop-app.${linux ? 'linux' : 'macos'}`;
  const driver = normalizeHostDriver(slug);
  const context: ExternalHostCapabilityContext = {
    config: {
      driver,
      codexSetup: { servers: [] },
      options: { desktopEnvironment: linuxEnvironment(home) },
    },
    run: {
      runId: 'run',
      caseId: 'case',
      scenario: 'private prompt',
      submittedScenario: 'private prompt',
      marker: 'marker',
      correlation: {
        strategy: 'exact_prompt',
        marker: 'marker',
        includedInPrompt: false,
      },
      timeoutMs,
      startedAtMs: clock.now,
    },
    capability: 'trace',
    binding: { uses: 'builtin:openai.chatgpt.nativeTrace' },
    state: {
      driver,
      driverSlug: slug,
      displayName: 'ChatGPT',
      capabilitiesUsed: ['trace'],
      data: {},
    },
  };
  Object.assign(chatgptRunState(context.state), {
    sessionsRoot: join(home, '.codex', 'sessions'),
    evidenceDir: linux ? join(home, 'evidence') : undefined,
    baseline: new Map(),
    promptSubmitted: true,
    nativeController: linux
      ? {
          provider: 'linux-atspi',
          surface: 'chatgpt-work',
          submission: { status: 'completed' },
        }
      : undefined,
  } satisfies Partial<ChatgptRunState>);
  return context;
}

beforeEach(() => {
  clock.now = 1000;
  vi.spyOn(Date, 'now').mockImplementation(() => clock.now);
  vi.mocked(findChatgptTrace).mockReset();
  vi.mocked(findChatgptTrace).mockResolvedValue(undefined);
});
afterEach(() => vi.restoreAllMocks());

describe('bounded native binding wait and failure classification', () => {
  it('keeps Mac at 30s, gives Linux 120s, and never exceeds the run deadline', () => {
    const mac = context('/home/synthetic', false).config;
    const linux = context('/home/synthetic', true).config;
    expect(chatgptBindingDeadline(mac, 1000, 200_000)).toBe(31_000);
    expect(chatgptBindingDeadline(linux, 1000, 200_000)).toBe(121_000);
    expect(chatgptBindingDeadline(linux, 1000, 41_234)).toBe(41_234);
  });

  it.each([
    [true, 180_000, 120_000],
    [false, 180_000, 30_000],
    [true, 40_234, 40_234],
  ])(
    'classifies unbound sessions after bounded wait (linux=%s, timeout=%s)',
    async (linux, timeout, waited) => {
      const home = await mkdtemp(join(tmpdir(), 'chatgpt-wait-'));
      try {
        const ctx = context(home, linux, timeout);
        const root = chatgptRunState(ctx.state).sessionsRoot as string;
        await mkdir(root, { recursive: true });
        await mkdir(join(home, 'evidence'), { mode: 0o700 });
        await writeFile(
          join(root, 'rollout-unbound.jsonl'),
          JSON.stringify({
            type: 'session_meta',
            payload: {
              originator: 'unconfirmed-origin',
              id: 'private-session',
            },
          }) + '\n'
        );
        const result = await capture(ctx);
        expect(clock.now).toBe(1000 + waited);
        expect(result).toMatchObject({
          success: false,
          toolCalls: [],
          externalHost: {
            failureKind: 'no_matching_session',
            traceSource: 'none',
            traceConfidence: 'unknown',
            session: {},
          },
        });
        expect(result).not.toHaveProperty('response');
        if (!result) throw new Error('Missing result');
        // Unmatched sessions are never copied or referenced.
        expect(result.externalHost.artifacts).toEqual([]);
        expect(JSON.stringify(result.externalHost)).not.toContain(
          'private-session'
        );
        expect(findChatgptTrace).toHaveBeenCalledWith(
          root,
          chatgptRunState(ctx.state).baseline,
          { strategy: 'exact_prompt', prompt: 'private prompt' },
          1000,
          expect.objectContaining({
            requireFreshSession: true,
            surface: 'chatgpt-work',
          })
        );
      } finally {
        await rm(home, { recursive: true, force: true });
      }
    }
  );

  it.each([
    [true, undefined, 'codex_work_desktop'],
    [false, undefined, 'codex_work_desktop'],
    [true, 'chatgpt-work', 'codex_work_desktop'],
    [true, 'codex', 'Codex Desktop'],
    [false, 'codex', 'Codex Desktop'],
  ] as const)(
    'uses configured surface for real discovery (linux=%s surface=%s)',
    async (linux, surface, originator) => {
      const home = await mkdtemp(join(tmpdir(), 'chatgpt-origin-'));
      try {
        const actual =
          await vi.importActual<typeof TraceModule>('./chatgptTrace.js');
        vi.mocked(findChatgptTrace).mockImplementation(actual.findChatgptTrace);
        const ctx = context(home, linux);
        ctx.config.options!.surface = surface;
        const root = chatgptRunState(ctx.state).sessionsRoot as string;
        await mkdir(root, { recursive: true });
        await mkdir(join(home, 'evidence'), { mode: 0o700 });
        const records = [
          { type: 'session_meta', payload: { id: 'session', originator } },
          {
            type: 'turn_context',
            payload: { turn_id: 'turn', model: 'gpt-test', effort: 'medium' },
          },
          {
            type: 'event_msg',
            payload: {
              type: 'item_completed',
              turn_id: 'turn',
              item: {
                type: 'UserMessage',
                id: 'user',
                content: [{ text: 'private prompt\n' }],
              },
            },
          },
          {
            type: 'event_msg',
            payload: {
              type: 'task_complete',
              turn_id: 'turn',
              last_agent_message: 'done',
            },
          },
        ];
        await writeFile(
          join(root, 'rollout-complete.jsonl'),
          records
            .map((record) =>
              JSON.stringify({
                timestamp: new Date(1000).toISOString(),
                ...record,
              })
            )
            .join('\n') + '\n'
        );
        const result = await capture(ctx);
        expect(result).toMatchObject({
          success: true,
          response: 'done',
          externalHost: {
            traceSource: 'host-local-transcript',
            correlation: { nativePromptMatch: 'native_terminal_lf' },
          },
        });
        expect(findChatgptTrace).toHaveBeenCalledWith(
          root,
          chatgptRunState(ctx.state).baseline,
          { strategy: 'exact_prompt', prompt: 'private prompt' },
          1000,
          expect.objectContaining({
            surface: surface ?? 'chatgpt-work',
            requireFreshSession: true,
          })
        );
      } finally {
        await rm(home, { recursive: true, force: true });
      }
    }
  );

  it('binds the preserved Codex abort shape as host_run_failed, never completed success', async () => {
    const home = await mkdtemp(join(tmpdir(), 'chatgpt-codex-abort-'));
    try {
      const actual =
        await vi.importActual<typeof TraceModule>('./chatgptTrace.js');
      vi.mocked(findChatgptTrace).mockImplementation(actual.findChatgptTrace);
      clock.now = Date.parse('2026-09-23T15:34:00Z');
      const ctx = context(home, true);
      ctx.config.options!.surface = 'codex';
      ctx.config.model = 'gpt-5.6-terra';
      ctx.config.reasoningEffort = 'medium';
      ctx.run.scenario = ctx.run.submittedScenario = 'Find documents.';
      clock.now = Date.parse('2026-09-23T15:36:01Z');
      const root = chatgptRunState(ctx.state).sessionsRoot as string;
      await mkdir(root, { recursive: true });
      await mkdir(join(home, 'evidence'), { mode: 0o700 });
      const content = await readFile(
        new URL('./fixtures/codexDesktopAborted.jsonl', import.meta.url),
        'utf8'
      );
      await writeFile(join(root, 'rollout-aborted.jsonl'), content);
      const result = await capture(ctx);
      expect(result).toMatchObject({
        success: false,
        error: 'ChatGPT turn was aborted.',
        // Aborted turns keep partial native calls at low confidence; still failed.
        toolCalls: [
          { source: 'host', server: 'cua_repl', rawName: 'cua_repl.js' },
        ],
        externalHost: {
          failureKind: 'host_run_failed',
          traceSource: 'host-local-transcript',
          traceConfidence: 'low',
          telemetry: {
            hostToolCallCount: 1,
            toolProvenance: [expect.objectContaining({ pending: true })],
          },
          evidence: {
            finalAnswer: { source: 'none' },
            toolCalls: { confidence: 'low' },
          },
        },
      });
      expect(result).not.toHaveProperty('response');
      expect(findChatgptTrace).toHaveBeenCalledTimes(1);
      if (!result) throw new Error('Missing result');
      // The bound (aborted) transcript is preserved as evidence, not accepted.
      expect(result.externalHost.artifacts).toEqual([
        expect.objectContaining({
          kind: 'transcript',
          summary: expect.stringMatching(
            /^Bound turn .+; did not complete successfully; sha256=[a-f0-9]{64}$/
          ),
        }),
      ]);
      expect(
        await readFile(result.externalHost.artifacts[0]!.path!, 'utf8')
      ).toBe(content);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it('classifies an incomplete bound turn as timeout, not no matching session', async () => {
    const home = await mkdtemp(join(tmpdir(), 'chatgpt-bound-'));
    try {
      const ctx = context(home, true, 1500);
      vi.mocked(findChatgptTrace).mockResolvedValue({
        path: join(home, '.codex', 'sessions', 'rollout-bound.jsonl'),
        trace: {
          sessionId: 'session',
          turnId: 'turn',
          complete: false,
          toolCalls: [
            {
              source: 'mcp',
              server: 'glean-eval',
              name: 'search',
              arguments: {},
            },
          ],
          conversationHistory: [{ role: 'user', content: 'private prompt' }],
          usage: { inputTokens: 100, outputTokens: 10, durationMs: 400 },
          telemetry: { partial: true, mcpToolCallCount: 1 },
          limitations: [
            'Turn did not complete; tool calls and usage are partial.',
          ],
        },
      });
      const result = await capture(ctx);
      expect(result).toMatchObject({
        success: false,
        externalHost: {
          failureKind: 'timeout',
          traceConfidence: 'low',
          traceSource: 'host-local-transcript',
          session: { id: 'session', turnId: 'turn' },
          telemetry: { partial: true, mcpToolCallCount: 1 },
          traceLimitations: expect.arrayContaining([
            'Turn did not complete; tool calls and usage are partial.',
          ]),
          evidence: { usage: { confidence: 'low' } },
        },
        toolCalls: [{ source: 'mcp', server: 'glean-eval' }],
        usage: { inputTokens: 100, outputTokens: 10 },
        conversationHistory: [{ role: 'user' }],
      });
      expect(clock.now).toBe(2500);
      expect(result).not.toHaveProperty('response');
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  // Each rejection is what the trace reader throws for that condition; the
  // kind is carried by the error, never read from its wording.
  it.each(
    (
      [
        [
          new NativeTraceError(
            'ambiguous_matching_sessions',
            'Ambiguous matching ChatGPT sessions for this query.'
          ),
          'ambiguous_matching_sessions',
        ],
        [
          new Error(
            'ChatGPT submitted into an existing native session instead of a fresh chat.'
          ),
          'parse_failure',
        ],
        [
          new NativeTraceError(
            'host_run_failed',
            'Bound ChatGPT session/turn changed or no longer matches the query.'
          ),
          'host_run_failed',
        ],
        [
          new Error('Malformed complete JSONL record in ChatGPT transcript.'),
          'parse_failure',
        ],
        // An unclassified error is a parse failure whatever its message says.
        [
          new Error('Ambiguous: a model mismatch, fresh ChatGPT'),
          'parse_failure',
        ],
      ] satisfies Array<[Error, ExternalHostFailureKind]>
    ).map(([error, kind]) => [error.message, error, kind] as const)
  )('preserves failure classifier: %s', async (message, error, failureKind) => {
    const home = await mkdtemp(join(tmpdir(), 'chatgpt-classifier-'));
    try {
      vi.mocked(findChatgptTrace).mockRejectedValue(error);
      const result = await capture(context(home, true));
      expect(result).toMatchObject({
        success: false,
        error: message,
        externalHost: {
          failureKind,
          traceConfidence: 'unknown',
          traceSource: 'none',
        },
      });
      expect(clock.now).toBe(1000);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it('does not copy evidence without an MST-owned evidence directory', async () => {
    const home = await mkdtemp(join(tmpdir(), 'chatgpt-unattested-'));
    try {
      const ctx = context(home, true, 1);
      chatgptRunState(ctx.state).evidenceDir = undefined;
      const result = await capture(ctx);
      expect(result?.externalHost.artifacts).toEqual([]);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
});

function submitter(id: string) {
  return OPENAI_CHATGPT_CAPABILITIES.find((capability) => capability.id === id)!
    .run!;
}

function unsubmitted(linux: boolean): ExternalHostCapabilityContext {
  const ctx = context('/home/synthetic', linux);
  Object.assign(chatgptRunState(ctx.state), {
    promptSubmitted: false,
    nativeController: undefined,
  });
  return ctx;
}

const computerUseTelemetry: ComputerUseTelemetry = {
  accounting: 'complete',
  response_models: ['planner-model'],
  planner_response_count: 1,
  usage: {},
  usage_observation_counts: {
    input_tokens: 0,
    output_tokens: 0,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
  },
  duration_ms: 5,
  action_count: 1,
  attempted_action_count: 1,
  executed_action_count: 1,
  refused_action_count: 0,
  cost: { status: 'unavailable' },
};
const semanticTelemetry: SemanticDesktopTelemetry = {
  driver: 'linux-desktop',
  accounting: 'complete',
  duration_ms: 5,
  action_count: 1,
  planner: { status: 'not-applicable' },
  cost: { status: 'not-applicable' },
};

describe('submission is chosen by the platform, not the capability id', () => {
  it.each([
    'builtin:openai.chatgpt.computerUseSubmit',
    'builtin:openai.chatgpt.nativeSubmit',
  ])(
    'macOS submits with Computer Use through %s and records its receipt',
    async (id) => {
      vi.mocked(submitChatgptQuery).mockReset().mockResolvedValue({
        status: 'submitted',
        action_count: 1,
        model: 'planner-model',
        submission_action: {},
        telemetry: computerUseTelemetry,
      });
      vi.mocked(runLinuxChatgptDesktop).mockReset();
      const ctx = unsubmitted(false);
      await expect(submitter(id)(ctx)).resolves.toBeUndefined();
      expect(submitChatgptQuery).toHaveBeenCalledWith(
        'private prompt',
        ctx.config,
        ctx.run.startedAtMs + ctx.run.timeoutMs
      );
      expect(runLinuxChatgptDesktop).not.toHaveBeenCalled();
      expect(chatgptRunState(ctx.state)).toMatchObject({
        promptSubmitted: true,
        computerUse: {
          provider: 'anthropic-computer-use',
          submission: { status: 'completed', telemetry: computerUseTelemetry },
        },
      });
    }
  );

  it.each([
    'builtin:openai.chatgpt.computerUseSubmit',
    'builtin:openai.chatgpt.nativeSubmit',
  ])(
    'Linux submits natively through %s via the MST-owned session',
    async (id) => {
      vi.mocked(submitChatgptQuery).mockReset();
      vi.mocked(runLinuxChatgptDesktop)
        .mockReset()
        .mockResolvedValue({ telemetry: semanticTelemetry });
      const ctx = unsubmitted(true);
      const session = Object.create(
        ChatgptAppSession.prototype
      ) as ChatgptAppSession;
      session.openPrompt = vi.fn(async () => {});
      chatgptRunState(ctx.state).activeSession = session;
      await expect(submitter(id)(ctx)).resolves.toBeUndefined();
      expect(submitChatgptQuery).not.toHaveBeenCalled();
      const [mode, config, deadline, prompt, open] = vi.mocked(
        runLinuxChatgptDesktop
      ).mock.calls[0]!;
      expect([mode, config, deadline, prompt]).toEqual([
        'submit',
        ctx.config,
        ctx.run.startedAtMs + ctx.run.timeoutMs,
        'private prompt',
      ]);
      await open!('draft');
      expect(session.openPrompt).toHaveBeenCalledWith('draft');
      expect(chatgptRunState(ctx.state)).toMatchObject({
        promptSubmitted: true,
        nativeController: {
          provider: 'linux-atspi',
          surface: 'chatgpt-work',
          submission: { status: 'completed', telemetry: semanticTelemetry },
        },
      });
    }
  );

  it('fails Linux submission without an MST-owned session and never falls back to Computer Use', async () => {
    vi.mocked(submitChatgptQuery).mockReset();
    vi.mocked(runLinuxChatgptDesktop).mockReset();
    const ctx = unsubmitted(true);
    chatgptRunState(ctx.state).evidenceDir = undefined;
    const result = await submitter('builtin:openai.chatgpt.nativeSubmit')(ctx);
    expect(result).toMatchObject({
      success: false,
      error:
        'ChatGPT native submission failed: Linux ChatGPT requires its MST-owned app session.',
      externalHost: {
        failureKind: 'submission_failed',
        nativeController: {
          provider: 'linux-atspi',
          submission: { status: 'failed' },
        },
      },
    });
    expect(submitChatgptQuery).not.toHaveBeenCalled();
    expect(runLinuxChatgptDesktop).not.toHaveBeenCalled();
    expect(chatgptRunState(ctx.state).promptSubmitted).toBe(false);
  });

  it('records a failed macOS receipt without resubmitting', async () => {
    vi.mocked(submitChatgptQuery)
      .mockReset()
      .mockRejectedValue(new Error('planner refused'));
    const ctx = unsubmitted(false);
    const result = await submitter('builtin:openai.chatgpt.computerUseSubmit')(
      ctx
    );
    expect(submitChatgptQuery).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      success: false,
      error: 'ChatGPT Computer Use submission failed: planner refused',
      externalHost: { failureKind: 'submission_failed' },
    });
    expect(chatgptRunState(ctx.state)).toMatchObject({
      promptSubmitted: false,
      computerUse: {
        provider: 'anthropic-computer-use',
        submission: { status: 'failed' },
      },
    });
  });
});

function capabilityById(id: string) {
  const capability = OPENAI_CHATGPT_CAPABILITIES.find(
    (candidate) => candidate.id === id
  );
  if (!capability) throw new Error(`Unknown ChatGPT capability id: ${id}`);
  return capability;
}

describe('ChatGPT app session ownership', () => {
  const lifecycle = capabilityById('builtin:openai.chatgpt.appLifecycle');

  it('uses a shared batch session without disposing it', async () => {
    const shared = Object.create(
      ChatgptAppSession.prototype
    ) as ChatgptAppSession;
    shared.assertCompatible = vi.fn();
    shared.dispose = vi.fn(async () => {});
    shared.sessionsRoot = '/shared/sessions';
    shared.evidenceDir = '/shared/evidence';
    const ctx = unsubmitted(false);
    ctx.config.options = {
      ...ctx.config.options,
      managedChatgptSession: shared,
    };
    await expect(lifecycle.setup!(ctx)).resolves.toBeUndefined();
    const runState = chatgptRunState(ctx.state);
    expect(runState.activeSession).toBe(shared);
    expect(runState.ownedSession).toBeUndefined();
    expect(runState).toMatchObject({
      sessionsRoot: '/shared/sessions',
      evidenceDir: '/shared/evidence',
    });
    await lifecycle.teardown!(ctx);
    expect(shared.dispose).not.toHaveBeenCalled();
  });

  it('prepares, uses and disposes exactly once a session it creates', async () => {
    const prepare = vi
      .spyOn(ChatgptAppSession.prototype, 'prepare')
      .mockResolvedValue(undefined);
    const dispose = vi
      .spyOn(ChatgptAppSession.prototype, 'dispose')
      .mockResolvedValue(undefined);
    const ctx = unsubmitted(false);
    await expect(lifecycle.setup!(ctx)).resolves.toBeUndefined();
    const runState = chatgptRunState(ctx.state);
    expect(runState.ownedSession).toBeInstanceOf(ChatgptAppSession);
    expect(runState.activeSession).toBe(runState.ownedSession);
    expect(prepare).toHaveBeenCalledTimes(1);
    await lifecycle.teardown!(ctx);
    expect(dispose).toHaveBeenCalledTimes(1);
  });
});

describe('what the platform decides', () => {
  it('validates Linux-only settings on Linux and not on macOS', async () => {
    const preflight = capabilityById('builtin:openai.chatgpt.configLifecycle');
    vi.mocked(validateLinuxChatgptConfig).mockClear();
    await preflight.setup!(unsubmitted(false));
    expect(validateLinuxChatgptConfig).not.toHaveBeenCalled();
    const linux = unsubmitted(true);
    await preflight.setup!(linux);
    expect(validateLinuxChatgptConfig).toHaveBeenCalledWith(linux.config);
  });

  it.each([
    [false, false],
    [true, true],
  ])(
    'matches native transcripts with Markdown escapes only on Linux (linux=%s)',
    async (linux, escapes) => {
      vi.mocked(findChatgptTrace).mockClear();
      const ctx = context('/home/synthetic', linux, 2_000);
      chatgptRunState(ctx.state).evidenceDir = undefined;
      await capture(ctx);
      expect(vi.mocked(findChatgptTrace).mock.calls[0]![4]).toMatchObject({
        nativeMarkdownEscapes: escapes,
      });
    }
  );

  it('keeps the native failure diagnostics and evidence handling on a failed Linux submission', async () => {
    const draftState = {
      observedSurface: 'chatgpt-work',
      composerRootCount: 1,
      sendControlCount: 0,
      textReadable: true,
      textLength: 14,
    } as const;
    vi.mocked(runLinuxChatgptDesktop)
      .mockReset()
      .mockRejectedValue(
        new NativeChatgptDriverError('Send control missing.', {
          telemetry: semanticTelemetry,
          draftState,
        })
      );
    const ctx = unsubmitted(true);
    const session = Object.create(
      ChatgptAppSession.prototype
    ) as ChatgptAppSession;
    chatgptRunState(ctx.state).activeSession = session;
    // A missing evidence directory is reported, which shows evidence handling ran.
    chatgptRunState(ctx.state).evidenceDir = '/nonexistent/mst-evidence';
    const result = await capabilityById('builtin:openai.chatgpt.nativeSubmit')
      .run!(ctx);
    expect(result).toMatchObject({
      success: false,
      error: 'ChatGPT native submission failed: Send control missing.',
      externalHost: {
        failureKind: 'submission_failed',
        nativeController: {
          provider: 'linux-atspi',
          submission: {
            status: 'failed',
            telemetry: semanticTelemetry,
            draftState,
          },
        },
      },
    });
    expect(result!.externalHost.traceLimitations).toContain(
      'Native evidence directory is unavailable.'
    );
  });
});
