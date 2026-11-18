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
const { createMCPClientForConfig } =
  await import('../../../mcp/clientFactory.js');
const { MCPHttpConnectionError } =
  await import('../../../mcp/connectionDiagnostics.js');

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
    jira: { url: '${auth.origin}/mcp', auth: { type: 'oauth' }, minTools: 4, headers: { 'X-Request-Tag': 'mst' } },
    gmail: { url: '${auth.origin}/mcp', grant: 'google', auth: { type: 'oauth', scopes: ['gmail'] } },
    gcal: { url: '${auth.origin}/mcp', grant: 'google', auth: { type: 'oauth', scopes: ['calendar'] } },
  },
  configs: {
    servers: {
      servers: {
        jira: { connector: 'acme/connector/jira' },
        gmail: { connector: 'acme/connector/gmail' },
        gcal: { connector: 'acme/connector/gcal' },
      },
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
      extends: ['acme/config/servers'],
      variants: [
        {
          name: 'candidate',
          servers: ['jira', 'gmail', 'gcal'],
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
    expect(createMCPClientForConfig).toHaveBeenCalledWith(
      expect.objectContaining({
        serverUrl: `${auth.origin}/mcp`,
        headers: { 'X-Request-Tag': 'mst' },
      })
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

describe('mst auth when the live check of a saved grant fails', () => {
  function refusal(status: number) {
    return new MCPHttpConnectionError({ status }, { status }, false, null);
  }

  async function signedInJira() {
    const config = await project();
    const storeDir = path.join(dir, 'grants');
    const store = localCredentialStore(storeDir);
    const options = { config, store: storeDir, rootDir: dir, server: ['jira'] };
    await signInCommand(options, {
      print: () => {},
      openUrl: async (url) => auth.approve(url),
    });
    const grant = await store.get('acme.jira');
    if (!grant) throw new Error('the sign-in stored no grant');
    return { options, store, grant };
  }

  function run(options: Awaited<ReturnType<typeof signedInJira>>['options']) {
    const lines: string[] = [];
    const openUrl = vi.fn(async (url: string) => auth.approve(url));
    const result = signInCommand(options, {
      print: (line) => lines.push(line),
      openUrl,
    });
    return { lines, openUrl, result };
  }

  it('keeps the grant and opens no browser when the server refuses for a reason a new sign-in cannot fix', async () => {
    const { options, store, grant } = await signedInJira();
    const revokedBefore = [...auth.revoked];
    for (let attempt = 0; attempt < 2; attempt++) {
      vi.mocked(createMCPClientForConfig).mockRejectedValueOnce(refusal(400));
      const { lines, openUrl, result } = run(options);
      await expect(result).rejects.toThrow('Could not verify acme/jira');
      expect(openUrl).not.toHaveBeenCalled();
      expect(lines.join('\n')).toContain(
        'jira: MCP connection failed: streamableHttp=http_400; sse=http_400'
      );
      expect(await store.get('acme.jira')).toEqual(grant);
    }
    expect(auth.revoked).toEqual(revokedBefore);
  });

  it('signs in again when the server rejects the token', async () => {
    const { options, store, grant } = await signedInJira();
    vi.mocked(createMCPClientForConfig).mockRejectedValueOnce(refusal(401));
    const { lines, openUrl, result } = run(options);
    await result;
    expect(openUrl).toHaveBeenCalledTimes(1);
    expect(lines.join('\n')).toMatch(/jira\s+✓ signed in/);
    expect((await store.get('acme.jira'))?.refreshToken).not.toBe(
      grant.refreshToken
    );
  });

  it('reports a failed tools/list by status and never prints the response body', async () => {
    const { options, store, grant } = await signedInJira();
    listTools.mockRejectedValueOnce(
      Object.assign(
        new Error('Error POSTing to endpoint: {"leaked":"BODY-CANARY"}'),
        { status: 503 }
      )
    );
    const { lines, openUrl, result } = run(options);
    await expect(result).rejects.toThrow('Could not verify acme/jira');
    const output = lines.join('\n');
    expect(output).toContain('jira: http_503');
    expect(output).not.toContain('BODY-CANARY');
    expect(openUrl).not.toHaveBeenCalled();
    expect(await store.get('acme.jira')).toEqual(grant);
  });

  it('signs in again when the provider has revoked the refresh token', async () => {
    const { options, store, grant } = await signedInJira();
    await store.put('acme.jira', {
      ...grant,
      accessTokenExpiresAt: new Date(0).toISOString(),
    });
    auth.revokeAll();
    const { lines, openUrl, result } = run(options);
    await result;
    expect(openUrl).toHaveBeenCalledTimes(1);
    expect(lines.join('\n')).toMatch(/jira\s+✓ signed in/);
    expect((await store.get('acme.jira'))?.refreshToken).not.toBe(
      grant.refreshToken
    );
  });

  it('keeps the grant when the token endpoint is down', async () => {
    const { options, store, grant } = await signedInJira();
    const expired = {
      ...grant,
      accessTokenExpiresAt: new Date(0).toISOString(),
    };
    await store.put('acme.jira', expired);
    const routed = globalThis.fetch;
    globalThis.fetch = (async (
      input: string | URL | Request,
      init?: RequestInit
    ) =>
      new URL(new Request(input, init).url).pathname === '/token'
        ? new Response('{"error":"temporarily_unavailable"}', {
            status: 503,
            headers: { 'Content-Type': 'application/json' },
          })
        : routed(input, init)) as typeof fetch;
    const { openUrl, result } = run(options);
    await expect(result).rejects.toThrow('Could not verify acme/jira');
    expect(openUrl).not.toHaveBeenCalled();
    expect(await store.get('acme.jira')).toEqual(expired);
  });

  it('still fails a sign-in whose new token cannot reach the server', async () => {
    const config = await project();
    vi.mocked(createMCPClientForConfig).mockRejectedValueOnce(refusal(400));
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
    expect(lines.join('\n')).toContain('signed in, but jira: MCP connection');
  });
});
