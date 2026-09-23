import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
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
      codexSetup: {
        configPath: join(home, '.codex', 'config.toml'),
        servers: [],
      },
      options: {
        desktopEnvironment: {
          HOME: home,
          MST_CHATGPT_ISOLATED_HOME: home,
          DISPLAY: ':1',
          DBUS_SESSION_BUS_ADDRESS: 'unix:path=/test-bus',
        },
      },
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
        expect(
          artifacts.every((artifact) => artifact.kind === 'metadata')
        ).toBe(true);
        const metadata = JSON.parse(artifacts[0]!.summary!);
        expect(metadata).toMatchObject({
          authoritative: false,
          status: 'UNVERIFIED',
          currentFileCount: 1,
        });
        expect(metadata.originatorCount).toEqual(linux ? { other: 1 } : {});
        expect(artifacts.filter((artifact) => artifact.path)).toHaveLength(
          linux ? 1 : 0
        );
        expect(JSON.stringify(metadata)).not.toContain(home);
        expect(JSON.stringify(result.externalHost)).not.toContain(
          'private-session'
        );
        expect(result.externalHost.traceLimitations?.join(' ')).toContain(
          'Missing records do not prove'
        );
        expect(findChatgptTrace).toHaveBeenCalledWith(
          root,
          ctx.state.data.chatgptSessionBaseline,
          { strategy: 'exact_prompt', prompt: 'private prompt' },
          1000,
          expect.objectContaining({ requireFreshSession: true })
        );
      } finally {
        await rm(home, { recursive: true, force: true });
      }
    }
  );

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

  it('does not attach content diagnostics when Linux HOME attestation is absent', async () => {
    const home = await mkdtemp(join(tmpdir(), 'chatgpt-unattested-'));
    try {
      const ctx = context(home, true, 1);
      ctx.config.options = {
        desktopEnvironment: { HOME: home, MST_CHATGPT_ISOLATED_HOME: '' },
      };
      const result = await capture(ctx);
      expect(result?.externalHost.artifacts).toEqual([]);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
});
