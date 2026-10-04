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

  it('keeps fields that only happen to be called response', () => {
    const value = run({
      caseResults: [
        {
          ...caseResult,
          request: {
            args: { response: 'tool argument' },
            expect: { response: { content: [] } },
          },
          mcpHostTrace: {
            calls: [
              {
                name: 'reply',
                arguments: { response: 'host argument' },
                status: 'expected',
              },
            ],
            missed: [],
          },
        },
      ],
    });
    expect(responsePaths(redactStoredResponses(value))).toEqual([
      'caseResults.0.request.args.response',
      'caseResults.0.mcpHostTrace.calls.0.arguments.response',
    ]);
    // Outside a case result, nothing is stripped.
    expect(redactStoredResponses({ response: 'x' })).toEqual({ response: 'x' });
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

describe('the runner baseline', () => {
  function textMCP(): MCPFixtureApi {
    return {
      client: {} as MCPFixtureApi['client'],
      authType: 'none',
      ...createFixtureExtensions({} as MCPFixtureApi['client']),
      listTools: vi.fn().mockResolvedValue([]),
      callTool: vi.fn().mockResolvedValue({
        content: [{ type: 'text', text: 'ok' }],
      }),
    } as unknown as MCPFixtureApi;
  }

  /** Cases that pass when `expected` is 'ok' and fail otherwise. */
  function cases(entries: Array<[id: string, expected: string]>) {
    return entries.map(([id, expected]) => ({
      id,
      toolName: 'echo',
      args: {},
      expect: { containsText: expected },
    }));
  }

  async function withBaseline(
    baselineCases: Array<[id: string, pass: boolean]>,
    current: Array<[id: string, expected: string]>
  ): Promise<EvalRunnerResult> {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'runner-baseline-'));
    const file = path.join(dir, 'baseline.json');
    const baselineResults = baselineCases.map(([id, pass]) => ({
      ...caseResult,
      id,
      pass,
    }));
    await saveBaseline(
      run({
        caseResults: baselineResults,
        total: baselineResults.length,
        passed: baselineResults.filter((r) => r.pass).length,
        failed: baselineResults.filter((r) => !r.pass).length,
      }),
      file
    );
    const result = await runEvalDataset(
      {
        dataset: { name: 'dataset', cases: cases(current) },
        baselineResultsFrom: file,
      },
      { mcp: textMCP() } as EvalContext
    );
    await fs.rm(dir, { recursive: true, force: true });
    return result;
  }

  it('annotates cases and counts regressions and improvements', async () => {
    const result = await withBaseline(
      [
        ['a', true],
        ['b', false],
        ['c', true],
      ],
      [
        ['a', 'nope'],
        ['b', 'ok'],
        ['c', 'ok'],
      ]
    );
    expect(result.caseResults.map((r) => [r.id, r.baselinePass])).toEqual([
      ['a', true],
      ['b', false],
      ['c', true],
    ]);
    expect(result.regressions).toBe(1);
    expect(result.improvements).toBe(1);
    expect(result.deltaPassRate).toBeCloseTo(2 / 3 - 2 / 3);
  });

  it('counts from each case annotation when a baseline repeats an ID', async () => {
    // The last baseline entry wins, so the current failure is no regression.
    const result = await withBaseline(
      [
        ['a', true],
        ['a', false],
      ],
      [['a', 'nope']]
    );
    expect(result.caseResults[0]?.baselinePass).toBe(false);
    expect(result.regressions).toBe(0);
  });

  it('reports no delta for a run without cases', async () => {
    const result = await withBaseline([['a', true]], []);
    expect(result.deltaPassRate).toBe(0);
  });

  it('warns when most cases have no baseline entry', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await withBaseline(
      [['a', true]],
      [
        ['a', 'ok'],
        ['new-1', 'ok'],
        ['new-2', 'ok'],
      ]
    );
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('2 of 3 cases (67%) have no baseline entry')
    );
    warn.mockRestore();
  });

  it('matches compareEvalRuns for the same runs', () => {
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
