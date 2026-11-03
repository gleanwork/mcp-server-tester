import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { listClientCommand, showClient } from './index.js';
import { CLIENT_DOCS_FILE, clientDocsBlock, withClientDocs } from './docs.js';
import { resetPluginsForTests } from '../../../plugins/extensions.js';
import { assertPlugin } from '../../../plugins/plugin.js';

let dir: string;
let pluginPath: string;

// A plugin module with two clients, loaded as --plugins loads one.
const PLUGIN = `
import { z } from 'zod';
export default {
  meta: { name: 'acme-plugin', namespace: 'acme' },
  clients: {
    desk: {
      description: 'The Acme desktop app',
      requirements: {
        os: ['macos'],
        install: ['the Acme app, signed in'],
        credentials: ['\`ACME_API_KEY\`'],
        setup: ['\`acme setup\`'],
      },
      schema: z.object({ maxActions: z.number().int().default(40) }).strict(),
      async run() { return { finalText: '', events: [] }; },
    },
    bare: {
      schema: z.object({}),
      async run() { return { finalText: '', events: [] }; },
    },
  },
};
`;

function capture(): { text: () => string; print: (text: string) => void } {
  let out = '';
  return { text: () => out, print: (text) => (out += text) };
}

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mst-clients-'));
  pluginPath = path.join(dir, 'plugin.mjs');
  await fs.writeFile(pluginPath, PLUGIN);
  // The plugin imports zod: resolve it from this package.
  await fs.symlink(
    path.resolve('node_modules'),
    path.join(dir, 'node_modules'),
    'dir'
  );
});
afterEach(async () => {
  resetPluginsForTests();
  await fs.rm(dir, { recursive: true, force: true });
});

describe('mst clients', () => {
  it('lists the built-in clients with where each one runs', async () => {
    const out = capture();
    await listClientCommand({}, out.print);
    const lines = out.text().trim().split('\n');
    expect(lines.map((line) => line.split(/\s+/)[0])).toEqual([
      'api',
      'chatgpt',
      'claude-code',
      'codex',
      'cowork',
    ]);
    expect(out.text()).toMatch(/^cowork\s+macOS, Linux\s+Claude Desktop/m);
    expect(out.text()).toMatch(/^codex\s+any OS\s+The Codex CLI/m);
  });

  it("adds a plugin's clients, and lists them as JSON", async () => {
    const out = capture();
    await listClientCommand({ plugins: [pluginPath], json: true }, out.print);
    const listed = JSON.parse(out.text()) as Array<{
      ref: string;
      description?: string;
      requirements: { os?: string[] };
    }>;
    expect(listed.map((client) => client.ref)).toEqual(
      expect.arrayContaining(['acme/client/desk', 'acme/client/bare', 'api'])
    );
    expect(listed.find((client) => client.ref === 'acme/client/desk')).toEqual(
      expect.objectContaining({
        description: 'The Acme desktop app',
        requirements: expect.objectContaining({ os: ['macos'] }),
      })
    );
    // A client that says nothing has no description and needs nothing.
    expect(listed.find((client) => client.ref === 'acme/client/bare')).toEqual({
      ref: 'acme/client/bare',
      requirements: {},
    });
  });

  it("lists and shows an eval config's plugins' clients", async () => {
    const config = path.join(dir, 'eval.json');
    await fs.writeFile(
      config,
      JSON.stringify({
        name: 'x',
        plugins: ['./plugin.mjs'],
        datasets: ['./cases.json'],
      })
    );
    const list = capture();
    await listClientCommand({ config, rootDir: dir, json: true }, list.print);
    expect(
      (JSON.parse(list.text()) as Array<{ ref: string }>).map(
        (client) => client.ref
      )
    ).toContain('acme/client/desk');
    const show = capture();
    await showClient(
      'acme/client/desk',
      { config, rootDir: dir, json: true },
      show.print
    );
    expect(JSON.parse(show.text())).toMatchObject({
      ref: 'acme/client/desk',
      description: 'The Acme desktop app',
    });
  });

  it("shows a client's requirements and options", async () => {
    const out = capture();
    await showClient('acme/client/desk', { plugins: [pluginPath] }, out.print);
    const text = out.text();
    expect(text).toMatch(/^acme\/client\/desk {2}The Acme desktop app$/m);
    expect(text).toMatch(/runs on\s+macOS/);
    expect(text).toMatch(/install\s+the Acme app, signed in/);
    expect(text).toMatch(/credentials\s+`ACME_API_KEY`/);
    expect(text).toMatch(/setup\s+`acme setup`/);
    expect(text).toContain('"maxActions"');
  });

  it("shows a built-in client's options as JSON Schema", async () => {
    const out = capture();
    await showClient('codex', { json: true }, out.print);
    const shown = JSON.parse(out.text()) as {
      ref: string;
      requirements: { install?: string[] };
      options: { type?: string; properties?: Record<string, unknown> };
    };
    expect(shown.ref).toBe('codex');
    expect(shown.requirements.install?.[0]).toContain('@openai/codex-sdk');
    expect(shown.options.type).toBe('object');
  });

  it('takes a built-in by its full reference, and names a renamed one', async () => {
    const out = capture();
    await showClient('mst/client/cowork', { json: true }, out.print);
    expect((JSON.parse(out.text()) as { ref: string }).ref).toBe('cowork');
    await expect(
      showClient('chatgpt-mac', {}, capture().print)
    ).rejects.toThrow('Client "chatgpt-mac" is now "chatgpt".');
  });

  it('says what it knows when a client is unknown', async () => {
    await expect(showClient('nope', {}, capture().print)).rejects.toThrow(
      'Client "nope" is not available. Available: api, chatgpt, claude-code, codex, cowork.'
    );
    await expect(
      showClient('acme/client/desk', {}, capture().print)
    ).rejects.toThrow(
      'Client "acme/client/desk" needs the "acme" plugin, which is not loaded. Plugin clients need --plugins or --config.'
    );
    await expect(
      showClient('acme/judge/completeness', {}, capture().print)
    ).rejects.toThrow(
      /^"acme\/judge\/completeness" is a judge, not a client\.$/
    );
  });
});

