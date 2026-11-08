import fs from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { HistoryIndexSchema, historyJsonSchema } from './historyFormat.js';

describe('the history format', () => {
  it('matches schema/history/v1 (run `npm run schema:generate`)', async () => {
    const committed = JSON.parse(
      await fs.readFile(
        path.join(
          process.cwd(),
          'schema',
          'history',
          'v1',
          'history.schema.json'
        ),
        'utf8'
      )
    ) as unknown;
    expect(committed).toEqual(historyJsonSchema());
  });

  it('keeps fields it does not know, and refuses another format', () => {
    const index = {
      format: 'mst.history/v1',
      kind: 'history',
      evalName: 'weekly',
      updatedAt: '2026-11-01T00:00:00.000Z',
      runs: [],
      skipped: [],
      later: 1,
    };
    expect(HistoryIndexSchema.parse(index)).toMatchObject({ later: 1 });
    expect(
      HistoryIndexSchema.safeParse({ ...index, format: 'mst.history/v2' })
        .success
    ).toBe(false);
  });
});
