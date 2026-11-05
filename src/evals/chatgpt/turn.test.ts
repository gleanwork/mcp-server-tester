import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ExternalClientFailureKind } from '../clientTelemetryTypes.js';
import {
  findChatgptTrace,
  PendingChatgptRecordError,
  snapshotChatgptSessions,
} from './trace.js';
import type * as TraceModule from './trace.js';
import {
  captureChatgptTurn,
  chatgptBindingDeadline,
  chatgptTrial,
  checkChatgptSettings,
  runChatgptTurn,
  submitChatgptPrompt,
  useAppSession,
  type ChatgptTurnState,
} from './turn.js';
import type { ChatgptAppConfig } from './config.js';
import { linuxEnvironment } from './linuxEnvironment.fixture.js';
import { submitChatgptQuery } from './driver.js';
import type * as DriverModule from './driver.js';
import { runLinuxChatgptDesktop } from './linux.js';
import type * as LinuxModule from './linux.js';
import { ChatgptAppSession } from '../chatgptSetup/session.js';
import { NativeTraceError } from '../nativeTraceError.js';
import { NativeChatgptDriverError } from './linux.js';
import { validateLinuxChatgptConfig } from '../chatgptSetup/linuxProfile.js';
import type * as LinuxProfileModule from '../chatgptSetup/linuxProfile.js';
import { endingOf } from '../trialEnding.js';
import type {
  ComputerUseTelemetry,
  SemanticDesktopTelemetry,
} from '../cowork/driver.js';

const clock = vi.hoisted(() => ({ now: 1000 }));
vi.mock('node:timers/promises', () => ({
  setTimeout: vi.fn(async (ms: number) => {
    clock.now += ms;
  }),
}));
const screenshots = vi.hoisted(() => ({
  saveStallScreenshot: vi.fn(),
}));
vi.mock('./stallScreenshot.js', async (original) => ({
  ...(await original<object>()),
  saveStallScreenshot: screenshots.saveStallScreenshot,
}));
vi.mock('./trace.js', async (original) => ({
  ...(await original<typeof TraceModule>()),
  findChatgptTrace: vi.fn(),
  snapshotChatgptSessions: vi.fn(),
}));
vi.mock('./driver.js', async (original) => ({
  ...(await original<typeof DriverModule>()),
  submitChatgptQuery: vi.fn(),
}));
vi.mock('./linux.js', async (original) => ({
  ...(await original<typeof LinuxModule>()),
  runLinuxChatgptDesktop: vi.fn(),
}));
// The OS steps capture the validator at load, so wrap it here.
vi.mock('../chatgptSetup/linuxProfile.js', async (original) => {
  const actual = await original<typeof LinuxProfileModule>();
  return {
    ...actual,
    validateLinuxChatgptConfig: vi.fn(actual.validateLinuxChatgptConfig),
  };
});

function appConfig(home: string, linux: boolean): ChatgptAppConfig {
  return {
    os: linux ? 'linux' : 'darwin',
    codexSetup: { servers: [] },
    options: { desktopEnvironment: linuxEnvironment(home) },
  };
}

/** A trial whose prompt was submitted, ready for its turn to be captured. */
function turnState(
  home: string,
  linux: boolean,
  timeoutMs = 180_000
): ChatgptTurnState {
  return {
    config: appConfig(home, linux),
    trial: {
      caseId: 'case',
      input: 'private prompt',
      submittedInput: 'private prompt',
      marker: 'marker',
      correlation: {
        strategy: 'exact_prompt',
        marker: 'marker',
        includedInPrompt: false,
      },
      timeoutMs,
      startedAtMs: clock.now,
    },
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
  };
}

/** The same trial before its prompt was submitted. */
function unsubmitted(linux: boolean): ChatgptTurnState {
  return {
    ...turnState('/home/synthetic', linux),
    promptSubmitted: false,
    nativeController: undefined,
  };
}

