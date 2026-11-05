import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { listClientCommand, showClient } from './index.js';
import { CLIENT_DOCS_FILE, clientDocsBlock, withClientDocs } from './docs.js';
import { resetPluginsForTests } from '../../../plugins/extensions.js';
import { assertPlugin } from '../../../plugins/plugin.js';
import {
  getBuiltinClientConfig,
  getClient,
} from '../../../evals/builtinClients.js';

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
      schema: z.object({
        maxActions: z.number().int().default(40),
        enabled: z.boolean().default(false),
        retries: z.number().default(0),
        label: z.string().nullable().default(null),
        required: z.string(),
        optional: z.string().optional(),
      }).strict(),
      async run() { return { finalText: '', events: [] }; },
    },
    bare: {
      schema: z.object({}),
      async run() { return { finalText: '', events: [] }; },
    },
    choice: {
      schema: z.union([
        z.object({ mode: z.literal('fast'), turns: z.number().default(3) }),
        z.object({ mode: z.literal('custom'), instruction: z.string() }),
      ]),
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
  vi.restoreAllMocks();
  await fs.rm(dir, { recursive: true, force: true });
});

describe('mst clients', () => {
  it('lists the built-in clients with where each one runs', async () => {
    const out = capture();
    await listClientCommand({}, out.print);
    const lines = out
      .text()
      .trim()
      .split('\n')
      .filter((line) => /^\S/.test(line));
    expect(lines.map((line) => line.split(/\s+/)[0])).toEqual([
      'api',
      'chatgpt',
      'claude-code',
      'codex-app',
      'codex-cli',
      'cowork',
    ]);
    expect(out.text()).toMatch(
      /^cowork\s+Claude Desktop[^\n]*\n\s+runs on\s+macOS, Linux/m
    );
    expect(out.text()).toMatch(
      /^codex-cli\s+The Codex CLI[^\n]*\n\s+runs on\s+any OS/m
    );
    expect(out.text()).toMatch(
      /^codex-app\s+The Codex surface of the ChatGPT desktop app\n\s+runs on\s+macOS, Linux/m
    );
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
      options: expect.objectContaining({ type: 'object', properties: {} }),
    });
  });

  it('shows an empty plugin options schema as none declared', async () => {
    const out = capture();
    await showClient('acme/client/bare', { plugins: [pluginPath] }, out.print);
    expect(out.text()).toContain('acme/client/bare');
    expect(out.text()).toContain('options (defaults; timeout in ms)');
    expect(out.text()).toContain('(none declared)');
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
    expect(text).toMatch(/maxActions\s+40/);
  });

  it.each([
    ['api', { 'x-defaultDescription': 'none (no time limit)' }],
    ['claude-code', { default: 180_000 }],
    ['codex-cli', { default: 300_000 }],
    ['cowork', { default: 900_000 }],
    ['chatgpt', { default: 300_000 }],
    ['codex-app', { default: 300_000 }],
  ])('shows the runtime timeout default for %s', async (ref, expected) => {
    const out = capture();
    await showClient(ref, { json: true }, out.print);
    const shown = JSON.parse(out.text()) as {
      options: { properties: Record<string, unknown> };
    };
    expect(shown.options.properties.timeout).toMatchObject(expected);
  });

  it('lists the same requirements, options and defaults that show prints in both formats', async () => {
    const json = capture();
    const text = capture();
    await listClientCommand({ json: true }, json.print);
    await listClientCommand({}, text.print);
    const entries = JSON.parse(json.text()) as Array<{ ref: string }>;
    for (const entry of entries) {
      const shownJson = capture();
      const shownText = capture();
      await showClient(entry.ref, { json: true }, shownJson.print);
      await showClient(entry.ref, {}, shownText.print);
      expect(JSON.parse(shownJson.text())).toEqual(entry);
      expect(text.text()).toContain(shownText.text().trim());
    }
    expect(text.text()).toMatch(/timeout\s+none \(no time limit\)/);
    expect(text.text()).toMatch(/timeout\s+180000/);
    expect(text.text()).toMatch(/timeout\s+300000/);
    expect(text.text()).toMatch(/timeout\s+900000/);
  });

  it('lists every usable option, excluding the client tag and removed names', async () => {
    const expected: Record<string, string[]> = {
      api: [
        'model',
        'maxToolCalls',
        'timeout',
        'temperature',
        'maxTokens',
        'provider',
        'apiKeyEnvVar',
        'systemPrompt',
        'skills',
        'env',
      ],
      'claude-code': [
        'model',
        'timeout',
        'systemPrompt',
        'provider',
        'isolate',
        'cwd',
        'env',
      ],
      'codex-cli': [
        'model',
        'timeout',
        'systemPrompt',
        'reasoningEffort',
        'sandbox',
        'webSearch',
        'cwd',
        'apiKeyEnvVar',
        'env',
      ],
      cowork: [
        'maxActions',
        'hitlMaxActions',
        'computerUseModel',
        'dataDir',
        'appVersion',
        'pluginRoots',
        'mcpDataRoot',
        'timeout',
        'model',
        'env',
        'plugins',
      ],
      chatgpt: [
        'model',
        'reasoningEffort',
        'timeout',
        'env',
        'plugins',
        'configPath',
        'requireMcpCalls',
        'correlation',
        'maxActions',
        'computerUseModel',
      ],
      'codex-app': [
        'model',
        'reasoningEffort',
        'timeout',
        'env',
        'plugins',
        'configPath',
        'requireMcpCalls',
        'correlation',
        'maxActions',
        'computerUseModel',
      ],
    };
    for (const [client, names] of Object.entries(expected)) {
      const out = capture();
      await showClient(client, {}, out.print);
      const rows = out
        .text()
        .split('  options (defaults; timeout in ms)\n')[1]!
        .trim()
        .split('\n');
      expect(rows.map((line) => line.trim().split(/\s+/)[0]).sort()).toEqual(
        [...names].sort()
      );
      expect(out.text()).not.toContain('not declared');
    }
  });

  it('documents OS-specific defaults without resolving them on the listing machine', async () => {
    for (const client of ['chatgpt', 'codex-app']) {
      const outputs: string[] = [];
      for (const os of ['darwin', 'linux'] as const) {
        vi.spyOn(process, 'platform', 'get').mockReturnValue(os);
        const out = capture();
        await showClient(client, { json: true }, out.print);
        outputs.push(out.text());
        const shown = JSON.parse(out.text()) as {
          options: { properties: Record<string, unknown> };
        };
        expect(shown.options.properties.maxActions).toMatchObject({
          'x-defaultDescription': 'macOS: 32; Linux: 24',
        });
        expect(shown.options.properties.model).toMatchObject({
          'x-defaultDescription': 'required',
        });
        expect(shown.options.properties.correlation).toMatchObject({
          default: 'exact_prompt',
        });
        expect(shown.options.properties.computerUseModel).toMatchObject({
          'x-defaultDescription':
            'macOS: MST_COWORK_CUA_MODEL or claude-sonnet-4-6; Linux: no planner',
        });
      }
      expect(outputs[0]).toBe(outputs[1]);
    }
  });

  it('keeps omitted timeouts distinct from overrides and no timeout', () => {
    expect(getBuiltinClientConfig('api').timeout).toBeUndefined();
    const claude = getBuiltinClientConfig('claude-code');
    expect(claude.timeout).toBeUndefined();
    expect(claude.cli?.timeout).toBe(180_000);
    for (const client of ['api', 'claude-code', 'codex-cli']) {
      expect(
        getClient(client).schema.parse({ type: client })
      ).not.toHaveProperty('timeout');
      expect(
        getClient(client).schema.parse({ type: client, timeout: 1_234 })
      ).toMatchObject({ timeout: 1_234 });
      for (const timeout of [null, 0])
        expect(
          getClient(client).schema.safeParse({ type: client, timeout }).success
        ).toBe(false);
    }
    expect(getBuiltinClientConfig('api', { timeout: 1_234 }).timeout).toBe(
      1_234
    );
    expect(
      getBuiltinClientConfig('claude-code', { timeout: 1_234 }).cli?.timeout
    ).toBe(1_234);
  });

  it("shows a built-in client's options as JSON Schema", async () => {
    const out = capture();
    await showClient('codex-cli', { json: true }, out.print);
    const shown = JSON.parse(out.text()) as {
      ref: string;
      requirements: { install?: string[] };
      options: { type?: string; properties?: Record<string, unknown> };
    };
    expect(shown.ref).toBe('codex-cli');
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

  it('shows codex-app by either name, without a surface option', async () => {
    for (const ref of ['codex-app', 'mst/client/codex-app']) {
      const out = capture();
      await showClient(ref, { json: true }, out.print);
      const shown = JSON.parse(out.text()) as {
        ref: string;
        requirements: { setup?: string[] };
        options: { properties?: Record<string, { not?: unknown }> };
      };
      expect(shown.ref).toBe('codex-app');
      expect(shown.requirements.setup).toEqual([
        'Docker: `mst env setup docker --config <a Codex app eval>`',
      ]);
      // `surface` is still a key, so it fails naming its replacement, but
      // it takes no value.
      expect(shown.options.properties?.surface).toEqual({ not: {} });
    }
  });

  it('distinguishes plugin literal defaults, required options and undeclared defaults', async () => {
    const out = capture();
    await showClient(
      'acme/client/desk',
      { plugins: [pluginPath], json: true },
      out.print
    );
    const shown = JSON.parse(out.text()) as {
      options: { properties: Record<string, unknown> };
    };
    expect(shown.options.properties).toMatchObject({
      maxActions: { default: 40 },
      enabled: { default: false },
      retries: { default: 0 },
      label: { default: null },
      required: { 'x-defaultDescription': 'required' },
      optional: { 'x-defaultDescription': 'not declared' },
    });
    const text = capture();
    await showClient('acme/client/desk', { plugins: [pluginPath] }, text.print);
    expect(text.text()).toMatch(/enabled\s+false/);
    expect(text.text()).toMatch(/retries\s+0/);
    expect(text.text()).toMatch(/label\s+null/);
    expect(text.text()).toMatch(/required\s+required/);
    expect(text.text()).toMatch(/optional\s+not declared/);
  });

  it('keeps a non-object plugin schema visible rather than claiming it has no options', async () => {
    const out = capture();
    await showClient(
      'acme/client/choice',
      { plugins: [pluginPath] },
      out.print
    );
    expect(out.text()).toContain('"turns"');
    expect(out.text()).toContain('"default": 3');
    expect(out.text()).toContain('"instruction"');
    expect(out.text()).not.toContain('(none declared)');
  });

  it.each(['chatgpt', 'codex-app'] as const)(
    'lists %s requireMcpCalls as off without materializing the omitted option',
    async (client) => {
      const json = capture();
      await showClient(client, { json: true }, json.print);
      expect(JSON.parse(json.text())).toMatchObject({
        options: { properties: { requireMcpCalls: { default: false } } },
      });
      const text = capture();
      await showClient(client, {}, text.print);
      expect(text.text()).toMatch(/requireMcpCalls\s+false/);
      const schema = getClient(client).schema;
      const config = { type: client, model: 'test-model' };
      expect(schema.parse(config)).not.toHaveProperty('requireMcpCalls');
      for (const requireMcpCalls of [false, true]) {
        expect(schema.parse({ ...config, requireMcpCalls })).toMatchObject({
          requireMcpCalls,
        });
      }
    }
  );

  it.each([
    ['cowork', 900_000],
    ['chatgpt', 300_000],
    ['codex-app', 300_000],
  ] as const)(
    'keeps %s desktop runtime defaults and overrides',
    (client, timeout) => {
      const schema = getClient(client).schema;
      expect(schema.parse({ type: client, model: 'test-model' })).toMatchObject(
        { timeout }
      );
      expect(
        schema.parse({ type: client, model: 'test-model', timeout: 1_234 })
      ).toMatchObject({ timeout: 1_234 });
    }
  );

  it('lists API generation and Cowork action defaults from the runtime settings', async () => {
    const api = capture();
    await showClient('api', { json: true }, api.print);
    const shown = JSON.parse(api.text()) as {
      options: { properties: Record<string, unknown> };
    };
    expect(shown.options.properties).toMatchObject({
      model: { default: 'claude-sonnet-4-20250514' },
      maxToolCalls: { default: 5 },
      temperature: { default: 0 },
      skills: { default: 'off' },
      provider: {
        'x-defaultDescription': 'inferred from model; otherwise anthropic',
      },
    });
    expect(getBuiltinClientConfig('api')).toMatchObject({
      model: 'claude-sonnet-4-20250514',
      maxToolCalls: 5,
      provider: 'anthropic',
    });
    expect(
      getBuiltinClientConfig('api', { model: 'gpt-5', maxToolCalls: 2 })
    ).toMatchObject({ model: 'gpt-5', maxToolCalls: 2, provider: 'openai' });
    const cowork = capture();
    await showClient('cowork', { json: true }, cowork.print);
    expect(JSON.parse(cowork.text())).toMatchObject({
      options: {
        properties: {
          maxActions: { default: 24 },
          hitlMaxActions: { default: 12 },
        },
      },
    });
    expect(getClient('cowork').schema.parse({ type: 'cowork' })).toMatchObject({
      maxActions: 24,
      hitlMaxActions: 12,
    });
  });

  it('says what it knows when a client is unknown', async () => {
    await expect(showClient('nope', {}, capture().print)).rejects.toThrow(
      'Client "nope" is not available. Available: api, chatgpt, claude-code, codex-app, codex-cli, cowork.'
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
