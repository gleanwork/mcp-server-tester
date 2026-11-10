import { mkdtemp, rm } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import nock from 'nock';
import {
  redactStoredResponses,
  FileEvalResultStore,
  GCSEvalResultStore,
  createStoredEvalArtifact,
  type EvalResultStore,
} from './resultStore.js';

describe('FileEvalResultStore', () => {
  let tmpDir: string;
  let store: EvalResultStore;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'mcp-result-store-'));
    store = new FileEvalResultStore({ provider: 'file', dir: tmpDir });
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('saves and loads an artifact by kind and id', async () => {
    const artifact = createStoredEvalArtifact({
      kind: 'eval-runner-result',
      id: 'run-1',
      createdAt: '2026-05-22T12:00:00.000Z',
      metadata: { datasetName: 'dataset-a' },
      data: { passed: 1 },
    });

    await store.saveArtifact(artifact);
    const loaded = await store.loadArtifact<{ passed: number }>(
      'eval-runner-result',
      'run-1'
    );

    expect(loaded).toEqual(artifact);
  });

  it('loads the latest artifact for a kind', async () => {
    const first = createStoredEvalArtifact({
      kind: 'eval-runner-result',
      id: 'run-1',
      createdAt: '2026-05-22T12:00:00.000Z',
      data: { passed: 1 },
    });
    const second = createStoredEvalArtifact({
      kind: 'eval-runner-result',
      id: 'run-2',
      createdAt: '2026-05-22T12:01:00.000Z',
      data: { passed: 2 },
    });

    await store.saveArtifact(first);
    await store.saveArtifact(second);

    const latest = await store.loadLatestArtifact<{ passed: number }>(
      'eval-runner-result'
    );
    expect(latest?.id).toBe('run-2');
    expect(latest?.data.passed).toBe(2);
  });

  it('returns null for a missing latest artifact', async () => {
    await expect(
      store.loadLatestArtifact('eval-runner-result')
    ).resolves.toBeNull();
  });

  it('lists artifacts sorted newest first with a limit', async () => {
    await store.saveArtifact(
      createStoredEvalArtifact({
        kind: 'eval-runner-result',
        id: 'old',
        createdAt: '2026-05-22T12:00:00.000Z',
        data: {},
      })
    );
    await store.saveArtifact(
      createStoredEvalArtifact({
        kind: 'eval-runner-result',
        id: 'new',
        createdAt: '2026-05-22T12:01:00.000Z',
        data: {},
      })
    );

    const summaries = await store.listArtifacts('eval-runner-result', {
      limit: 1,
    });

    expect(summaries.map((s) => s.id)).toEqual(['new']);
  });

  it('fails clearly on an artifact from an earlier MST and leaves it out of listings', async () => {
    const { mkdir, writeFile } = await import('fs/promises');
    await mkdir(join(tmpDir, 'eval-runs'), { recursive: true });
    const older = {
      schemaVersion: 1,
      kind: 'eval-runner-result',
      id: 'older',
      createdAt: '2026-05-22T12:00:00.000Z',
      metadata: {},
      data: {},
    };
    await writeFile(
      join(tmpDir, 'eval-runs', 'older.json'),
      JSON.stringify(older)
    );
    await writeFile(
      join(tmpDir, 'eval-runs', 'latest.json'),
      JSON.stringify(older)
    );
    await store.saveArtifact(
      createStoredEvalArtifact({
        kind: 'eval-runner-result',
        id: 'current',
        data: {},
      })
    );
    // saveArtifact rewrites latest.json; put the older one back.
    await writeFile(
      join(tmpDir, 'eval-runs', 'latest.json'),
      JSON.stringify(older)
    );

    await expect(
      store.loadArtifact('eval-runner-result', 'older')
    ).rejects.toThrow(
      "Stored eval-runner-result 'older' was written by an earlier MST. 2.0 renamed result fields (mcpHostTrace → toolCallTranscript"
    );
    await expect(
      store.loadLatestArtifact('eval-runner-result')
    ).rejects.toThrow('Rerun to write it again.');
    expect(
      (await store.listArtifacts('eval-runner-result')).map((s) => s.id)
    ).toEqual(['current']);
  });

  it('fails on a malformed or newer artifact, and leaves it out of listings', async () => {
    const { mkdir, writeFile } = await import('fs/promises');
    await mkdir(join(tmpDir, 'eval-runs'), { recursive: true });
    const artifact = {
      format: 'mst.run/v1',
      kind: 'eval-runner-result',
      id: 'x',
      createdAt: '2026-10-01T00:00:00.000Z',
      metadata: {},
      data: {},
    };
    const write = (id: string, value: unknown) =>
      writeFile(join(tmpDir, 'eval-runs', `${id}.json`), JSON.stringify(value));
    await write('no-id', { ...artifact, id: undefined });
    await write('future-kind', { ...artifact, kind: 'eval-run-forecast' });
    await write('newer', { ...artifact, format: 'mst.run/v2' });
    await write('rc0', {
      ...artifact,
      data: { caseResults: [{ id: 'a', pass: true, scores: {}, trace: {} }] },
    });
    await expect(
      store.loadArtifact('eval-runner-result', 'no-id')
    ).rejects.toThrow(
      "Stored eval-runner-result 'no-id' isn't a stored result artifact"
    );
    await expect(
      store.loadArtifact('eval-runner-result', 'future-kind')
    ).rejects.toThrow(
      /a newer MST may have written it\. Upgrade MST to read it\./
    );
    await expect(
      store.loadArtifact('eval-runner-result', 'newer')
    ).rejects.toThrow('was written by a newer MST (mst.run/v2)');
    await expect(
      store.loadArtifact('eval-runner-result', 'rc0')
    ).rejects.toThrow('written by an MST 2.0 release candidate');
    // A summary stored where results are kept isn't a result.
    await write('misplaced', { ...artifact, kind: 'eval-run-summary' });
    await expect(
      store.loadArtifact('eval-runner-result', 'misplaced')
    ).rejects.toThrow(
      "Stored eval-runner-result 'misplaced' is an eval-run-summary, not an eval-runner-result."
    );
    // A half-written or empty file.
    await writeFile(join(tmpDir, 'eval-runs', 'cut.json'), '{"format":"mst.r');
    await writeFile(join(tmpDir, 'eval-runs', 'empty.json'), '');
    await store.saveArtifact(
      createStoredEvalArtifact({
        kind: 'eval-runner-result',
        id: 'current',
        data: { caseResults: [] },
      })
    );
    expect(
      (await store.listArtifacts('eval-runner-result')).map(({ id }) => id)
    ).toEqual(['current']);
  });

  it('fails on a summary or comparison whose case results an rc.0 MST wrote, and leaves it out of listings', async () => {
    const rc0 = { id: 'a', pass: true, scores: {}, trace: {} };
    await store.saveArtifact(
      createStoredEvalArtifact({
        kind: 'eval-run-summary',
        id: 'reporter',
        // The Playwright reporter's summary: its case results under `results`.
        data: { results: [rc0] },
      })
    );
    await store.saveArtifact(
      createStoredEvalArtifact({
        kind: 'eval-run-summary',
        id: 'variants',
        data: { variants: [{ name: 'v', result: { caseResults: [rc0] } }] },
      })
    );
    await store.saveArtifact(
      createStoredEvalArtifact({
        kind: 'eval-run-comparison',
        id: 'comparison',
        data: { cases: [{ id: 'a', outcome: 'unchanged', candidate: rc0 }] },
      })
    );
    for (const id of ['reporter', 'variants'])
      await expect(store.loadArtifact('eval-run-summary', id)).rejects.toThrow(
        'written by an MST 2.0 release candidate'
      );
    await expect(
      store.loadArtifact('eval-run-comparison', 'comparison')
    ).rejects.toThrow('written by an MST 2.0 release candidate');
    expect(await store.listArtifacts('eval-run-summary')).toEqual([]);
    expect(await store.listArtifacts('eval-run-comparison')).toEqual([]);
  });

  it('round-trips comparison artifacts', async () => {
    const artifact = createStoredEvalArtifact({
      kind: 'eval-run-comparison',
      id: 'comparison-1',
      data: { aWins: 1, bWins: 0 },
    });

    await store.saveArtifact(artifact);

    const loaded = await store.loadArtifact<{ aWins: number; bWins: number }>(
      'eval-run-comparison',
      'comparison-1'
    );
    expect(loaded.data).toEqual({ aWins: 1, bWins: 0 });
  });
});

