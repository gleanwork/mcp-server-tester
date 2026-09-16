import { constants } from 'node:fs';
import {
  chmod,
  mkdtemp,
  open,
  readFile,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { inspectReadonlySqliteTrace } from '../../../../src/evals/externalHost/sqliteTrace.js';

let root: string;
let writer: DatabaseSync | undefined;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'sqlite-trace-test-'));
  await chmod(root, 0o700);
});

afterEach(async () => {
  writer?.close();
  writer = undefined;
  await rm(root, { recursive: true, force: true });
});

describe('read-only SQLite trace snapshots', () => {
  it('queries a private stable WAL/SHM-inclusive copy without changing its source family', async () => {
    const path = join(root, 'trace.sqlite');
    writer = new DatabaseSync(path);
    writer.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA wal_autocheckpoint = 0;
      CREATE TABLE trace_items (id TEXT PRIMARY KEY, value TEXT NOT NULL);
      INSERT INTO trace_items VALUES ('one', 'from-wal');
    `);
    const family = [path, `${path}-wal`, `${path}-shm`];
    const before = await Promise.all(family.map((file) => readFile(file)));

    const values = await inspectReadonlySqliteTrace(
      {
        root,
        databases: [{ name: 'trace', relativePath: 'trace.sqlite' }],
      },
      (snapshot) =>
        snapshot.database('trace').rows<{
          id: string;
          value: string;
        }>('SELECT id, value FROM trace_items ORDER BY id')
    );

    expect(values).toEqual([{ id: 'one', value: 'from-wal' }]);
    const after = await Promise.all(family.map((file) => readFile(file)));
    expect(after).toEqual(before);
  });

  it('exposes only bounded read queries and named databases', async () => {
    const path = join(root, 'trace.sqlite');
    writer = new DatabaseSync(path);
    writer.exec(`
      CREATE TABLE trace_items (id INTEGER PRIMARY KEY);
      INSERT INTO trace_items VALUES (1), (2), (3);
    `);

    await inspectReadonlySqliteTrace(
      {
        root,
        databases: [
          { name: 'trace', relativePath: 'trace.sqlite', sidecars: 'none' },
        ],
        maxRows: 2,
      },
      (snapshot) => {
        const database = snapshot.database('trace');
        expect(() =>
          database.rows('INSERT INTO trace_items VALUES (4)')
        ).toThrow(/bounded read statements/);
        expect(() =>
          database.rows('SELECT id FROM trace_items ORDER BY id')
        ).toThrow(/row bound/);
        expect(() =>
          database.rows('SELECT id FROM trace_items ORDER BY id', [], {
            maxRows: 3,
          })
        ).toThrow(/row bound/);
        expect(() =>
          database.rows('SELECT id FROM trace_items ORDER BY id LIMIT 2', [], {
            maxRows: 1,
          })
        ).toThrow(/row bound/);
        expect(
          database.rows('SELECT id FROM trace_items ORDER BY id LIMIT 1', [], {
            maxRows: 1,
          })
        ).toEqual([{ id: 1 }]);
        expect(() => snapshot.database('other')).toThrow(/Unknown/);
      }
    );
    expect(
      writer.prepare('SELECT COUNT(*) AS count FROM trace_items').get()
    ).toEqual({
      count: 3,
    });
  });

  it('fails closed for missing required sidecars, symlinks, traversal, and corrupt databases', async () => {
    const plain = join(root, 'plain.sqlite');
    writer = new DatabaseSync(plain);
    writer.exec('CREATE TABLE trace_items (id INTEGER PRIMARY KEY)');

    await expect(
      inspectReadonlySqliteTrace(
        { root, databases: [{ name: 'plain', relativePath: 'plain.sqlite' }] },
        () => undefined
      )
    ).rejects.toThrow(/sidecar/);

    const alias = join(root, 'alias.sqlite');
    await symlink(plain, alias);
    await expect(
      inspectReadonlySqliteTrace(
        {
          root,
          databases: [
            { name: 'alias', relativePath: 'alias.sqlite', sidecars: 'none' },
          ],
        },
        () => undefined
      )
    ).rejects.toThrow();

    await expect(
      inspectReadonlySqliteTrace(
        {
          root,
          databases: [
            {
              name: 'escape',
              relativePath: '../trace.sqlite',
              sidecars: 'none',
            },
          ],
        },
        () => undefined
      )
    ).rejects.toThrow(/normalized and relative/);

    const corrupt = join(root, 'corrupt.sqlite');
    await writeFile(corrupt, 'not sqlite', { mode: 0o600 });
    await expect(
      inspectReadonlySqliteTrace(
        {
          root,
          databases: [
            {
              name: 'corrupt',
              relativePath: 'corrupt.sqlite',
              sidecars: 'none',
            },
          ],
        },
        () => undefined
      )
    ).rejects.toThrow(/cannot be opened read-only|integrity/);
  });

  it('rejects linked or oversized sources before opening SQLite', async () => {
    const linked = join(root, 'linked.sqlite');
    await writeFile(linked, '', { mode: 0o600 });
    const second = join(root, 'second-link.sqlite');
    await open(second, constants.O_WRONLY | constants.O_CREAT, 0o600).then(
      (handle) => handle.close()
    );
    await rm(second);
    await import('node:fs/promises').then(({ link }) => link(linked, second));

    await expect(
      inspectReadonlySqliteTrace(
        {
          root,
          databases: [
            { name: 'linked', relativePath: 'linked.sqlite', sidecars: 'none' },
          ],
        },
        () => undefined
      )
    ).rejects.toThrow(/Unsafe/);

    const oversized = join(root, 'oversized.sqlite');
    await writeFile(oversized, '1234', { mode: 0o600 });
    await expect(
      inspectReadonlySqliteTrace(
        {
          root,
          databases: [
            {
              name: 'oversized',
              relativePath: 'oversized.sqlite',
              sidecars: 'none',
              maxFileBytes: 3,
            },
          ],
        },
        () => undefined
      )
    ).rejects.toThrow(/Unsafe/);
  });
});
