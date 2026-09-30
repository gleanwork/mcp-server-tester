/**
 * Run-level numbers and stored results agree across every API that produces
 * them: one pass rate, one comparison, one redaction policy.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  REDACT_STORED_RESPONSES_BY_DEFAULT,
  redactStoredResponses,
  type EvalResultStore,
  type StoredEvalArtifact,
} from './resultStore.js';
import {
  compareEvalRuns,
  passRate,
  saveEvalRunComparison,
} from './evalRunComparison.js';
import { saveServerComparison } from './serverComparison.js';
import {
  omitResponsesFromResult,
  runEvalDataset,
  type EvalContext,
  type EvalRunnerResult,
} from './evalRunner.js';
import type { EvalCaseResult } from '../types/reporter.js';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { saveBaseline } from './baseline.js';
import type { MCPFixtureApi } from '../mcp/fixtures/mcpFixture.js';
import { createFixtureExtensions } from '../mcp/fixtures/fixtureExtensions.js';

function memoryStore(): EvalResultStore & {
  saved: StoredEvalArtifact<unknown>[];
} {
  const saved: StoredEvalArtifact<unknown>[] = [];
  return {
    saved,
    async saveArtifact(artifact: StoredEvalArtifact<unknown>) {
      saved.push(artifact);
    },
    async loadArtifact() {
      return undefined;
    },
    async loadLatestArtifact() {
      return undefined;
    },
    async listArtifacts() {
      return [];
    },
  } as unknown as EvalResultStore & { saved: StoredEvalArtifact<unknown>[] };
}

/** Every key path in a JSON value, e.g. "caseResults.0.request.expect.response". */
function keyPaths(value: unknown, prefix = ''): string[] {
  if (value === null || typeof value !== 'object') return [];
  return Object.entries(value).flatMap(([key, nested]) => {
    const here = prefix ? `${prefix}.${key}` : key;
    return [here, ...keyPaths(nested, here)];
  });
}

function responsePaths(value: unknown): string[] {
  return keyPaths(value).filter((path) => /(^|\.)response$/.test(path));
}

const caseResult: EvalCaseResult = {
  id: 'weather',
  datasetName: 'dataset',
  toolName: 'get_weather',
  source: 'eval',
  pass: true,
  expectations: {},
  durationMs: 1,
  response: { content: [{ type: 'text', text: 'secret token abc' }] },
  request: { expect: { response: { content: [] } } },
};

function run(overrides: Partial<EvalRunnerResult> = {}): EvalRunnerResult {
  return {
    total: 1,
    passed: 1,
    failed: 0,
    caseResults: [caseResult],
    durationMs: 1,
    ...overrides,
  } as EvalRunnerResult;
}

describe('passRate', () => {
  it('is passed over total, and 0 for a run without cases', () => {
    expect(passRate({ passed: 3, total: 4 })).toBe(0.75);
    expect(passRate({ passed: 0, total: 0 })).toBe(0);
  });
});

describe('redactStoredResponses', () => {
  it('drops every response value, at any depth, and returns a copy', () => {
    const value = run();
    const redacted = redactStoredResponses(value);
    expect(responsePaths(value)).toEqual([
      'caseResults.0.response',
      'caseResults.0.request.expect.response',
    ]);
    expect(responsePaths(redacted)).toEqual([]);
    expect(redacted.caseResults[0]?.id).toBe('weather');
  });

  it('is what omitResponsesFromResult applies', () => {
    expect(omitResponsesFromResult(run())).toEqual(
      redactStoredResponses(run())
    );
  });
});

describe('every storing API redacts by default', () => {
  it('uses one default', () => {
    expect(REDACT_STORED_RESPONSES_BY_DEFAULT).toBe(true);
  });

  it('eval run comparisons', async () => {
    const store = memoryStore();
    await saveEvalRunComparison({
      store,
      comparison: compareEvalRuns({ baseline: run(), candidate: run() }),
    });
    expect(responsePaths(store.saved[0]?.data)).toEqual([]);
  });

  it('server comparisons', async () => {
    const store = memoryStore();
    await saveServerComparison({
      store,
      comparison: {
        dataset: 'dataset',
        serverAResult: run(),
        serverBResult: run(),
      } as unknown as Parameters<typeof saveServerComparison>[0]['comparison'],
    });
    expect(responsePaths(store.saved[0]?.data)).toEqual([]);
  });

  it('eval runner results saved to a store', async () => {
    const store = memoryStore();
    const mcp = {
      client: {} as MCPFixtureApi['client'],
      authType: 'none',
      ...createFixtureExtensions({} as MCPFixtureApi['client']),
      listTools: vi.fn().mockResolvedValue([]),
      callTool: vi.fn().mockResolvedValue({
        content: [{ type: 'text', text: 'secret token abc' }],
      }),
    } as unknown as MCPFixtureApi;
    await runEvalDataset(
      {
        dataset: {
          name: 'dataset',
          cases: [
            {
              id: 'weather',
              toolName: 'get_weather',
              args: {},
              expect: { response: { content: [] } },
            },
          ],
        },
        resultStore: store,
        saveResultsTo: { store: true },
      },
      { mcp } as EvalContext
    );
    expect(store.saved).toHaveLength(1);
    expect(responsePaths(store.saved[0]?.data)).toEqual([]);
  });
});

describe('baseline files', () => {
  it('are redacted under the same policy', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'baseline-'));
    const file = path.join(dir, 'baseline.json');
    await saveBaseline(run(), file);
    const saved: unknown = JSON.parse(await fs.readFile(file, 'utf8'));
    await fs.rm(dir, { recursive: true, force: true });
    expect(responsePaths(saved)).toEqual([]);
  });
});

describe('the runner baseline uses the shared comparison', () => {
  it('matches compareEvalRuns for regressions, improvements and delta', () => {
    const baseline = run({
      total: 3,
      passed: 2,
      failed: 1,
      caseResults: [
        { ...caseResult, id: 'a', pass: true },
        { ...caseResult, id: 'b', pass: false },
        { ...caseResult, id: 'c', pass: true },
      ],
    });
    const candidate = run({
      total: 3,
      passed: 1,
      failed: 2,
      caseResults: [
        { ...caseResult, id: 'a', pass: false },
        { ...caseResult, id: 'b', pass: true },
        { ...caseResult, id: 'c', pass: false },
      ],
    });
    const comparison = compareEvalRuns({ baseline, candidate });
    expect(comparison.regressedCases.map((c) => c.id)).toEqual(['a', 'c']);
    expect(comparison.improvedCases.map((c) => c.id)).toEqual(['b']);
    expect(comparison.deltaPassRate).toBeCloseTo(1 / 3 - 2 / 3);
  });
});
