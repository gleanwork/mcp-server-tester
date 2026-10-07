import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetPluginsForTests } from '../../../plugins/extensions.js';
import { fakeAuthServer } from '../../../auth/grants/fakeAuthServer.js';
import { localCredentialStore } from '../../../auth/grants/localStore.js';

const auth = fakeAuthServer();
const listTools = vi.fn(async () => ({
  tools: Array.from({ length: 12 }, (_, index) => ({ name: `t${index}` })),
}));
vi.mock('../../../mcp/clientFactory.js', () => ({
  createMCPClientForConfig: vi.fn(async () => ({ listTools })),
  closeMCPClient: vi.fn(async () => {}),
}));

// The module under test calls the global fetch; route it to the fake server.
const realFetch = globalThis.fetch;
beforeEach(() => {
  globalThis.fetch = (async (
    input: string | URL | Request,
    init?: RequestInit
  ) => {
    const url = new URL(new Request(input, init).url);
    if (url.hostname === '127.0.0.1') return realFetch(input, init);
    return auth.fetch(input, init);
  }) as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = realFetch;
});

const {
  auth: signInCommand,
  authRevoke,
  authStatus,
} = await import('./index.js');

let dir: string;
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mst-auth-cli-'));
});
afterEach(async () => {
  resetPluginsForTests();
  await fs.rm(dir, { recursive: true, force: true });
});

async function project(): Promise<string> {
  const plugin = `
export default {
  meta: { name: 'acme-plugin', namespace: 'acme' },
  connectors: {
    jira: { url: '${auth.origin}/mcp', auth: { type: 'oauth' }, minTools: 4 },
    gmail: { url: '${auth.origin}/mcp', grant: 'google', auth: { type: 'oauth', scopes: ['gmail'] } },
    gcal: { url: '${auth.origin}/mcp', grant: 'google', auth: { type: 'oauth', scopes: ['calendar'] } },
  },
  configs: {
    servers: {
      servers: [
        { connector: 'acme/jira' },
        { connector: 'acme/gmail' },
        { connector: 'acme/gcal' },
      ],
    },
  },
};`;
  await fs.writeFile(path.join(dir, 'plugin.mjs'), plugin);
  await fs.writeFile(
    path.join(dir, 'eval.json'),
    JSON.stringify({
      name: 'e',
      datasets: ['./cases.json'],
      plugins: ['./plugin.mjs'],
      extends: ['acme/servers'],
      variants: [
        {
          name: 'native',
          servers: [
            { connector: 'acme/jira' },
            { connector: 'acme/gmail' },
            { connector: 'acme/gcal' },
          ],
        },
      ],
    })
  );
  return path.join(dir, 'eval.json');
}

describe('mst auth', () => {
  it('signs in once per grant, then reports valid; status and revoke work', async () => {
    const config = await project();
    const store = path.join(dir, 'grants');
    const lines: string[] = [];
    const print = (line: string) => lines.push(line);
    const openUrl = async (url: string) => auth.approve(url);

    await expect(
      authStatus({ config, store, rootDir: dir }, { print })
    ).rejects.toThrow('Not signed in: jira, gmail, gcal');

    lines.length = 0;
    await signInCommand({ config, store, rootDir: dir }, { print, openUrl });
    // jira, then one sign-in for gmail and gcal together, with both scopes.
    expect(lines.filter((line) => line.includes('✓ signed in'))).toHaveLength(
      2
    );
    expect(lines.join('\n')).toMatch(/gmail, gcal\s+✓ signed in/);
    expect(auth.lastAuthorization?.searchParams.get('scope')).toBe(
      'gmail calendar offline_access'
    );

    lines.length = 0;
    await signInCommand({ config, store, rootDir: dir }, { print, openUrl });
    expect(lines.filter((line) => line.includes('✓ valid'))).toHaveLength(2);
    expect(lines.join('\n')).toContain('(one acme/google grant)');

    lines.length = 0;
    await authStatus({ config, store, rootDir: dir }, { print });
    expect(lines.join('\n')).toMatch(/jira\s+✓ refreshable/);

    lines.length = 0;
    await authRevoke(
      { config, store, rootDir: dir, server: ['gcal'] },
      { print }
    );
    expect(lines).toEqual(['gcal  ✓ revoked acme/google']);
    expect(
      await localCredentialStore(store).get('acme.google')
    ).toBeUndefined();
    expect(await localCredentialStore(store).get('acme.jira')).toBeDefined();
  });

  it('fails when a sign-in exposes too few tools', async () => {
    const config = await project();
    listTools.mockResolvedValueOnce({ tools: [{ name: 'only' }] });
    const lines: string[] = [];
    await expect(
      signInCommand(
        {
          config,
          store: path.join(dir, 'grants'),
          rootDir: dir,
          server: ['jira'],
        },
        {
          print: (line) => lines.push(line),
          openUrl: async (url) => auth.approve(url),
        }
      )
    ).rejects.toThrow('Sign-in failed for acme/jira.');
    expect(lines.join('\n')).toContain('1 tools, expected at least 4');
  });

  it('rejects an unknown --server', async () => {
    const config = await project();
    await expect(
      signInCommand({
        config,
        store: path.join(dir, 'g'),
        rootDir: dir,
        server: ['slack'],
      })
    ).rejects.toThrow('No connector server labelled slack');
  });
});