/** A batch app session that holds no app: only what a trial reads. */
function fakeSession(
  overrides: Partial<ChatgptAppSession> = {}
): ChatgptAppSession {
  const session = Object.create(
    ChatgptAppSession.prototype
  ) as ChatgptAppSession;
  return Object.assign(session, {
    assertCompatible: vi.fn(),
    noteSubmission: vi.fn(),
    openPrompt: vi.fn(async () => {}),
    dispose: vi.fn(async () => {}),
    ...overrides,
  });
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

beforeEach(() => {
  clock.now = 1000;
  vi.spyOn(Date, 'now').mockImplementation(() => clock.now);
  vi.mocked(findChatgptTrace).mockReset().mockResolvedValue(undefined);
  vi.mocked(snapshotChatgptSessions).mockReset().mockResolvedValue(new Map());
  vi.mocked(submitChatgptQuery).mockReset();
  vi.mocked(runLinuxChatgptDesktop).mockReset();
  screenshots.saveStallScreenshot
    .mockReset()
    .mockResolvedValue({ error: 'no display in unit tests' });
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe('the trial prompt and its correlation', () => {
  it('matches the exact prompt by default and keeps it byte-for-byte', () => {
    const input = '  snake_case\\value\nUnicode α  ';
    const trial = chatgptTrial(input, { os: 'darwin' }, 'case');
    expect(trial.submittedInput).toBe(input);
    expect(trial.correlation).toEqual({
      strategy: 'exact_prompt',
      marker: trial.marker,
      includedInPrompt: false,
    });
  });

  it('adds a marker with an instruction not to mention it when asked', () => {
    const trial = chatgptTrial(
      'Reply with exactly: acknowledged.',
      { os: 'darwin', correlation: { strategy: 'prompt_marker' } },
      'case'
    );
    expect(trial.correlation.includedInPrompt).toBe(true);
    expect(trial.submittedInput).toContain('Reply with exactly: acknowledged.');
    expect(trial.submittedInput).toContain(`[eval-run-marker:${trial.marker}]`);
    expect(trial.submittedInput).toContain('do not mention this marker');
  });

  it('gives each trial its own marker', () => {
    const config: ChatgptAppConfig = { os: 'darwin' };
    expect(chatgptTrial('q', config, 'a').marker).not.toBe(
      chatgptTrial('q', config, 'a').marker
    );
  });

  it.each([
    [{ strategy: 'prompt_marker', includeInPrompt: false }],
    [{ strategy: 'none' }],
  ] as const)('leaves the prompt unchanged for %j', (correlation) => {
    const trial = chatgptTrial(
      'Reply with exactly: acknowledged.',
      { os: 'darwin', correlation },
      'case'
    );
    expect(trial.submittedInput).toBe('Reply with exactly: acknowledged.');
    expect(trial.correlation.includedInPrompt).toBe(false);
  });
});

describe('one trial, in order', () => {
  const answered = {
    path: '/sessions/rollout.jsonl',
    trace: {
      sessionId: 'session',
      turnId: 'turn',
      model: 'gpt-test',
      complete: true,
      response: 'native answer',
      toolCalls: [],
      conversationHistory: [],
      telemetry: {},
      limitations: [],
    },
  };

  beforeEach(() => {
    vi.stubEnv('ANTHROPIC_API_KEY', 'test-planner-key');
  });

  it('checks settings, uses the session, snapshots, submits once and captures', async () => {
    const session = fakeSession({ sessionsRoot: '/sessions' });
    vi.mocked(submitChatgptQuery).mockResolvedValue({
      status: 'submitted',
      action_count: 1,
      model: 'planner-model',
      submission_action: {},
      telemetry: computerUseTelemetry,
    });
    vi.mocked(findChatgptTrace).mockResolvedValue(answered);
    const config: ChatgptAppConfig = { os: 'darwin', model: 'gpt-test' };
    const turn = await runChatgptTurn('private prompt', config, session, {
      caseId: 'one',
    });
    expect(turn).toMatchObject({
      success: true,
      response: 'native answer',
      clientMetadata: {
        traceSource: 'client-local-transcript',
        session: { id: 'session', turnId: 'turn' },
        computerUse: { submission: { status: 'completed' } },
      },
    });
    const order = [
      vi.mocked(session.assertCompatible).mock.invocationCallOrder[0]!,
      vi.mocked(snapshotChatgptSessions).mock.invocationCallOrder[0]!,
      vi.mocked(submitChatgptQuery).mock.invocationCallOrder[0]!,
      vi.mocked(findChatgptTrace).mock.invocationCallOrder[0]!,
    ];
    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect(submitChatgptQuery).toHaveBeenCalledTimes(1);
    expect(snapshotChatgptSessions).toHaveBeenCalledWith('/sessions');
    expect(session.noteSubmission).toHaveBeenCalledWith('private prompt');
    // The trial doesn't own the batch's app.
    expect(session.dispose).not.toHaveBeenCalled();
  });

  it('records no driver identity or capability bindings (decision C)', async () => {
    vi.mocked(submitChatgptQuery).mockResolvedValue({
      status: 'submitted',
      action_count: 1,
      model: 'planner-model',
      submission_action: {},
      telemetry: computerUseTelemetry,
    });
    vi.mocked(findChatgptTrace).mockResolvedValue(answered);
    const completed = await runChatgptTurn(
      'private prompt',
      { os: 'darwin' },
      fakeSession({ sessionsRoot: '/sessions' })
    );
    const failed = await runChatgptTurn(
      'private prompt',
      { os: 'darwin', correlation: { strategy: 'none' } },
      fakeSession()
    );
    for (const turn of [completed, failed])
      for (const field of [
        'driver',
        'driverSlug',
        'capabilitiesUsed',
        'displayName',
        'clientName',
        'clientType',
        'clientVariant',
      ])
        expect(turn.clientMetadata).not.toHaveProperty(field);
  });

  it('sends nothing and leaves the session alone when the settings are rejected', async () => {
    const session = fakeSession();
    const turn = await runChatgptTurn(
      'private prompt',
      { os: 'darwin', correlation: { strategy: 'client_session_metadata' } },
      session
    );
    expect(turn).toMatchObject({
      success: false,
      error:
        'ChatGPT requires exact_prompt or an included prompt_marker; uncorrelated telemetry is not supported.',
      clientMetadata: {
        failureKind: 'submission_failed',
        traceLimitations: [
          'Preflight failed before application or configuration changes.',
        ],
      },
    });
    expect(session.assertCompatible).not.toHaveBeenCalled();
    expect(snapshotChatgptSessions).not.toHaveBeenCalled();
    expect(submitChatgptQuery).not.toHaveBeenCalled();
  });

  it('fails as app_unavailable, sending nothing, when the batch session has other settings', async () => {
    const session = fakeSession({
      assertCompatible: vi.fn(() => {
        throw new Error(
          'ChatGPT batch app session is unavailable or has different settings.'
        );
      }),
    });
    const turn = await runChatgptTurn(
      'private prompt',
      { os: 'darwin' },
      session
    );
    expect(turn).toMatchObject({
      success: false,
      error:
        'Failed to prepare ChatGPT desktop app: ChatGPT batch app session is unavailable or has different settings.',
      clientMetadata: { failureKind: 'app_unavailable' },
    });
    expect(snapshotChatgptSessions).not.toHaveBeenCalled();
    expect(submitChatgptQuery).not.toHaveBeenCalled();
    expect(endingOf(turn)).toEqual({
      kind: 'infrastructure',
      broke: 'client-app',
      retryable: true,
      reason: turn.success ? undefined : turn.error,
    });
  });

  it('fails a step that throws as client_run_failed, without submitting', async () => {
    vi.mocked(snapshotChatgptSessions).mockRejectedValue(
      new Error('sessions unreadable')
    );
    const turn = await runChatgptTurn(
      'private prompt',
      { os: 'darwin' },
      fakeSession({ sessionsRoot: '/sessions' })
    );
    expect(turn).toMatchObject({
      success: false,
      error: 'ChatGPT trial failed: sessions unreadable',
      clientMetadata: { failureKind: 'client_run_failed' },
    });
    expect(submitChatgptQuery).not.toHaveBeenCalled();
    expect(endingOf(turn)).toMatchObject({
      kind: 'infrastructure',
      broke: 'client-app',
      retryable: true,
    });
  });

  it.each([
    ['no_matching_session', 'client-app', true],
    ['timeout', 'deadline', true],
    ['parse_failure', 'client-app', true],
    ['ambiguous_matching_sessions', 'client-app', true],
    ['submission_failed', 'client-app', true],
  ] as const)(
    'ends a %s turn as %s (ADR 0010)',
    (failureKind, broke, retryable) => {
      expect(
        endingOf({ error: 'failed', clientMetadata: { failureKind } })
      ).toEqual({ kind: 'infrastructure', broke, retryable, reason: 'failed' });
    }
  );
});

describe('bounded native binding wait and failure classification', () => {
  it('keeps Mac at 30s, gives Linux 120s, and never exceeds the run deadline', () => {
    const mac = appConfig('/home/synthetic', false);
    const linux = appConfig('/home/synthetic', true);
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
        const state = turnState(home, linux, timeout);
        const root = state.sessionsRoot as string;
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
        const result = await captureChatgptTurn(state);
        expect(clock.now).toBe(1000 + waited);
        expect(result).toMatchObject({
          success: false,
          toolCalls: [],
          clientMetadata: {
            failureKind: 'no_matching_session',
            traceSource: 'none',
            traceConfidence: 'unknown',
            session: {},
          },
        });
        expect(result).not.toHaveProperty('response');
        // Unmatched sessions are never copied or referenced.
        expect(result.clientMetadata.artifacts).toEqual([]);
        expect(JSON.stringify(result.clientMetadata)).not.toContain(
          'private-session'
        );
        expect(findChatgptTrace).toHaveBeenCalledWith(
          root,
          state.baseline,
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

  it('preserves a binding-timeout screenshot without promoting it to native evidence', async () => {
    const home = await mkdtemp(join(tmpdir(), 'chatgpt-binding-display-'));
    try {
      const state = turnState(home, true, 1000);
      screenshots.saveStallScreenshot.mockResolvedValue({
        path: join(home, 'timeout.png'),
      });
      const result = await captureChatgptTurn(state);
      expect(result).toMatchObject({
        success: false,
        clientMetadata: {
          failureKind: 'no_matching_session',
          traceSource: 'none',
          traceConfidence: 'unknown',
          artifacts: [expect.objectContaining({ kind: 'screenshot' })],
        },
      });
      expect(runLinuxChatgptDesktop).not.toHaveBeenCalled();
      expect(submitChatgptQuery).not.toHaveBeenCalled();
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

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
        const actual = await vi.importActual<typeof TraceModule>('./trace.js');
        vi.mocked(findChatgptTrace).mockImplementation(actual.findChatgptTrace);
        const state = turnState(home, linux);
        state.config.options!.surface = surface;
        const root = state.sessionsRoot as string;
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
        const result = await captureChatgptTurn(state);
        expect(result).toMatchObject({
          success: true,
          response: 'done',
          clientMetadata: {
            traceSource: 'client-local-transcript',
            correlation: { nativePromptMatch: 'native_terminal_lf' },
          },
        });
        expect(findChatgptTrace).toHaveBeenCalledWith(
          root,
          state.baseline,
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

  it.each([
    ['model', { model: 'gpt-other' }, 'ChatGPT model mismatch'],
    [
      'reasoning effort',
      { reasoningEffort: 'high' as const },
      'ChatGPT reasoning effort mismatch',
    ],
  ])(
    'fails a completed turn recorded with another %s as client_run_failed',
    async (_what, requested, message) => {
      vi.mocked(findChatgptTrace).mockResolvedValue({
        path: '/home/synthetic/.codex/sessions/rollout.jsonl',
        trace: {
          sessionId: 'session',
          turnId: 'turn',
          model: 'gpt-test',
          reasoningEffort: 'medium',
          complete: true,
          response: 'answer',
          toolCalls: [],
          conversationHistory: [],
          telemetry: {},
          limitations: [],
        },
      });
      const state = turnState('/home/synthetic', false, 2000);
      Object.assign(state.config, requested);
      const result = await captureChatgptTurn(state);
      expect(result).toMatchObject({
        success: false,
        error: expect.stringContaining(message),
        clientMetadata: {
          failureKind: 'client_run_failed',
          traceSource: 'none',
        },
      });
      expect(result).not.toHaveProperty('response');
    }
  );

  it('binds the preserved Codex abort shape as client_run_failed, never completed success', async () => {
    const home = await mkdtemp(join(tmpdir(), 'chatgpt-codex-abort-'));
    try {
      const actual = await vi.importActual<typeof TraceModule>('./trace.js');
      vi.mocked(findChatgptTrace).mockImplementation(actual.findChatgptTrace);
      clock.now = Date.parse('2026-09-23T15:34:00Z');
      const state = turnState(home, true);
      state.config.options!.surface = 'codex';
      state.config.model = 'gpt-5.6-terra';
      state.config.reasoningEffort = 'medium';
      state.trial.input = state.trial.submittedInput = 'Find documents.';
      clock.now = Date.parse('2026-09-23T15:36:01Z');
      const root = state.sessionsRoot as string;
      await mkdir(root, { recursive: true });
      await mkdir(join(home, 'evidence'), { mode: 0o700 });
      const content = await readFile(
        new URL('./fixtures/codexDesktopAborted.jsonl', import.meta.url),
        'utf8'
      );
      await writeFile(join(root, 'rollout-aborted.jsonl'), content);
      const result = await captureChatgptTurn(state);
      expect(result).toMatchObject({
        success: false,
        error: 'ChatGPT turn was aborted.',
        // Aborted turns keep partial native calls at low confidence; still failed.
        toolCalls: [
          { source: 'builtin', server: 'cua_repl', rawName: 'cua_repl.js' },
        ],
        clientMetadata: {
          failureKind: 'client_run_failed',
          traceSource: 'client-local-transcript',
          traceConfidence: 'low',
          telemetry: {
            builtinToolCallCount: 1,
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
      // The bound (aborted) transcript is preserved as evidence, not accepted.
      expect(result.clientMetadata.artifacts).toEqual([
        expect.objectContaining({
          kind: 'transcript',
          summary: expect.stringMatching(
            /^Bound turn .+; did not complete successfully; sha256=[a-f0-9]{64}$/
          ),
        }),
      ]);
      expect(
        await readFile(result.clientMetadata.artifacts[0]!.path!, 'utf8')
      ).toBe(content);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it('classifies an incomplete bound turn as timeout, not no matching session', async () => {
    const home = await mkdtemp(join(tmpdir(), 'chatgpt-bound-'));
    try {
      const state = turnState(home, true, 1500);
      vi.mocked(findChatgptTrace).mockResolvedValue({
        path: join(home, '.codex', 'sessions', 'rollout-bound.jsonl'),
        trace: {
          sessionId: 'session',
          turnId: 'turn',
          complete: false,
          toolCalls: [
            {
              source: 'mcp',
              server: 'acme-eval',
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
      const result = await captureChatgptTurn(state);
      expect(result).toMatchObject({
        success: false,
        clientMetadata: {
          failureKind: 'timeout',
          traceConfidence: 'low',
          traceSource: 'client-local-transcript',
          session: { id: 'session', turnId: 'turn' },
          telemetry: { partial: true, mcpToolCallCount: 1 },
          traceLimitations: expect.arrayContaining([
            'Turn did not complete; tool calls and usage are partial.',
          ]),
          evidence: { usage: { confidence: 'low' } },
        },
        toolCalls: [{ source: 'mcp', server: 'acme-eval' }],
        usage: { inputTokens: 100, outputTokens: 10 },
        conversationHistory: [{ role: 'user' }],
      });
      expect(clock.now).toBe(2500);
      expect(result).not.toHaveProperty('response');
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it('fails a silent turn after 120s and saves a display screenshot', async () => {
    const home = await mkdtemp(join(tmpdir(), 'chatgpt-stall-'));
    try {
      const state = turnState(home, true, 900_000);
      const sessions = join(home, '.codex', 'sessions');
      await mkdir(sessions, { recursive: true });
      const path = join(sessions, 'rollout-stall.jsonl');
      await writeFile(path, '{"type":"session_meta"}\n');
      screenshots.saveStallScreenshot.mockResolvedValue({
        path: join(home, 'evidence', 'case-stall-x', 'stall-screenshot.png'),
      });
      vi.mocked(findChatgptTrace).mockResolvedValue({
        path,
        trace: {
          sessionId: 'session',
          turnId: 'turn',
          complete: false,
          toolCalls: [],
          conversationHistory: [{ role: 'user', content: 'private prompt' }],
          telemetry: { partial: true },
          limitations: [],
        },
      });
      const result = await captureChatgptTurn(state);
      expect(result).toMatchObject({
        success: false,
        error: expect.stringContaining('stalled'),
        clientMetadata: {
          failureKind: 'timeout',
          artifacts: expect.arrayContaining([
            expect.objectContaining({
              kind: 'screenshot',
              contentType: 'image/png',
            }),
          ]),
        },
      });
      // Stops at the 120s silence limit, not the 900s case timeout.
      expect(clock.now - 1000).toBeGreaterThanOrEqual(120_000);
      expect(clock.now - 1000).toBeLessThan(125_000);
      expect(screenshots.saveStallScreenshot).toHaveBeenCalledOnce();
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it('keeps waiting while the transcript keeps growing', async () => {
    const home = await mkdtemp(join(tmpdir(), 'chatgpt-progress-'));
    try {
      const state = turnState(home, true, 300_000);
      const sessions = join(home, '.codex', 'sessions');
      await mkdir(sessions, { recursive: true });
      const path = join(sessions, 'rollout-progress.jsonl');
      await writeFile(path, 'x');
      let polls = 0;
      vi.mocked(findChatgptTrace).mockImplementation(async () => {
        polls += 1;
        // Grow the file every ~60s of simulated time: never silent for 120s.
        if (polls % 80 === 0) await writeFile(path, 'x'.repeat(polls));
        return {
          path,
          trace: {
            sessionId: 'session',
            turnId: 'turn',
            complete: false,
            toolCalls: [],
            conversationHistory: [],
            telemetry: { partial: true },
            limitations: [],
          },
        };
      });
      const result = await captureChatgptTurn(state);
      expect(result).toMatchObject({
        error: 'Timed out waiting for the native ChatGPT turn to complete.',
      });
      expect(screenshots.saveStallScreenshot).not.toHaveBeenCalled();
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it('polls an unfinished native rewrite without resubmitting and stays bounded', async () => {
    const home = await mkdtemp(join(tmpdir(), 'chatgpt-rewrite-'));
    try {
      const state = turnState(home, true, 3000);
      await mkdir(join(home, 'evidence'), { recursive: true });
      screenshots.saveStallScreenshot.mockResolvedValue({
        path: join(home, 'timeout.png'),
      });
      vi.mocked(findChatgptTrace).mockRejectedValue(
        new PendingChatgptRecordError()
      );
      const result = await captureChatgptTurn(state);
      // The display is kept, as for any binding timeout.
      expect(screenshots.saveStallScreenshot).toHaveBeenCalledOnce();
      // A rewrite that never finishes is a transcript failure, not a lost
      // submission (no_matching_session).
      expect(result).toMatchObject({
        success: false,
        error: expect.stringContaining('binding deadline'),
        clientMetadata: {
          failureKind: 'parse_failure',
          traceConfidence: 'unknown',
        },
      });
      expect(clock.now).toBe(4000);
      expect(runLinuxChatgptDesktop).not.toHaveBeenCalled();
      expect(submitChatgptQuery).not.toHaveBeenCalled();
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it('measures a bound turn’s unfinished rewrite from when it bound', async () => {
    const home = await mkdtemp(join(tmpdir(), 'chatgpt-rewrite-bound-late-'));
    try {
      const state = turnState(home, false, 60_000);
      const root = state.sessionsRoot as string;
      await mkdir(root, { recursive: true });
      const path = join(root, 'rollout.jsonl');
      await writeFile(path, 'fixture native transcript');
      const start = state.trial.startedAtMs;
      // Binds at +29s; a rewrite is then pending from +31s to the end: most
      // of the bound wait, though under half of the whole run.
      vi.mocked(findChatgptTrace).mockImplementation(async () => {
        if (clock.now < start + 29_000) return undefined;
        if (clock.now >= start + 31_000) throw new PendingChatgptRecordError();
        return {
          path,
          trace: {
            sessionId: 'session',
            turnId: 'turn',
            complete: false,
            toolCalls: [],
            conversationHistory: [],
            telemetry: {},
            limitations: [],
          },
        };
      });
      const result = await captureChatgptTurn(state);
      expect(result).toMatchObject({
        success: false,
        clientMetadata: {
          failureKind: 'parse_failure',
          traceConfidence: 'low',
        },
      });
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it('measures an unfinished rewrite against the collection wait, not setup time', async () => {
    const home = await mkdtemp(join(tmpdir(), 'chatgpt-rewrite-setup-'));
    try {
      const state = turnState(home, true, 4000);
      // Setup and submission took most of the run's time.
      clock.now += 2500;
      vi.mocked(findChatgptTrace).mockRejectedValue(
        new PendingChatgptRecordError()
      );
      const result = await captureChatgptTurn(state);
      expect(result).toMatchObject({
        success: false,
        clientMetadata: { failureKind: 'parse_failure' },
      });
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it.each([
    ['bound', 'timeout', 3000],
    ['unbound', 'no_matching_session', 3000],
    // Short enough that one final-poll read is half the wait.
    ['bound', 'timeout', 1500],
    ['unbound', 'no_matching_session', 1500],
  ] as const)(
    'treats a rewrite caught only on the last poll as an ordinary %s timeout (%s, %ims)',
    async (bindState, failureKind, timeoutMs) => {
      const home = await mkdtemp(join(tmpdir(), 'chatgpt-late-rewrite-'));
      try {
        const state = turnState(home, true, timeoutMs);
        const root = state.sessionsRoot as string;
        await mkdir(root, { recursive: true });
        await mkdir(join(home, 'evidence'), { recursive: true });
        const path = join(root, 'rollout.jsonl');
        await writeFile(path, 'fixture native transcript');
        screenshots.saveStallScreenshot.mockResolvedValue({
          path: join(home, 'timeout.png'),
        });
        const end = state.trial.startedAtMs + state.trial.timeoutMs;
        vi.mocked(findChatgptTrace).mockImplementation(async () => {
          if (clock.now >= end - 800) throw new PendingChatgptRecordError();
          return bindState === 'bound'
            ? {
                path,
                trace: {
                  sessionId: 'session',
                  turnId: 'turn',
                  complete: false,
                  toolCalls: [],
                  conversationHistory: [],
                  telemetry: {},
                  limitations: [],
                },
              }
            : undefined;
        });
        const result = await captureChatgptTurn(state);
        expect(result).toMatchObject({
          success: false,
          clientMetadata: { failureKind },
        });
        if (bindState === 'unbound')
          expect(screenshots.saveStallScreenshot).toHaveBeenCalledOnce();
      } finally {
        await rm(home, { recursive: true, force: true });
      }
    }
  );

  it('keeps the bound turn when a rewrite after binding never finishes', async () => {
    const home = await mkdtemp(join(tmpdir(), 'chatgpt-rewrite-bound-'));
    try {
      const state = turnState(home, true, 900_000);
      const root = state.sessionsRoot as string;
      await mkdir(root, { recursive: true });
      const path = join(root, 'rollout.jsonl');
      await writeFile(path, 'fixture native transcript');
      const call = {
        id: 'call',
        name: 'search',
        server: 'acme-eval',
        source: 'mcp' as const,
        arguments: { query: 'q' },
      };
      vi.mocked(findChatgptTrace)
        .mockResolvedValueOnce({
          path,
          trace: {
            sessionId: 'session',
            turnId: 'turn',
            complete: false,
            toolCalls: [call],
            conversationHistory: [],
            telemetry: {},
            limitations: [],
          },
        })
        .mockRejectedValue(new PendingChatgptRecordError());
      const result = await captureChatgptTurn(state);
      expect(result).toMatchObject({
        success: false,
        error: expect.stringContaining('stall deadline'),
        toolCalls: [call],
        clientMetadata: {
          failureKind: 'parse_failure',
          traceConfidence: 'low',
        },
      });
      // Stops at the 120s stall limit, not the 900s case timeout.
      expect(clock.now - 1000).toBeGreaterThanOrEqual(120_000);
      expect(clock.now - 1000).toBeLessThan(125_000);
      expect(submitChatgptQuery).not.toHaveBeenCalled();
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it('accepts only the complete validated rewrite after a transient partial read', async () => {
    const home = await mkdtemp(join(tmpdir(), 'chatgpt-rewritten-'));
    try {
      const state = turnState(home, true, 3000);
      const root = state.sessionsRoot as string;
      await mkdir(root, { recursive: true });
      await mkdir(join(home, 'evidence'));
      const path = join(root, 'rollout.jsonl');
      await writeFile(path, 'fixture native transcript');
      vi.mocked(findChatgptTrace)
        .mockRejectedValueOnce(new PendingChatgptRecordError())
        .mockResolvedValue({
          path,
          trace: {
            sessionId: 'session',
            turnId: 'turn',
            complete: true,
            response: 'fixture answer',
            toolCalls: [],
            conversationHistory: [],
            telemetry: {},
            limitations: [],
          },
        });
      const result = await captureChatgptTurn(state);
      expect(result).toMatchObject({ success: true });
      expect(findChatgptTrace).toHaveBeenCalledTimes(2);
      expect(runLinuxChatgptDesktop).not.toHaveBeenCalled();
      expect(submitChatgptQuery).not.toHaveBeenCalled();
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
            'client_run_failed',
            'Bound ChatGPT session/turn changed or no longer matches the query.'
          ),
          'client_run_failed',
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
      ] satisfies Array<[Error, ExternalClientFailureKind]>
    ).map(([error, kind]) => [error.message, error, kind] as const)
  )('preserves failure classifier: %s', async (message, error, failureKind) => {
    const home = await mkdtemp(join(tmpdir(), 'chatgpt-classifier-'));
    try {
      vi.mocked(findChatgptTrace).mockRejectedValue(error);
      const result = await captureChatgptTurn(turnState(home, true));
      expect(result).toMatchObject({
        success: false,
        error: message,
        clientMetadata: {
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
      const state = turnState(home, true, 1);
      state.evidenceDir = undefined;
      const result = await captureChatgptTurn(state);
      expect(result.clientMetadata.artifacts).toEqual([]);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
});

describe('submission follows the trial OS', () => {
  it('macOS submits with Computer Use and records its receipt', async () => {
    vi.mocked(submitChatgptQuery).mockResolvedValue({
      status: 'submitted',
      action_count: 1,
      model: 'planner-model',
      submission_action: {},
      telemetry: computerUseTelemetry,
    });
    const state = unsubmitted(false);
    await expect(submitChatgptPrompt(state)).resolves.toBeUndefined();
    expect(submitChatgptQuery).toHaveBeenCalledWith(
      'private prompt',
      state.config,
      state.trial.startedAtMs + state.trial.timeoutMs,
      undefined
    );
    expect(runLinuxChatgptDesktop).not.toHaveBeenCalled();
    expect(state).toMatchObject({
      promptSubmitted: true,
      computerUse: {
        provider: 'anthropic-computer-use',
        submission: { status: 'completed', telemetry: computerUseTelemetry },
      },
    });
  });

  it('Linux submits natively via the MST-owned session', async () => {
    vi.mocked(runLinuxChatgptDesktop).mockResolvedValue({
      telemetry: semanticTelemetry,
    });
    const state = unsubmitted(true);
    const session = fakeSession();
    state.session = session;
    await expect(submitChatgptPrompt(state)).resolves.toBeUndefined();
    expect(submitChatgptQuery).not.toHaveBeenCalled();
    const [mode, config, deadline, prompt, open] = vi.mocked(
      runLinuxChatgptDesktop
    ).mock.calls[0]!;
    expect([mode, config, deadline, prompt]).toEqual([
      'submit',
      state.config,
      state.trial.startedAtMs + state.trial.timeoutMs,
      'private prompt',
    ]);
    await open!('draft');
    expect(session.openPrompt).toHaveBeenCalledWith('draft');
    expect(state).toMatchObject({
      promptSubmitted: true,
      nativeController: {
        provider: 'linux-atspi',
        surface: 'chatgpt-work',
        submission: { status: 'completed', telemetry: semanticTelemetry },
      },
    });
  });

  it('fails Linux submission without an MST-owned session and never falls back to Computer Use', async () => {
    const state = unsubmitted(true);
    state.evidenceDir = undefined;
    const result = await submitChatgptPrompt(state);
    expect(result).toMatchObject({
      success: false,
      error:
        'ChatGPT native submission failed: Linux ChatGPT requires its MST-owned app session.',
      clientMetadata: {
        failureKind: 'submission_failed',
        nativeController: {
          provider: 'linux-atspi',
          submission: { status: 'failed' },
        },
      },
    });
    expect(submitChatgptQuery).not.toHaveBeenCalled();
    expect(runLinuxChatgptDesktop).not.toHaveBeenCalled();
    expect(state.promptSubmitted).toBe(false);
  });

  it('records a failed macOS receipt without resubmitting', async () => {
    vi.mocked(submitChatgptQuery).mockRejectedValue(
      new Error('planner refused')
    );
    const state = unsubmitted(false);
    const result = await submitChatgptPrompt(state);
    expect(submitChatgptQuery).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      success: false,
      error: 'ChatGPT Computer Use submission failed: planner refused',
      clientMetadata: { failureKind: 'submission_failed' },
    });
    expect(state).toMatchObject({
      promptSubmitted: false,
      computerUse: {
        provider: 'anthropic-computer-use',
        submission: { status: 'failed' },
      },
    });
  });

  it('does not capture after a failed submission: the turn ends there', async () => {
    vi.stubEnv('ANTHROPIC_API_KEY', 'test-planner-key');
    vi.mocked(submitChatgptQuery).mockRejectedValue(
      new Error('planner refused')
    );
    const turn = await runChatgptTurn(
      'private prompt',
      { os: 'darwin' },
      fakeSession({ sessionsRoot: '/sessions' })
    );
    expect(turn).toMatchObject({
      success: false,
      clientMetadata: { failureKind: 'submission_failed' },
    });
    expect(submitChatgptQuery).toHaveBeenCalledTimes(1);
    expect(findChatgptTrace).not.toHaveBeenCalled();
  });
});

describe('the batch app session', () => {
  it('uses the batch session without disposing it', () => {
    const shared = fakeSession({
      sessionsRoot: '/shared/sessions',
      evidenceDir: '/shared/evidence',
    });
    const state = unsubmitted(false);
    state.sessionsRoot = undefined;
    state.configName = 'selected';
    expect(useAppSession(state, shared)).toBeUndefined();
    expect(shared.assertCompatible).toHaveBeenCalledWith(state.config, {
      configName: 'selected',
    });
    expect(state).toMatchObject({
      session: shared,
      sessionsRoot: '/shared/sessions',
      evidenceDir: '/shared/evidence',
    });
    expect(shared.dispose).not.toHaveBeenCalled();
  });
});

describe('what the trial OS decides', () => {
  it('validates Linux-only settings on Linux and not on macOS', () => {
    vi.stubEnv('ANTHROPIC_API_KEY', 'test-planner-key');
    vi.mocked(validateLinuxChatgptConfig).mockClear();
    checkChatgptSettings(unsubmitted(false));
    expect(validateLinuxChatgptConfig).not.toHaveBeenCalled();
    const linux = unsubmitted(true);
    checkChatgptSettings(linux);
    expect(validateLinuxChatgptConfig).toHaveBeenCalledWith(linux.config);
  });

  it.each([
    [false, false],
    [true, true],
  ])(
    'matches native transcripts with Markdown escapes only on Linux (linux=%s)',
    async (linux, escapes) => {
      const state = turnState('/home/synthetic', linux, 2_000);
      state.evidenceDir = undefined;
      await captureChatgptTurn(state);
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
    vi.mocked(runLinuxChatgptDesktop).mockRejectedValue(
      new NativeChatgptDriverError('Send control missing.', {
        telemetry: semanticTelemetry,
        draftState,
      })
    );
    const state = unsubmitted(true);
    state.session = fakeSession();
    // A missing evidence directory is reported, which shows evidence handling ran.
    state.evidenceDir = '/nonexistent/mst-evidence';
    const result = await submitChatgptPrompt(state);
    expect(result).toMatchObject({
      success: false,
      error: 'ChatGPT native submission failed: Send control missing.',
      clientMetadata: {
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
    expect(screenshots.saveStallScreenshot).toHaveBeenCalledWith(
      expect.objectContaining({ label: 'submit' })
    );
    expect(result!.clientMetadata.traceLimitations).toContain(
      'ChatGPT display at submission failure screenshot unavailable: no display in unit tests'
    );
    expect(result!.clientMetadata.traceLimitations).toContain(
      'Native evidence directory is unavailable.'
    );
  });
});
