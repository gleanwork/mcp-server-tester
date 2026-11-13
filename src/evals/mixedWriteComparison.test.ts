import { describe, expect, it } from 'vitest';
import type { WriteRecord } from '../types/index.js';
import type { EvalCaseResult } from '../types/reporter.js';
import { mixedWriteComparisonSkipReason } from './mixedWriteComparison.js';

const planned = { notes: 'planned' as const };
const serverPlanned = { glean: 'server-planned' as const };

function record(patch: Partial<WriteRecord> = {}): WriteRecord {
  return {
    writes: [],
    unreported: 0,
    unrecorded: [],
    unclassified: [],
    attribution: 'exclusive',
    ...patch,
  };
}

function result(writeRecord?: WriteRecord): EvalCaseResult {
  return { id: 'case', writeRecord } as EvalCaseResult;
}

describe('mixed write comparison evidence', () => {
  it('compares clean records and leaves same-mode comparisons unchanged', () => {
    expect(
      mixedWriteComparisonSkipReason(
        result(record()),
        result(record()),
        planned,
        serverPlanned,
        true
      )
    ).toBeUndefined();
    expect(
      mixedWriteComparisonSkipReason(
        result(),
        result(),
        planned,
        planned,
        false
      )
    ).toBeUndefined();
    expect(
      mixedWriteComparisonSkipReason(
        result(record()),
        result(),
        planned,
        { docs: 'read-only' },
        true
      )
    ).toBeUndefined();
  });

  it('requires recorded modes and write records for an opted-in run', () => {
    expect(
      mixedWriteComparisonSkipReason(
        result(),
        result(),
        undefined,
        planned,
        true
      )
    ).toMatch(/no recorded write modes/);
    expect(
      mixedWriteComparisonSkipReason(
        result(),
        result(),
        undefined,
        planned,
        false
      )
    ).toBeUndefined();
    expect(
      mixedWriteComparisonSkipReason(
        result(),
        result(record()),
        planned,
        serverPlanned,
        true
      )
    ).toMatch(/no write record/);
  });

  it.each([
    {
      writes: [
        {
          server: 'notes',
          tool: 'create',
          arguments: {},
          mode: 'planned' as const,
        },
      ],
    },
    { unreported: 1 },
  ])('skips writes in either variant: %j', (patch) => {
    const affected = result(record(patch));
    const clean = result(record());
    expect(
      mixedWriteComparisonSkipReason(
        affected,
        clean,
        planned,
        serverPlanned,
        true
      )
    ).toMatch(/attempted a write/);
    expect(
      mixedWriteComparisonSkipReason(
        clean,
        affected,
        planned,
        serverPlanned,
        true
      )
    ).toMatch(/attempted a write/);
  });

  it.each([
    { unrecorded: [{ server: 'notes', tool: 'create' }] },
    {
      unclassified: [
        {
          server: 'glean',
          tool: 'dispatch',
          arguments: {},
          reason: 'dispatch' as const,
        },
      ],
    },
    { attribution: 'matched' as const },
  ])('skips ambiguous evidence: %j', (patch) => {
    expect(
      mixedWriteComparisonSkipReason(
        result(record(patch)),
        result(record()),
        planned,
        serverPlanned,
        true
      )
    ).toMatch(/incomplete write evidence/);
  });

  it('checks every trial instead of only the last one', () => {
    const multiple = {
      ...result(),
      trialResults: [
        { pass: true, durationMs: 1, writeRecord: record() },
        { pass: true, durationMs: 1, writeRecord: record({ unreported: 1 }) },
      ],
    };
    expect(
      mixedWriteComparisonSkipReason(
        multiple,
        result(record()),
        planned,
        serverPlanned,
        true
      )
    ).toMatch(/attempted a write/);
  });

  it('skips a missing or failed trial but not a trial with only a grading error', () => {
    const clean = result(record());
    expect(
      mixedWriteComparisonSkipReason(
        { ...result(), trialResults: [] },
        clean,
        planned,
        serverPlanned,
        true
      )
    ).toMatch(/no trial evidence/);
    expect(
      mixedWriteComparisonSkipReason(
        { ...result(record()), error: 'client failed' },
        clean,
        planned,
        serverPlanned,
        true
      )
    ).toMatch(/incomplete evidence/);
    expect(
      mixedWriteComparisonSkipReason(
        {
          ...result(record()),
          error: 'grader failed',
          gradingError: 'grader failed',
        },
        clean,
        planned,
        serverPlanned,
        true
      )
    ).toBeUndefined();
  });
});
