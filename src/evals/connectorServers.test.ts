import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { runEval } from './runEval.js';
import { resetPluginsForTests } from '../plugins/extensions.js';
import type { Plugin } from '../plugins/plugin.js';
import type { MCPConfig, StdioMCPConfig } from '../config/mcpConfig.js';
import { localCredentialStore } from '../auth/grants/localStore.js';
import type { CredentialStore, StoredGrant } from '../auth/grants/types.js';
import {
  ConnectorSignInRequiredError,
  expandConnectorServers,
  startConnectorCredentials,
} from './connectorServers.js';
import { installPlugins } from '../plugins/extensions.js';
import { loadEvalConfigFromObject } from './evalConfig.js';
import { fakeAuthServer } from '../auth/grants/fakeAuthServer.js';

let dir: string;
let store: CredentialStore;
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mst-connectors-'));
  store = localCredentialStore(path.join(dir, 'grants'));
});
afterEach(async () => {
  resetPluginsForTests();
  await fs.rm(dir, { recursive: true, force: true });
});

function grant(overrides: Partial<StoredGrant> = {}): StoredGrant {
  return {
    version: 1,
    type: 'oauth',
    tokenEndpoint: 'https://auth.example/token',
    clientId: 'c',
    refreshToken: 'refresh',
    accessToken: 'stored-access',
    accessTokenExpiresAt: new Date(Date.now() + 3600_000).toISOString(),
    scopes: [],
    resource: 'https://x.example',
    signedInAt: new Date().toISOString(),
    ...overrides,
  };
}

/** Records what the client was given, and what the token file held mid-run. */
const seen: Array<{
  servers: MCPConfig[];
  env: Record<string, string | undefined>;
  files: Record<string, string>;
}> = [];

function testPlugin(): Plugin {
  return {
    meta: { name: 'acme-plugin', namespace: 'acme' },
    connectors: {
      glean: { url: 'https://glean.example/mcp', auth: { type: 'oauth' } },
      slack: {
        url: 'https://slack.example/mcp',
        auth: { type: 'oauth', refreshScope: null },
        minTools: 10,
        launch: ({ url, label, tokenFile }) => ({
          transport: 'stdio',
          command: '/usr/bin/true',
          args: [
            '--upstream',
            url,
            '--name',
            label,
            '--token-file',
            tokenFile!,
          ],
        }),
      },
      gmail: {
        url: 'https://gmail.example/mcp',
        grant: 'google',
        auth: { type: 'oauth', client: async () => ({ clientId: 'g' }) },
        launch: ({ url, tokenFile }) => ({
          transport: 'stdio',
          command: '/usr/bin/true',
          args: [url, tokenFile!],
        }),
      },
      gdrive: {
        url: 'https://drive.example/mcp',
        grant: 'google',
        auth: { type: 'oauth', client: async () => ({ clientId: 'g' }) },
        launch: ({ url, tokenFile }) => ({
          transport: 'stdio',
          command: '/usr/bin/true',
          args: [url, tokenFile!],
        }),
      },
    },
    clients: {
      record: {
        schema: z.object({ type: z.string() }).strict(),
        evidence: 'structured',
        run: async (input) => {
          const files: Record<string, string> = {};
          for (const server of input.servers)
            if (server.transport === 'stdio') {
              const file = server.args?.at(-1);
              if (file?.endsWith('.json'))
                files[server.label!] = await fs.readFile(file, 'utf8');
            }
          seen.push({ servers: input.servers, env: input.env ?? {}, files });
          return { finalText: 'ok', events: [] };
        },
      },
    },
  };
}

async function writeSuite(config: Record<string, unknown>) {
  await fs.writeFile(
    path.join(dir, 'cases.json'),
    JSON.stringify({ name: 'cases', cases: [{ id: 'c1', input: 'q' }] })
  );
  await fs.writeFile(
    path.join(dir, 'eval.json'),
    JSON.stringify({
      name: 'connectors',
      datasets: ['./cases.json'],
      plugins: [],
      client: 'acme/client/record',
      ...config,
    })
  );
  return path.join(dir, 'eval.json');
}

