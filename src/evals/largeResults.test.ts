import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { saveBaseline } from './baseline.js';
import type { EvalRunnerResult } from './evalRunner.js';
import type { EvaluationSummary } from './evalFrameworkTypes.js';
import { RUN_FORMAT } from './resultFormat.js';
import {
  FileEvalResultStore,
  createStoredEvalArtifact,
  redactStoredResponses,
} from './resultStore.js';
import { writeRun, type RunFacts } from './runFormat.js';

/**
 * A run can be larger than V8's longest string, so no persistence path may
 * serialize a whole run, result or summary into one string. These run the
 * production paths over a result of about 1.3 MB and fail if any single
 * JSON.stringify call returns more than one case's worth: what a path that
 * stringifies the whole value would do.
 */
const OUTPUT = 'x'.repeat(32 * 1024);
const LIMIT = 4 * OUTPUT.length;

function caseResult(index: number) {
  return {
    id: `case-${index}`,
    datasetName: 'large',
    pass: true,
    scores: {},
    response: OUTPUT,
    trace: { finalText: OUTPUT, events: [] },
  };
}
const CASES = Array.from({ length: 40 }, (_, index) => caseResult(index));

describe('large results never become one string', () => {
  let root: string;
  let longest = 0;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'mst-large-'));
    longest = 0;
    const stringify = JSON.stringify;
    vi.spyOn(JSON, 'stringify').mockImplementation(((
      ...args: Parameters<typeof JSON.stringify>
    ) => {
      const text = stringify(...args);
      if (typeof text === 'string') longest = Math.max(longest, text.length);
      return text;
    }) as typeof JSON.stringify);
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(root, { recursive: true, force: true });
  });

  it('writes a run directory in chunks', async () => {
    const facts: RunFacts = {
      evalName: 'large',
      createdAt: '2026-10-19T00:00:00.000Z',
      finishedAt: '2026-10-19T00:01:00.000Z',
      mstVersion: '0.0.0',
      variants: [{ name: 'default' }],
      datasets: [{ name: 'large', caseCount: CASES.length, contentHash: 'h' }],
      redactStoredResponses: false,
    };
    const summary = {
      format: RUN_FORMAT,
      configId: 'large',
      contentHash: 'h',
      timestamp: facts.finishedAt,
      durationMs: 60_000,
      variants: [],
      results: CASES,
    } as unknown as EvaluationSummary;
    await writeRun(join(root, 'run'), 'run-1', facts, summary);
    expect(longest).toBeLessThan(LIMIT);
  });

  it('saves a result-store artifact and a baseline in chunks', async () => {
    const result = {
      format: RUN_FORMAT,
      caseResults: CASES,
    } as unknown as EvalRunnerResult;
    await new FileEvalResultStore({
      provider: 'file',
      dir: join(root, 'store'),
    }).saveArtifact(
      createStoredEvalArtifact({ kind: 'eval-runner-result', data: result })
    );
    await saveBaseline(result, join(root, 'baseline.json'), {
      omitResponses: false,
    });
    expect(longest).toBeLessThan(LIMIT);
  });

  it('copies a result for redaction without one string', () => {
    const redacted = redactStoredResponses({ results: CASES });
    expect(redacted.results[0]).not.toHaveProperty('response');
    expect(longest).toBeLessThan(LIMIT);
  });
});
