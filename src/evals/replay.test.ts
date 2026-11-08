import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  RUN_SCHEMAS,
  readRunTrials,
  type RunRecord,
  type TrialRecord,
} from './runFormat.js';
import { RUN_FORMAT } from './resultFormat.js';
import { replayExecutor, runReplay } from './replay.js';
import { endingOf, resumeCollects } from './trialEnding.js';
import type { SemanticDesktopTelemetry } from '../entries/experimentalClients.js';

const trial = (fields: Partial<TrialRecord> = {}) =>
  ({ infrastructureError: false, ...fields }) as unknown as TrialRecord;
const failed = (failureKind: string, error = 'It failed.') =>
  trial({
    infrastructureError: true,
    error,
    clientDiagnostics: { failureKind },
  });

describe('resumeCollects (what mst run --resume collects)', () => {
  it('collects a trial its shard never returned', () => {
    expect(resumeCollects(undefined)).toBe(true);
    expect(resumeCollects(failed('missing'))).toBe(true);
  });

  it('collects a trial the client never submitted, an infrastructure failure', () => {
    // E.g. every case after a failed reset in a Cowork batch.
    expect(resumeCollects(failed('not-submitted'))).toBe(true);
  });

  it('collects every infrastructure failure a retry can help', () => {
    expect(resumeCollects(failed('process'))).toBe(true);
    expect(resumeCollects(failed('timeout'))).toBe(true);
    expect(
      resumeCollects(
        trial({ infrastructureError: true, error: 'HTTP 503 from provider' })
      )
    ).toBe(true);
  });

  it("keeps an infrastructure failure a retry can't help", () => {
    // The desktop kept only the prompt's beginning: it would again.
    expect(resumeCollects(failed('input'))).toBe(false);
  });

  it('keeps a trial the client ran, passed or failed', () => {
    expect(resumeCollects(trial())).toBe(false);
    expect(resumeCollects(trial({ error: 'The client failed.' }))).toBe(false);
  });

  it('keeps an ungraded trial: mst grade --resume grades it', () => {
    expect(
      resumeCollects(
        trial({
          infrastructureError: true,
          gradingError: 'judge: 503',
          error: 'Not graded: judge: 503',
        })
      )
    ).toBe(false);
  });

  it('follows a recorded ending over the old fields', () => {
    expect(
      resumeCollects(
        trial({
          ending: {
            kind: 'infrastructure',
            broke: 'setup',
            retryable: false,
            reason: 'Missing permission.',
          },
          infrastructureError: true,
          clientDiagnostics: { failureKind: 'missing' },
        })
      )
    ).toBe(false);
  });
});

describe('stored ChatGPT trials from earlier versions', () => {
  // The public receipt type still accepts identities from old stored runs.
  const oldNativeTelemetry = {
    driver: 'linux-desktop',
    accounting: 'partial',
    duration_ms: 5,
    action_count: 1,
    planner: { status: 'not-applicable' },
    cost: { status: 'not-applicable' },
  } satisfies SemanticDesktopTelemetry;
  // Earlier versions recorded the driver and its capability bindings; new
  // results don't, and old runs still read, regrade and end as recorded.
  const oldMetadata = {
    driver: {
      provider: 'openai',
      product: 'chatgpt',
      surface: 'agent',
      runtime: 'desktop-app',
      platform: 'linux',
    },
    driverSlug: 'openai.chatgpt.agent.desktop-app.linux',
    displayName: 'ChatGPT Native Linux Desktop',
    clientName: 'ChatGPT Native Linux Desktop',
    clientType: 'desktop',
    capabilitiesUsed: ['control', 'input', 'completion', 'trace', 'normalize'],
    transcriptSource: 'none',
    transcriptConfidence: 'unknown',
    artifacts: [],
    session: {},
    correlation: {
      strategy: 'exact_prompt',
      marker: 'MCP_SERVER_TESTER_external-client-old',
      includedInPrompt: false,
    },
    failureKind: 'no_matching_session',
    nativeController: {
      provider: 'linux-atspi',
      surface: 'chatgpt-work',
      submission: { status: 'completed', telemetry: oldNativeTelemetry },
    },
  };
  const error =
    'No unique fresh native ChatGPT session matched the submitted query within the binding deadline.';
  const record = {
    format: RUN_FORMAT,
    kind: 'trial',
    runId: '20260901T000000Z-abc123',
    variant: 'default',
    caseId: 'case',
    datasetName: 'cases',
    trial: 0,
    durationMs: 1000,
    // Stored before endings: the failure kind says how it ended.
    infrastructureError: true,
    error,
    transcript: { events: [], finalText: '', error },
    clientTelemetry: {
      clientMetadata: oldMetadata,
      // Cowork used these same receipts for submission and HITL.
      computerUse: {
        submission: { status: 'submitted', telemetry: oldNativeTelemetry },
        hitl: { status: 'failed', telemetry: oldNativeTelemetry },
      },
      batch: { nativeSetup: oldNativeTelemetry },
    },
    clientMetadata: oldMetadata,
  };

  it('reads, keeps the old fields, and ends as its failure kind says', async () => {
    expect(RUN_SCHEMAS.trial.safeParse(record).success).toBe(true);
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mst-old-chatgpt-'));
    try {
      const file = path.join(dir, 'transcripts', 'default', 'case', '0.json');
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.writeFile(file, JSON.stringify(record));
      const [stored] = await readRunTrials(dir);
      expect(stored).toMatchObject({
        clientTelemetry: record.clientTelemetry,
        clientMetadata: oldMetadata,
      });
      expect(endingOf(stored!)).toEqual({
        kind: 'infrastructure',
        broke: 'client-app',
        retryable: true,
        reason: error,
      });
      const replay = runReplay(
        { runId: record.runId } as RunRecord,
        dir,
        [stored!],
        `${record.runId}.g2`,
        '2026-09-01T00:00:00Z'
      );
      const execution = await replayExecutor(
        replay,
        'default',
        [],
        'structured'
      )({ id: 'case', input: 'q' });
      expect(execution).toMatchObject({
        kind: 'completed',
        error,
        clientMetadata: oldMetadata,
        telemetry: record.clientTelemetry,
        ending: { kind: 'infrastructure', broke: 'client-app' },
      });
      expect(await fs.readFile(file, 'utf8')).toBe(JSON.stringify(record));
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
