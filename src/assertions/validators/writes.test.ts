import { describe, expect, it } from 'vitest';
import { validateWrites } from './writes.js';
import type { RecordedWrite, WriteRecord } from '../../types/index.js';

function write(
  tool: string,
  args: Record<string, unknown> = {},
  extra: Partial<RecordedWrite> = {}
): RecordedWrite {
  return { server: 'notes', tool, arguments: args, mode: 'planned', ...extra };
}

function record(overrides: Partial<WriteRecord> = {}): WriteRecord {
  return {
    writes: [],
    unreported: 0,
    unrecorded: [],
    unclassified: [],
    attribution: 'exclusive',
    ...overrides,
  };
}

describe('validateWrites', () => {
  it('fails a trial with no write record', () => {
    const result = validateWrites(undefined, {
      calls: [{ tool: 'create_note' }],
    });
    expect(result.pass).toBe(false);
    expect(result.message).toMatch(/no write record/);
  });

  it('passes when the record has each expected write, as requested', () => {
    const result = validateWrites(
      record({ writes: [write('create_note', { title: 'Q3', body: 'x' })] }),
      { calls: [{ tool: 'create_note', arguments: { title: 'Q3' } }] }
    );
    expect(result).toMatchObject({ pass: true, evidence: 'requested' });
  });

  it('fails a missing write and names it', () => {
    const result = validateWrites(
      record({ writes: [write('create_note', { title: 'Q2' })] }),
      { calls: [{ tool: 'create_note', arguments: { title: 'Q3' } }] }
    );
    expect(result.pass).toBe(false);
    expect(result.message).toMatch(/not in the record: create_note with/);
  });

  it('skips writes that are not required', () => {
    const result = validateWrites(record(), {
      calls: [{ tool: 'create_note', required: false }],
    });
    expect(result.pass).toBe(true);
  });

  it('matches a server when the expected write names one', () => {
    const result = validateWrites(record({ writes: [write('create_note')] }), {
      calls: [{ server: 'tracker', tool: 'create_note' }],
    });
    expect(result.pass).toBe(false);
  });

  it('matches a dispatcher write by its target', () => {
    const result = validateWrites(
      record({
        writes: [write('dispatch', {}, { target: 'create_note' })],
      }),
      { calls: [{ tool: 'create_note' }] }
    );
    expect(result.pass).toBe(true);
  });

  it('counts a write found only as an unclassified call as called', () => {
    const result = validateWrites(
      record({
        unclassified: [
          {
            server: 'notes',
            tool: 'dispatch',
            target: 'create_note',
            arguments: {},
            reason: 'dispatch',
          },
        ],
      }),
      { calls: [{ tool: 'create_note' }] }
    );
    expect(result).toMatchObject({ pass: true, evidence: 'called' });
  });

  it('checks order when it is strict', () => {
    const writes = [write('delete_note'), write('create_note')];
    expect(
      validateWrites(record({ writes }), {
        calls: [{ tool: 'create_note' }, { tool: 'delete_note' }],
        order: 'strict',
      }).pass
    ).toBe(false);
    expect(
      validateWrites(record({ writes }), {
        calls: [{ tool: 'delete_note' }, { tool: 'create_note' }],
        order: 'strict',
      }).pass
    ).toBe(true);
  });

  it('fails writes outside the list when it is exclusive', () => {
    const result = validateWrites(
      record({ writes: [write('create_note'), write('delete_note')] }),
      { calls: [{ tool: 'create_note' }], exclusive: true }
    );
    expect(result.pass).toBe(false);
    expect(result.message).toMatch(
      /outside the expected list: notes\.delete_note/
    );
  });

  it('fails unreported and unrecorded writes whatever the case expects', () => {
    expect(
      validateWrites(record({ unreported: 1 }), undefined).message
    ).toMatch(/unreported/);
    expect(
      validateWrites(
        record({ unrecorded: [{ server: 'notes', tool: 'create_note' }] }),
        undefined
      ).message
    ).toMatch(/unrecorded\): notes\.create_note/);
  });
});