describe('connector servers in a run', () => {
  beforeEach(() => {
    seen.length = 0;
  });

  it('expands connector servers, delivers fresh tokens, and deletes them after the run', async () => {
    await store.put('acme.glean', grant({ accessToken: 'glean-token' }));
    await store.put('acme.slack', grant({ accessToken: 'slack-token' }));
    await store.put('acme.google', grant({ accessToken: 'google-token' }));
    const configPath = await writeSuite({
      variants: [
        {
          name: 'aggregated',
          servers: [{ connector: 'acme/connector/glean' }],
        },
        {
          name: 'native',
          servers: [
            { connector: 'acme/connector/slack' },
            { connector: 'acme/connector/gmail' },
            { connector: 'acme/connector/gdrive', label: 'drive' },
          ],
        },
      ],
    });
    const { summary } = await runEval({
      configPath,
      rootDir: dir,
      plugins: [testPlugin()],
      credentialStore: store,
    });

    const [aggregated, native] = seen;
    // A direct HTTP connection: the token arrives in a run-private env var.
    expect(aggregated!.servers).toEqual([
      {
        transport: 'http',
        label: 'glean',
        serverUrl: 'https://glean.example/mcp',
        auth: { accessToken: 'glean-token' },
      },
    ]);
    // Launched connectors: one private token file per grant.
    const [slack, gmail, drive] = native!.servers as StdioMCPConfig[];
    expect(slack!.label).toBe('slack');
    expect(slack!.minTools).toBe(10);
    expect(drive!.label).toBe('drive');
    const slackFile = slack!.args!.at(-1)!;
    expect(gmail!.args!.at(-1)).toBe(drive!.args!.at(-1));
    expect(JSON.parse(native!.files.slack!)).toEqual({
      version: 1,
      accessToken: 'slack-token',
    });
    expect(JSON.parse(native!.files.gmail!)).toEqual({
      version: 1,
      accessToken: 'google-token',
    });
    expect(
      await fs.stat(path.dirname(slackFile)).catch(() => undefined)
    ).toBeUndefined();
    // No token in the stored summary.
    expect(JSON.stringify(summary)).not.toMatch(
      /glean-token|slack-token|google-token/
    );
  });

  it('fails before any client starts when a grant is missing', async () => {
    await store.put('acme.slack', grant());
    const configPath = await writeSuite({
      servers: [
        { connector: 'acme/connector/slack' },
        { connector: 'acme/connector/gmail' },
      ],
    });
    const error = await runEval({
      configPath,
      rootDir: dir,
      plugins: [testPlugin()],
      credentialStore: store,
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ConnectorSignInRequiredError);
    expect((error as Error).message).toContain('acme/google: not signed in.');
    expect((error as Error).message).toContain(
      `Run: mst auth --config ${configPath}`
    );
    expect(seen).toEqual([]);
  });

  it('dry-runs without tokens', async () => {
    const configPath = await writeSuite({
      servers: [{ connector: 'acme/connector/slack' }],
    });
    await expect(
      runEval({
        configPath,
        rootDir: dir,
        plugins: [testPlugin()],
        credentialStore: store,
        dryRun: true,
      })
    ).resolves.toBeDefined();
  });

  it('rejects an unknown connector', async () => {
    const configPath = await writeSuite({
      servers: [{ connector: 'acme/connector/jira' }],
    });
    await expect(
      runEval({
        configPath,
        rootDir: dir,
        plugins: [testPlugin()],
        credentialStore: store,
      })
    ).rejects.toThrow('Connector "acme/connector/jira" is not available.');
  });
});

describe('startConnectorCredentials', () => {
  async function setup() {
    installPlugins([testPlugin()]);
    const config = loadEvalConfigFromObject(
      {
        name: 'x',
        datasets: [{ type: 'file', path: 'unused' }],
        servers: [{ connector: 'acme/connector/slack' }],
      },
      { skipDatasetValidation: true }
    );
    const expansion = await expandConnectorServers(config, {
      tokenDirectory: path.join(dir, 'tokens'),
    });
    return { expansion, file: path.join(dir, 'tokens', 'acme.slack.json') };
  }

  it('writes a private token file and renews it before the token expires', async () => {
    // Sign in for real against the fake server, so refresh works.
    const auth = fakeAuthServer({ expiresIn: 3600 });
    const { signIn } = await import('../auth/grants/grants.js');
    await signIn(
      {
        key: 'acme.slack',
        name: 'acme/slack',
        urls: [`${auth.origin}/mcp`],
        auth: { type: 'oauth', refreshScope: null },
      },
      store,
      {
        print: () => {},
        openUrl: async (url) => auth.approve(url),
      },
      { fetch: auth.fetch }
    );
    const first = (await store.get('acme.slack'))!.accessToken!;
    const { expansion, file } = await setup();
    const logs: string[] = [];
    const credentials = await startConnectorCredentials(expansion, store, {
      fetch: auth.fetch,
      // Renew almost at once: "expires within the hour" is always true.
      renewBeforeMs: 3600_000,
      minRenewDelayMs: 20,
      log: (line) => logs.push(line),
    });
    try {
      // The first token was already within the renewal window, so it was refreshed.
      const delivered = JSON.parse(await fs.readFile(file, 'utf8')).accessToken;
      expect(delivered).not.toBe(first);
      expect((await fs.stat(path.dirname(file))).mode & 0o777).toBe(0o700);
      expect((await fs.stat(file)).mode & 0o777).toBe(0o600);
      await expect
        .poll(
          async () =>
            (
              JSON.parse(await fs.readFile(file, 'utf8')) as {
                accessToken: string;
              }
            ).accessToken,
          {
            timeout: 2000,
          }
        )
        .not.toBe(delivered);
      expect(logs).toContain('acme/slack: renewed the access token.');
      expect(logs.join('\n')).not.toMatch(/access-/);
    } finally {
      await credentials.stop();
    }
    await expect(fs.stat(file)).rejects.toThrow();
  });

  it('deletes nothing it did not create when there are no connectors', async () => {
    const config = loadEvalConfigFromObject(
      { name: 'x', datasets: [{ type: 'file', path: 'unused' }] },
      { skipDatasetValidation: true }
    );
    const expansion = await expandConnectorServers(config);
    const credentials = await startConnectorCredentials(expansion, store);
    expect(credentials.env).toEqual({});
    await credentials.stop();
  });
});

describe('variant selection', () => {
  afterEach(() => resetPluginsForTests());

  it('needs only the grants the selected variants use', async () => {
    await store.put('acme.slack', grant({ accessToken: 'slack-token' }));
    const configPath = await writeSuite({
      servers: [{ connector: 'acme/connector/glean' }],
      variants: [
        { name: 'aggregated' },
        { name: 'native', servers: [{ connector: 'acme/connector/slack' }] },
      ],
    });
    // Glean is not signed in, but the native variant doesn't use it.
    seen.length = 0;
    const plugin = testPlugin();
    await runEval({
      configPath,
      rootDir: dir,
      plugins: [plugin],
      credentialStore: store,
      variant: 'native',
    });
    expect(seen).toHaveLength(1);
    // The aggregated variant inherits the config's servers, so it needs Glean.
    await expect(
      runEval({
        configPath,
        rootDir: dir,
        plugins: [plugin],
        credentialStore: store,
        variant: 'aggregated',
      })
    ).rejects.toThrow('acme/glean: not signed in.');
  });
});
