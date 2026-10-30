import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  OPTIMIZATION_FORMAT,
  findOptimization,
  optimizationDirectory,
  readOptimizationRecord,
  writeOptimizationRecord,
} from './optimizationFormat.js';
import type { OptimizationRecord } from './optimizationFormat.js';
import { servedToolsChange } from './servedTools.js';
import { describeExpectation } from './optimizationReport.js';

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(
    dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true }))
  );
});

function record(id: string): OptimizationRecord {
  return {
    format: OPTIMIZATION_FORMAT,
    kind: 'optimization',
    id,
    evalName: 'search',
    createdAt: '2026-10-21T00:00:00.000Z',
    updatedAt: '2026-10-21T00:00:00.000Z',
    mst: { version: '2.0.0' },
    baseVariant: 'default',
    metric: 'passRate',
    better: 'higher',
    rules: {
      regressionCheck: 'significant',
      regressionTag: 'regression',
      heldOutTag: 'held-out',
      allowRegressions: false,
    },
    baseline: { runId: '20261021T000000Z-aaaaaa' },
    grouping: { source: 'declared' },
    rounds: [],
  };
}

describe('mst.optimization/v1 records', () => {
  it('writes, finds by the end of the id or as the latest, and reads back', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'opt-format-'));
    dirs.push(dir);
    const first = record('20261021T000000Z-111111');
    const second = record('20261021T010000Z-222222');
    await writeOptimizationRecord(dir, first);
    await writeOptimizationRecord(dir, second);

    expect(await findOptimization(dir)).toBe(second.id);
    expect(await findOptimization(dir, '111111')).toBe(first.id);
    await expect(findOptimization(dir, 'nope')).rejects.toThrow(
      /No tool optimization "nope".*There are:/
    );
    expect(
      await readOptimizationRecord(optimizationDirectory(dir, first.id))
    ).toEqual(first);
  });

  it('says when a newer MST wrote the record', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'opt-format-'));
    dirs.push(dir);
    await fs.writeFile(
      path.join(dir, 'optimization.json'),
      JSON.stringify({ format: 'mst.optimization/v2' })
    );
    await expect(readOptimizationRecord(dir)).rejects.toThrow(/newer MST/);
  });

  it('says there is none to continue', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'opt-format-'));
    dirs.push(dir);
    await expect(findOptimization(dir)).rejects.toThrow(/mst optimize start/);
  });
});

describe('servedToolsChange', () => {
  const tool = (name: string, description: string) => ({
    name,
    description,
    inputSchema: { type: 'object' as const, properties: {} },
  });

  it('ignores what the model does not see, and names what it does', () => {
    const before = [
      {
        server: 'glean',
        tools: [tool('search', 'Search.'), tool('chat', 'Chat.')],
      },
    ];
    expect(
      servedToolsChange(before, [
        {
          server: 'glean',
          tools: [
            {
              ...tool('search', 'Search.'),
              annotations: { readOnlyHint: true },
            },
            tool('chat', 'Chat.'),
          ],
        },
      ])
    ).toBeUndefined();
    expect(
      servedToolsChange(before, [
        {
          server: 'glean',
          tools: [tool('search', 'Search the company.'), tool('read', 'Read.')],
        },
      ])
    ).toMatch(/added .*read.*; removed .*chat.*; changed .*search/);
  });
});

describe('describeExpectation', () => {
  it('words tool-call assertions', () => {
    expect(
      describeExpectation({
        toolsTriggered: {
          calls: [
            { name: 'search', required: true },
            { name: 'read_document', required: false },
          ],
          exclusive: true,
        },
        judges: ['correctness'],
      })
    ).toBe(
      'must call search; may call read_document; any other tool fails; also checked: judges'
    );
    expect(describeExpectation({ toolCallCount: { max: 0 } })).toBe(
      'no tool call at all'
    );
  });
});
