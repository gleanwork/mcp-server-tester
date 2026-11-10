import fs from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { SCHEMA_BASE, schemaId } from './schemaIds.js';

const SCHEMA_DIR = path.join(process.cwd(), 'schema');

describe('schema IDs', () => {
  it('give every published schema one versioned base and its own path', async () => {
    const files = (await fs.readdir(SCHEMA_DIR, { recursive: true }))
      .filter((file) => file.endsWith('.schema.json'))
      .map((file) => file.split(path.sep).join('/'))
      .sort();
    expect(files.length).toBeGreaterThan(10);
    for (const file of files) {
      const schema = JSON.parse(
        await fs.readFile(path.join(SCHEMA_DIR, file), 'utf8')
      ) as { $id?: string };
      expect(schema.$id, file).toBe(schemaId(file));
    }
  });

  it('pin the major version, so a 3.x release cannot change what an ID names', () => {
    expect(SCHEMA_BASE).toMatch(
      /^https:\/\/unpkg\.com\/@gleanwork\/mcp-server-tester@\d+\/schema\/$/
    );
  });
});