describe('the clients table in the docs', () => {
  it('matches the built-in definitions (run `npm run docs:clients`)', async () => {
    const docs = await fs.readFile(CLIENT_DOCS_FILE, 'utf8');
    expect(withClientDocs(docs, await clientDocsBlock())).toBe(docs);
  });

  it('needs its markers', () => {
    expect(() => withClientDocs('# Clients\n', 'table')).toThrow(
      /has no <!-- clients:start/
    );
  });
});

describe("a plugin client's description and requirements", () => {
  const client = (extra: Record<string, unknown>) => ({
    meta: { name: 'acme-plugin', namespace: 'acme' },
    clients: {
      desk: { schema: z.object({}), run: async () => ({}), ...extra },
    },
  });

  it.each([
    [{ description: 3 }, 'description must be a string'],
    [{ requirements: [] }, 'requirements must be an object'],
    [
      { requirements: { os: ['windows'] } },
      'requirements.os must list macos or linux',
    ],
    [{ requirements: { os: [] } }, 'requirements.os must list macos or linux'],
    [
      { requirements: { install: 'claude' } },
      'requirements.install must be a list of strings',
    ],
    [
      { requirements: { credentials: [1] } },
      'requirements.credentials must be a list of strings',
    ],
    [{ requirements: { needs: [] } }, 'requirements has no "needs"'],
  ])('rejects %j', (extra, message) => {
    expect(() => assertPlugin(client(extra), 'acme-plugin')).toThrow(message);
  });

  it('accepts a full set', () => {
    expect(() =>
      assertPlugin(
        client({
          description: 'The Acme desktop app',
          requirements: {
            os: ['macos', 'linux'],
            install: ['the Acme app'],
            credentials: ['`ACME_API_KEY`'],
            setup: ['`acme setup`'],
          },
        }),
        'acme-plugin'
      )
    ).not.toThrow();
  });
});
