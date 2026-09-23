import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ExternalHostCapabilityContext } from '../types.js';
import { normalizeHostDriver } from '../driverIdentity.js';
import { findChatgptTrace } from './chatgptTrace.js';
import type * as TraceModule from './chatgptTrace.js';
import {
  chatgptBindingDeadline,
  OPENAI_CHATGPT_CAPABILITIES,
} from './openaiChatgpt.js';
import { linuxEnvironment } from '../../chatgpt/linuxEnvironment.fixture.js';

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
  return {
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
      data: {
        chatgptSessionsRoot: join(home, '.codex', 'sessions'),
        chatgptEvidenceDir: linux ? join(home, 'evidence') : undefined,
        chatgptSessionBaseline: new Map(),
        chatgptPromptSubmitted: true,
        chatgptNativeController: linux
          ? {
              provider: 'linux-atspi',
              surface: 'chatgpt-work',
              submission: { status: 'completed' },
            }
          : undefined,
      },
    },
  };
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
    expect(chatgptBindingDeadline(false, 1000, 200_000)).toBe(31_000);
    expect(chatgptBindingDeadline(true, 1000, 200_000)).toBe(121_000);
    expect(chatgptBindingDeadline(true, 1000, 41_234)).toBe(41_234);
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
        const root = ctx.state.data.chatgptSessionsRoot as string;
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
        const artifacts = result.externalHost.artifacts;
        // Linux copies bounded fresh candidates, labeled UNVERIFIED; macOS copies nothing.
        expect(artifacts).toHaveLength(linux ? 1 : 0);
        if (linux) {
          const [artifact] = artifacts;
          expect(artifact).toMatchObject({
            kind: 'metadata',
            name: expect.stringContaining('UNVERIFIED'),
            summary: expect.stringMatching(/sha256=[a-f0-9]{64}$/),
          });
          expect(artifact!.path!.startsWith(join(home, 'evidence'))).toBe(true);
          expect(await readFile(artifact!.path!, 'utf8')).toContain(
            'unconfirmed-origin'
          );
          expect(result.externalHost.traceLimitations?.join(' ')).toContain(
            'missing records do not prove'
          );
        }
        expect(JSON.stringify(result.externalHost)).not.toContain(
          'private-session'
        );
        expect(findChatgptTrace).toHaveBeenCalledWith(
          root,
          ctx.state.data.chatgptSessionBaseline,
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
        const root = ctx.state.data.chatgptSessionsRoot as string;
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
          ctx.state.data.chatgptSessionBaseline,
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
      const root = ctx.state.data.chatgptSessionsRoot as string;
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
        externalHost: {
          failureKind: 'host_run_failed',
          traceSource: 'none',
          traceConfidence: 'unknown',
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
          toolCalls: [],
          conversationHistory: [],
          telemetry: {},
          limitations: [],
        },
      });
      const result = await capture(ctx);
      expect(result).toMatchObject({
        success: false,
        externalHost: {
          failureKind: 'timeout',
          traceConfidence: 'unknown',
          traceSource: 'none',
          session: {},
        },
      });
      expect(clock.now).toBe(2500);
      expect(result).not.toHaveProperty('response');
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it.each([
    [
      'Ambiguous matching ChatGPT sessions for this query.',
      'ambiguous_matching_sessions',
    ],
    [
      'ChatGPT submitted into an existing native session instead of a fresh chat.',
      'parse_failure',
    ],
    [
      'Bound ChatGPT session/turn changed or no longer matches the query.',
      'host_run_failed',
    ],
    ['Malformed complete JSONL record in ChatGPT transcript.', 'parse_failure'],
  ])('preserves failure classifier: %s', async (message, failureKind) => {
    const home = await mkdtemp(join(tmpdir(), 'chatgpt-classifier-'));
    try {
      vi.mocked(findChatgptTrace).mockRejectedValue(new Error(message));
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
      ctx.state.data.chatgptEvidenceDir = undefined;
      const result = await capture(ctx);
      expect(result?.externalHost.artifacts).toEqual([]);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
});
