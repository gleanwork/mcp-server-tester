import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { saveBaseline, loadBaseline } from './baseline.js';
import type { EvalRunnerResult } from './evalRunner.js';
import { mkdtemp, rm } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';

describe('baselines from an earlier MST', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'older-baseline-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it.each([
    ['the mcp_host placeholder', { toolName: 'mcp_host' }],
    ['a renamed field', { hostUsage: { inputTokens: 1 } }],
    ['request.scenario', { request: { scenario: 'hi' } }],
    ['a renamed trial field', { trialResults: [{ mcpHostTrace: {} }] }],
    ['iterationResults', { iterationResults: [] }],
    ['expectations', { expectations: {} }],
    ['assertionPassRate', { assertionPassRate: 1 }],
  ])('fails clearly on %s', async (_label, fields) => {
    const { writeFile } = await import('fs/promises');
    const file = join(dir, 'baseline.json');
    await writeFile(
      file,
      JSON.stringify({
        total: 1,
        passed: 1,
        failed: 0,
        caseResults: [{ id: 'a', pass: true, source: 'eval', ...fields }],
      })
    );
    await expect(loadBaseline(file)).rejects.toThrow(
      `Baseline ${file} was written by an earlier MST. 2.0 renamed result fields`
    );
  });
});

const makeResult = (
  overrides: Partial<EvalRunnerResult> = {}
): EvalRunnerResult => ({
  total: 2,
  passed: 1,
  failed: 1,
  caseResults: [
    {
      id: 'a',
      pass: true,
      datasetName: 'test',
      toolName: 'tool',
      source: 'eval',
      durationMs: 100,
      scores: {},
    },
    {
      id: 'b',
      pass: false,
      datasetName: 'test',
      toolName: 'tool',
      source: 'eval',
      durationMs: 200,
      scores: {},
    },
  ],
  durationMs: 300,
  ...overrides,
});

describe('saveBaseline / loadBaseline', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'mcp-baseline-test-'));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('saves and reloads a result round-trip', async () => {
    const result = makeResult();
    const filePath = join(tmpDir, 'baseline.json');
    await saveBaseline(result, filePath);
    const loaded = await loadBaseline(filePath);
    expect(loaded.total).toBe(2);
    expect(loaded.passed).toBe(1);
    expect(loaded.caseResults).toHaveLength(2);
  });

  it('creates parent directories automatically', async () => {
    const result = makeResult();
    const filePath = join(tmpDir, 'nested', 'deep', 'baseline.json');
    await saveBaseline(result, filePath);
    const loaded = await loadBaseline(filePath);
    expect(loaded.total).toBe(2);
  });

  it('throws when baseline file does not exist', async () => {
    await expect(loadBaseline(join(tmpDir, 'missing.json'))).rejects.toThrow();
  });
});