describe('GCSEvalResultStore', () => {
  const originalEmulatorHost = process.env.STORAGE_EMULATOR_HOST;

  beforeEach(() => {
    process.env.STORAGE_EMULATOR_HOST = 'http://storage.test';
    nock.disableNetConnect();
  });

  afterEach(() => {
    if (originalEmulatorHost === undefined) {
      delete process.env.STORAGE_EMULATOR_HOST;
    } else {
      process.env.STORAGE_EMULATOR_HOST = originalEmulatorHost;
    }
    nock.cleanAll();
    nock.enableNetConnect();
  });

  it('saves immutable and latest artifacts through the official SDK', async () => {
    const artifact = createStoredEvalArtifact({
      kind: 'eval-runner-result',
      id: 'run-1',
      data: { total: 1 },
    });

    const uploadScope = nock('http://storage.test')
      .post('/upload/storage/v1/b/bucket/o')
      .query({
        uploadType: 'multipart',
        name: 'prefix/eval-runs/run-1.json',
      })
      .reply(200, { name: 'prefix/eval-runs/run-1.json' })
      .post('/upload/storage/v1/b/bucket/o')
      .query({
        uploadType: 'multipart',
        name: 'prefix/eval-runs/latest.json',
      })
      .reply(200, { name: 'prefix/eval-runs/latest.json' });

    const store = new GCSEvalResultStore({
      provider: 'gcs',
      bucket: 'bucket',
      prefix: 'prefix',
    });

    await store.saveArtifact(artifact);

    expect(uploadScope.isDone()).toBe(true);
  });

  it('loads latest artifacts through the official SDK', async () => {
    const artifact = createStoredEvalArtifact({
      kind: 'eval-runner-result',
      id: 'run-1',
      data: { total: 1 },
    });
    const objectPath = '/b/bucket/o/prefix%2Feval-runs%2Flatest.json';

    nock('http://storage.test')
      .get(objectPath)
      .query(true)
      .reply(200, { name: 'prefix/eval-runs/latest.json' })
      .get(objectPath)
      .query({ alt: 'media' })
      .reply(200, artifact);

    const store = new GCSEvalResultStore({
      provider: 'gcs',
      bucket: 'bucket',
      prefix: 'prefix',
    });

    const loaded = await store.loadLatestArtifact<{ total: number }>(
      'eval-runner-result'
    );

    expect(loaded?.id).toBe('run-1');
    expect(loaded?.data.total).toBe(1);
  });

  it('loads an immutable artifact by id', async () => {
    const artifact = createStoredEvalArtifact({
      kind: 'eval-runner-result',
      id: 'run-2',
      data: { total: 2 },
    });
    // GCSEvalResultStore.loadArtifact builds the object path via
    // `${kind-prefix}/eval-runs/${encodeURIComponent(id)}.json`. The GCS SDK
    // URL-encodes the resulting path once when constructing the request, so
    // the test endpoint sees the path-separator slashes mapped to %2F.
    const objectPath = '/b/bucket/o/prefix%2Feval-runs%2Frun-2.json';

    nock('http://storage.test')
      .get(objectPath)
      .query({ alt: 'media' })
      .reply(200, artifact);

    const store = new GCSEvalResultStore({
      provider: 'gcs',
      bucket: 'bucket',
      prefix: 'prefix',
    });

    const loaded = await store.loadArtifact<{ total: number }>(
      'eval-runner-result',
      'run-2'
    );

    expect(loaded.id).toBe('run-2');
    expect(loaded.data.total).toBe(2);
  });

  it('lists artifacts by kind, filters out latest.json, sorts newest-first, and respects limit', async () => {
    const olderArtifact = createStoredEvalArtifact({
      kind: 'eval-runner-result',
      id: 'older',
      data: { total: 1 },
      createdAt: '2026-05-20T00:00:00.000Z',
    });
    const newerArtifact = createStoredEvalArtifact({
      kind: 'eval-runner-result',
      id: 'newer',
      data: { total: 2 },
      createdAt: '2026-05-21T00:00:00.000Z',
    });

    // Use a content-based matcher so the test is robust to changes in the
    // exact URL shape (the GCS SDK with STORAGE_EMULATOR_HOST builds slightly
    // different URLs depending on the operation; matching on URL substring
    // covers list, download, and any internal redirects without enumerating
    // every path the SDK might use).
    nock('http://storage.test')
      .persist()
      .get(/.*/)
      .query(true)
      .reply(function (uri) {
        if (uri.includes('older.json')) return [200, olderArtifact];
        if (uri.includes('newer.json')) return [200, newerArtifact];
        if (uri.includes('?prefix=') || uri.includes('&prefix=')) {
          return [
            200,
            {
              items: [
                { name: 'prefix/eval-runs/older.json' },
                { name: 'prefix/eval-runs/newer.json' },
                // latest.json must be excluded from the listing because it
                // duplicates the most recent immutable artifact.
                { name: 'prefix/eval-runs/latest.json' },
                // Non-JSON files (e.g. partial uploads) must be excluded too.
                { name: 'prefix/eval-runs/stray.txt' },
              ],
            },
          ];
        }
        return [404, {}];
      });

    const store = new GCSEvalResultStore({
      provider: 'gcs',
      bucket: 'bucket',
      prefix: 'prefix',
    });

    const summaries = await store.listArtifacts('eval-runner-result', {
      limit: 5,
    });

    expect(summaries.map((s) => s.id)).toEqual(['newer', 'older']);
  });

  it('leaves out of listings an object that is half-written or of another kind', async () => {
    const current = createStoredEvalArtifact({
      kind: 'eval-runner-result',
      id: 'current',
      data: { total: 1 },
    });
    const summary = createStoredEvalArtifact({
      kind: 'eval-run-summary',
      id: 'summary',
      data: {},
    });
    nock('http://storage.test')
      .persist()
      .get(/.*/)
      .query(true)
      .reply(function (uri) {
        if (uri.includes('current.json')) return [200, current];
        if (uri.includes('summary.json')) return [200, summary];
        if (uri.includes('cut.json')) return [200, '{"format":"mst.r'];
        if (uri.includes('?prefix=') || uri.includes('&prefix='))
          return [
            200,
            {
              items: [
                { name: 'prefix/eval-runs/current.json' },
                { name: 'prefix/eval-runs/summary.json' },
                { name: 'prefix/eval-runs/cut.json' },
              ],
            },
          ];
        return [404, {}];
      });
    const store = new GCSEvalResultStore({
      provider: 'gcs',
      bucket: 'bucket',
      prefix: 'prefix',
    });
    expect(
      (await store.listArtifacts('eval-runner-result')).map(({ id }) => id)
    ).toEqual(['current']);
  });
});

describe('redactStoredResponses', () => {
  it('accepts any JSON-serializable judge metadata, as stored JSON does', () => {
    // A structured clone throws on a URL; the stored file is JSON either way.
    const result = {
      id: 'case',
      pass: true,
      scores: {
        judge: {
          pass: true,
          metadata: { source: new URL('https://example.com') },
        },
      },
      response: 'private',
      checkedAt: new Date('2026-10-12T00:00:00Z'),
    };
    const redacted = redactStoredResponses({ results: [result] });
    expect(redacted.results[0]).toEqual({
      id: 'case',
      pass: true,
      scores: { judge: { pass: true } },
      checkedAt: '2026-10-12T00:00:00.000Z',
    });
  });

  const transcript = () => ({
    events: [
      {
        kind: 'tool_call',
        source: 'mcp',
        name: 'search',
        server: 'docs',
        arguments: { query: 'outage' },
        output: 'private result',
      },
      { kind: 'skill', source: 'builtin', name: 'summarize' },
    ],
    finalText: 'private answer',
    modelCalls: [{ id: 'req-1', text: 'private draft', outputTokens: 2 }],
    evidence: 'structured',
    usage: { inputTokens: 10, outputTokens: 2, durationMs: 5 },
  });
  const redactedTranscript = {
    events: [
      {
        kind: 'tool_call',
        source: 'mcp',
        name: 'search',
        server: 'docs',
        arguments: { query: 'outage' },
      },
      { kind: 'skill', source: 'builtin', name: 'summarize' },
    ],
    modelCalls: [{ id: 'req-1', outputTokens: 2 }],
    evidence: 'structured',
    usage: { inputTokens: 10, outputTokens: 2, durationMs: 5 },
  };

  it("keeps a transcript's events, servers, arguments and usage, without its answer, outputs or model text", () => {
    const result = {
      id: 'one',
      pass: true,
      scores: {},
      response: { private: true },
      transcript: transcript(),
      trialResults: [{ pass: true, durationMs: 1, transcript: transcript() }],
    };
    const redacted = redactStoredResponses({ results: [result] });
    expect(redacted.results[0]).toEqual({
      id: 'one',
      pass: true,
      scores: {},
      transcript: redactedTranscript,
      trialResults: [
        { pass: true, durationMs: 1, transcript: redactedTranscript },
      ],
    });
    // The input is not changed.
    expect(result.transcript.finalText).toBe('private answer');
  });

  it("strips an rc.0 `trace` as it does a transcript, so a hand-built comparison can't keep one's answer", () => {
    const result = {
      id: 'one',
      pass: true,
      scores: {},
      trace: transcript(),
      trialResults: [{ pass: true, durationMs: 1, trace: transcript() }],
    };
    const redacted = redactStoredResponses({ cases: [{ baseline: result }] });
    expect(redacted.cases[0]!.baseline).toEqual({
      id: 'one',
      pass: true,
      scores: {},
      trace: redactedTranscript,
      trialResults: [{ pass: true, durationMs: 1, trace: redactedTranscript }],
    });
  });

  it("drops a client's telemetry content, keeping the rest of its telemetry", () => {
    const telemetry = () => ({
      threadId: 't1',
      toolCallCount: 2,
      content: { conversationHistory: [{ role: 'user', content: 'private' }] },
    });
    const redacted = redactStoredResponses({
      results: [
        {
          id: 'c1',
          pass: true,
          scores: {},
          clientTelemetry: telemetry(),
          trialResults: [{ pass: true, clientTelemetry: telemetry() }],
        },
      ],
    });
    const [result] = redacted.results;
    for (const kept of [
      result!.clientTelemetry,
      result!.trialResults[0]!.clientTelemetry,
    ])
      expect(kept).toEqual({ threadId: 't1', toolCallCount: 2 });
  });

  it("drops judges' score metadata, keeping the score and reasoning", () => {
    const score = {
      pass: true,
      score: 0.8,
      reasoning: 'cites the report',
      metadata: { agent: { steps: [{ tool: 'Read' }] }, quote: 'evidence' },
    };
    const redacted = redactStoredResponses({
      results: [
        {
          id: 'c1',
          pass: true,
          scores: { 'judge.x': score },
          trialResults: [{ pass: true, scores: { 'judge.x': score } }],
        },
      ],
    });
    const [result] = redacted.results;
    for (const scores of [result!.scores, result!.trialResults[0]!.scores])
      expect(scores['judge.x']).toEqual({
        pass: true,
        score: 0.8,
        reasoning: 'cites the report',
      });
  });

  it("drops the metadata of a combined score's judgeResults, and of pairwise preferences", () => {
    const judge = (name: string) => ({
      pass: true,
      reasoning: `${name} graded it`,
      metadata: { quote: `${name} evidence` },
    });
    const combined = {
      pass: true,
      details: '2/2 judges passed',
      judgeResults: [judge('a'), judge('b')],
    };
    const preference = {
      judge: 'p',
      preference: 'candidate',
      strength: 1,
      reasoning: 'better',
      metadata: { quote: 'candidate evidence' },
    };
    const redacted = redactStoredResponses({
      results: [
        {
          id: 'c1',
          pass: true,
          scores: { judge: combined },
          trialResults: [{ pass: true, scores: { judge: combined } }],
        },
      ],
      variants: [
        {
          name: 'candidate',
          pairwise: {
            baseline: 'baseline',
            cases: [{ id: 'c1', preferences: [preference] }],
          },
        },
      ],
      comparison: { cases: [{ id: 'c1', preferences: [preference] }] },
    });
    const [result] = redacted.results;
    for (const scores of [result!.scores, result!.trialResults[0]!.scores])
      expect(scores.judge).toEqual({
        pass: true,
        details: '2/2 judges passed',
        judgeResults: [
          { pass: true, reasoning: 'a graded it' },
          { pass: true, reasoning: 'b graded it' },
        ],
      });
    const kept = {
      judge: 'p',
      preference: 'candidate',
      strength: 1,
      reasoning: 'better',
    };
    expect(redacted.variants[0]!.pairwise.cases[0]!.preferences).toEqual([
      kept,
    ]);
    expect(redacted.comparison.cases[0]!.preferences).toEqual([kept]);
  });
});

describe('partial runs and latest.json', () => {
  it("a partial run's artifact never becomes the latest", async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mst-partial-latest-'));
    try {
      const store = new FileEvalResultStore({ provider: 'file', dir });
      const full = createStoredEvalArtifact({
        kind: 'eval-run-summary',
        id: 'full',
        data: { n: 1 },
        metadata: { labels: { configId: 'c' } },
        createdAt: '2026-10-07T00:00:00.000Z',
      });
      const partial = createStoredEvalArtifact({
        kind: 'eval-run-summary',
        id: 'partial',
        data: { n: 2 },
        metadata: { labels: { configId: 'c', partial: 'true' } },
        createdAt: '2026-10-07T00:01:00.000Z',
      });
      await store.saveArtifact(full);
      await store.saveArtifact(partial);
      const latest = await store.loadLatestArtifact('eval-run-summary');
      expect(latest?.id).toBe('full');
      expect((await store.loadArtifact('eval-run-summary', 'partial')).id).toBe(
        'partial'
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
