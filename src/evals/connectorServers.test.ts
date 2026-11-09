import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from 'vitest';
import { z } from 'zod';
import { runEval } from './runEval.js';
import { resetPluginsForTests } from '../plugins/extensions.js';
import type { Plugin } from '../plugins/plugin.js';
import type { MCPConfig, StdioMCPConfig } from '../config/mcpConfig.js';
import { localCredentialStore } from '../auth/grants/localStore.js';
import type { CredentialStore, StoredGrant } from '../auth/grants/types.js';
import {
  ConnectorSignInRequiredError,
  connectorDeclarations,
  connectorTokenSource,
  expandConnectorServers,
  expandWorkerConnectors,
  startConnectorCredentials,
} from './connectorServers.js';
import { installPlugins } from '../plugins/extensions.js';
import { loadEvalConfigFromObject } from './evalConfig.js';
import { fakeAuthServer } from '../auth/grants/fakeAuthServer.js';
import {
  closeMCPClient,
  createMCPClientForConfig,
} from '../mcp/clientFactory.js';
import { notesProxyServer } from '../../tests/mocks/notesProxy.js';
import type { WriteRecord } from '../types/index.js';
import { buildRunReport } from './runReport.js';
import { readRunDirectory } from './runFormat.js';
import {
  READINESS_SERVER,
  startReadinessHttpServer,
} from '../../tests/mocks/readyServers.js';

// The Acme connector's server: one MST's readiness check reaches.
let acmeUrl = '';
let acmeServer: { close: () => Promise<void> } | undefined;
beforeAll(async () => {
  const server = await startReadinessHttpServer();
  acmeUrl = server.url;
  acmeServer = server;
});
afterAll(() => acmeServer?.close());

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
      acme: { url: acmeUrl, auth: { type: 'oauth' } },
      slack: {
        url: 'https://slack.example/mcp',
        auth: { type: 'oauth', refreshScope: null },
        minTools: 10,
        launch: ({ url, label, tokenFile }) => ({
          transport: 'stdio',
          command: process.execPath,
          env: { READINESS_TOOLS: '10' },
          args: [
            READINESS_SERVER,
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
          command: process.execPath,
          args: [READINESS_SERVER, url, tokenFile!],
        }),
      },
      gdrive: {
        url: 'https://drive.example/mcp',
        grant: 'google',
        auth: { type: 'oauth', client: async () => ({ clientId: 'g' }) },
        launch: ({ url, tokenFile }) => ({
          transport: 'stdio',
          command: process.execPath,
          args: [READINESS_SERVER, url, tokenFile!],
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
    await store.put('acme.acme', grant({ accessToken: 'acme-token' }));
    await store.put('acme.slack', grant({ accessToken: 'slack-token' }));
    await store.put('acme.google', grant({ accessToken: 'google-token' }));
    const configPath = await writeSuite({
      servers: {
        acme: { connector: 'acme/connector/acme' },
        slack: { connector: 'acme/connector/slack' },
        gmail: { connector: 'acme/connector/gmail' },
        drive: { connector: 'acme/connector/gdrive' },
      },
      variants: [
        { name: 'current', servers: ['acme'] },
        { name: 'candidate', servers: ['slack', 'gmail', 'drive'] },
      ],
    });
    const { summary } = await runEval({
      configPath,
      rootDir: dir,
      plugins: [testPlugin()],
      credentialStore: store,
    });

    const [current, candidate] = seen;
    // A direct HTTP connection: the token arrives in a run-private env var.
    expect(current!.servers).toEqual([
      {
        transport: 'http',
        label: 'acme',
        serverUrl: acmeUrl,
        auth: { accessToken: 'acme-token' },
      },
    ]);
    // Launched connectors: one private token file per grant.
    const [slack, gmail, drive] = candidate!.servers as StdioMCPConfig[];
    expect(slack!.label).toBe('slack');
    expect(slack!.minTools).toBe(10);
    expect(drive!.label).toBe('drive');
    const slackFile = slack!.args!.at(-1)!;
    expect(gmail!.args!.at(-1)).toBe(drive!.args!.at(-1));
    expect(JSON.parse(candidate!.files.slack!)).toEqual({
      version: 1,
      accessToken: 'slack-token',
    });
    expect(JSON.parse(candidate!.files.gmail!)).toEqual({
      version: 1,
      accessToken: 'google-token',
    });
    expect(
      await fs.stat(path.dirname(slackFile)).catch(() => undefined)
    ).toBeUndefined();
    // No token in the stored summary.
    expect(JSON.stringify(summary)).not.toMatch(
      /acme-token|slack-token|google-token/
    );
  });

  it('fails before any client starts when a grant is missing', async () => {
    await store.put('acme.slack', grant());
    const configPath = await writeSuite({
      servers: {
        slack: { connector: 'acme/connector/slack' },
        gmail: { connector: 'acme/connector/gmail' },
      },
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
      servers: { slack: { connector: 'acme/connector/slack' } },
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
      servers: { jira: { connector: 'acme/connector/jira' } },
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
        servers: { slack: { connector: 'acme/connector/slack' } },
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

describe('connector servers on a shard (ADR 0004)', () => {
  async function expansionOf(servers: Record<string, unknown>) {
    installPlugins([testPlugin()]);
    const config = loadEvalConfigFromObject(
      { name: 'x', datasets: [{ type: 'file', path: 'unused' }], servers },
      { skipDatasetValidation: true }
    );
    return expandConnectorServers(config, {
      tokenDirectory: path.join(dir, 'tokens'),
    });
  }

  it('gives a worker the declarations and fresh tokens by label', async () => {
    await store.put('acme.acme', grant({ accessToken: 'acme-token' }));
    await store.put('acme.google', grant({ accessToken: 'google-token' }));
    const expansion = await expansionOf({
      acme: { connector: 'acme/connector/acme' },
      gmail: { connector: 'acme/connector/gmail' },
      drive: { connector: 'acme/connector/gdrive' },
    });
    expect([...connectorDeclarations(expansion, '').values()]).toEqual([
      {
        connector: 'acme/connector/acme',
        label: 'acme',
        url: acmeUrl,
      },
      {
        connector: 'acme/connector/gmail',
        label: 'gmail',
        url: 'https://gmail.example/mcp',
      },
      {
        connector: 'acme/connector/gdrive',
        label: 'drive',
        url: 'https://drive.example/mcp',
      },
    ]);
    const source = connectorTokenSource(expansion, store);
    expect(source.labels.sort()).toEqual(['acme', 'drive', 'gmail']);
    expect(source.secrets()).toEqual([]);
    const tokens = await source.tokens(['gmail', 'drive', 'unknown']);
    // What it handed out, for redacting what the workers send back.
    expect(source.secrets()).toEqual(['google-token']);
    // One grant, one token, for both of its servers; an unknown label gets none.
    expect(Object.keys(tokens).sort()).toEqual(['drive', 'gmail']);
    expect(tokens.gmail!.accessToken).toBe('google-token');
    expect(tokens.drive!.accessToken).toBe('google-token');
    expect(tokens.gmail!.expiresAt).toBeGreaterThan(Date.now());
  });

  it("gives each variant its own servers' declarations, by label", async () => {
    installPlugins([testPlugin()]);
    const config = loadEvalConfigFromObject(
      {
        name: 'x',
        datasets: [{ type: 'file', path: 'unused' }],
        servers: { acme: { connector: 'acme/connector/acme' } },
      },
      { skipDatasetValidation: true }
    );
    // A programmatic eval config's variants can carry servers of their own.
    const expansion = await expandConnectorServers(
      {
        ...config,
        variants: [
          { name: 'default' },
          {
            name: 'staging',
            servers: [
              {
                connector: 'acme/connector/acme',
                label: 'acme',
                url: 'https://staging.acme.example/mcp',
              },
            ],
          },
          {
            name: 'direct',
            servers: [
              {
                transport: 'http',
                label: 'acme',
                serverUrl: 'https://direct.example',
              },
            ],
          },
        ],
      },
      { tokenDirectory: path.join(dir, 'tokens') }
    );
    const url = (variant: string) =>
      connectorDeclarations(expansion, variant).get('acme')?.url;
    expect(url('default')).toBe(acmeUrl);
    expect(url('staging')).toBe('https://staging.acme.example/mcp');
    // Its own `acme` isn't a connector: the config's isn't what it runs.
    expect(url('direct')).toBeUndefined();
  });

  it('refreshes a grant once when several shards ask at the same time', async () => {
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
      { print: () => {}, openUrl: async (url) => auth.approve(url) },
      { fetch: auth.fetch }
    );
    const expansion = await expansionOf({
      slack: { connector: 'acme/connector/slack' },
    });
    let refreshes = 0;
    const source = connectorTokenSource(expansion, store, {
      fetch: async (url, init) => {
        const href =
          typeof url === 'string'
            ? url
            : url instanceof URL
              ? url.href
              : url.url;
        if (href.endsWith('/token')) refreshes++;
        return auth.fetch(url, init);
      },
      // Every stored token is due for renewal.
      renewBeforeMs: 3600_000,
    });
    const [first, second] = await Promise.all([
      source.tokens(['slack']),
      source.tokens(['slack']),
    ]);
    expect(refreshes).toBe(1);
    expect(first.slack!.accessToken).toBe(second.slack!.accessToken);
  });

  it("expands a worker's declarations with the worker's paths", async () => {
    installPlugins([testPlugin()]);
    const workerTokens = path.join(dir, 'worker', 'connectors');
    const worker = await expandWorkerConnectors(
      [
        { connector: 'acme/connector/slack', label: 'slack' },
        { connector: 'acme/connector/acme', label: 'acme' },
      ],
      { tokenDirectory: workerTokens }
    );
    const slack = worker.servers.get('slack') as StdioMCPConfig;
    expect(slack.args!.at(-1)).toBe(path.join(workerTokens, 'acme.slack.json'));
    expect(worker.deliveries.get('slack')).toEqual({
      file: path.join(workerTokens, 'acme.slack.json'),
      envNames: [],
    });
    // A direct HTTP connector gets its token in an env var.
    expect(worker.servers.get('acme')).toMatchObject({
      transport: 'http',
      auth: { accessTokenEnv: 'MST_CONNECTOR_TOKEN_ACME' },
    });
    expect(worker.deliveries.get('acme')).toEqual({
      envNames: ['MST_CONNECTOR_TOKEN_ACME'],
    });
    // Expanding writes nothing.
    await expect(fs.stat(workerTokens)).rejects.toThrow();
  });

  it("gives a worker's connectors the run's ID", async () => {
    const contexts: Array<Record<string, unknown>> = [];
    installPlugins([
      {
        meta: { name: 'run-id-plugin', namespace: 'r' },
        connectors: {
          tagged: {
            url: 'https://tagged.example/mcp',
            auth: { type: 'none' },
            launch: (context) => {
              contexts.push({ ...context });
              return { transport: 'stdio', command: '/usr/bin/true' };
            },
          },
        },
      },
    ]);
    await expandWorkerConnectors(
      [{ connector: 'r/connector/tagged', label: 'tagged' }],
      { tokenDirectory: path.join(dir, 'worker'), runId: 'run-1' }
    );
    await expandWorkerConnectors(
      [{ connector: 'r/connector/tagged', label: 'tagged' }],
      { tokenDirectory: path.join(dir, 'worker') }
    );
    expect(contexts.map((context) => context.runId)).toEqual([
      'run-1',
      undefined,
    ]);
    expect('runId' in contexts[1]!).toBe(false);
  });
});

describe('variant selection', () => {
  afterEach(() => resetPluginsForTests());

  it('needs only the grants the selected variants use', async () => {
    await store.put('acme.slack', grant({ accessToken: 'slack-token' }));
    const configPath = await writeSuite({
      servers: {
        acme: { connector: 'acme/connector/acme' },
        slack: { connector: 'acme/connector/slack' },
      },
      variants: [
        { name: 'current', servers: ['acme'] },
        { name: 'candidate', servers: ['slack'] },
      ],
    });
    // Acme is not signed in, but the candidate variant doesn't use it.
    seen.length = 0;
    const plugin = testPlugin();
    await runEval({
      configPath,
      rootDir: dir,
      plugins: [plugin],
      credentialStore: store,
      variant: 'candidate',
    });
    expect(seen).toHaveLength(1);
    // The current variant lists Acme, so it needs Acme.
    await expect(
      runEval({
        configPath,
        rootDir: dir,
        plugins: [plugin],
        credentialStore: store,
        variant: 'current',
      })
    ).rejects.toThrow('acme/acme: not signed in.');
  });
});

describe('write records (ADR 0014)', () => {
  const launches: Array<Record<string, unknown>> = [];
  function writesPlugin(): Plugin {
    return {
      meta: { name: 'writes-plugin', namespace: 'w' },
      connectors: {
        // MST's dry-run proxy, given the launch context's writes.
        notes: {
          url: 'https://notes.example/mcp',
          auth: { type: 'none' },
          launch: (context) => {
            launches.push({ ...context });
            return notesProxyServer({
              label: context.label,
              ...(context.writes ? { writes: context.writes } : {}),
              writeReplies: { create_note: { ok: true, id: '{{id}}' } },
            });
          },
        },
        // Drops the writes: MST can't see this proxy's writes.
        careless: {
          url: 'https://careless.example/mcp',
          auth: { type: 'none' },
          launch: (context) => notesProxyServer({ label: context.label }),
        },
      },
      clients: {
        // Creates a note through "notes" ("hidden" leaves it out of the
        // transcript), then looks one up.
        writer: {
          schema: z
            .object({ type: z.string(), hidden: z.boolean().optional() })
            .strict(),
          evidence: 'structured',
          run: async (input, options) => {
            const notes = input.servers.find((s) => s.label === 'notes')!;
            const client = await createMCPClientForConfig(notes);
            try {
              const created = await client.callTool({
                name: 'create_note',
                arguments: { text: 'hi' },
              });
              const found = await client.callTool({
                name: 'lookup',
                arguments: {},
              });
              const write = {
                kind: 'tool_call' as const,
                source: 'mcp' as const,
                server: 'notes',
                name: 'create_note',
                arguments: { text: 'hi' },
                output: JSON.stringify(created.content),
              };
              return {
                finalText: 'Saved your note.',
                events: [
                  ...(options.hidden ? [] : [write]),
                  {
                    kind: 'tool_call',
                    source: 'mcp',
                    server: 'notes',
                    name: 'lookup',
                    arguments: {},
                    output: JSON.stringify(found.content),
                  },
                ],
              };
            } finally {
              await closeMCPClient(client);
            }
          },
        },
      },
    };
  }

  async function run(
    options: {
      simulateWrites?: boolean;
      hidden?: boolean;
      servers?: Record<string, unknown>;
      expected?: Record<string, unknown>;
    } = {}
  ) {
    const { simulateWrites } = options;
    launches.length = 0;
    await fs.writeFile(
      path.join(dir, 'cases.json'),
      JSON.stringify({
        name: 'cases',
        cases: [
          {
            id: 'c1',
            input: 'q',
            ...(options.expected ? { expected: options.expected } : {}),
          },
        ],
      })
    );
    await fs.writeFile(
      path.join(dir, 'eval.json'),
      JSON.stringify({
        name: 'writes',
        datasets: ['./cases.json'],
        client: 'w/client/writer',
        ...(options.hidden ? { clientOptions: { hidden: true } } : {}),
        ...(simulateWrites !== undefined ? { simulateWrites } : {}),
        redactStoredResponses: false,
        servers: options.servers ?? {
          notes: { connector: 'w/connector/notes' },
        },
      })
    );
    return runEval({
      configPath: path.join(dir, 'eval.json'),
      rootDir: dir,
      plugins: [writesPlugin()],
      credentialStore: store,
      report: false,
    });
  }

  async function storedTrial(outputDir: string): Promise<{
    writeRecord: WriteRecord;
    transcript: { events: Array<{ simulatedWrite?: boolean }> };
  }> {
    return JSON.parse(
      await fs.readFile(
        path.join(outputDir, 'transcripts', 'default', 'c1', '0.json'),
        'utf8'
      )
    ) as {
      writeRecord: WriteRecord;
      transcript: { events: Array<{ simulatedWrite?: boolean }> };
    };
  }

  it('records a stopped write, grades it from the record, and deletes the record files', async () => {
    const result = await run({
      expected: {
        writes: {
          calls: [
            { server: 'notes', tool: 'create_note', arguments: { text: 'hi' } },
          ],
        },
      },
    });
    const writes = launches[0]!.writes as { file: string; simulate: boolean };
    expect(path.basename(writes.file)).toBe('notes.jsonl');
    expect(writes.simulate).toBe(false);
    const [caseResult] = result.summary.results;
    expect(caseResult!.writeRecord).toMatchObject({
      writes: [
        {
          server: 'notes',
          tool: 'create_note',
          arguments: { text: 'hi' },
          mode: 'planned',
        },
      ],
      unreported: 0,
      unrecorded: [],
      unclassified: [],
      attribution: 'exclusive',
    });
    expect(caseResult!.scores.writes).toMatchObject({
      pass: true,
      writeEvidence: 'requested',
    });
    expect(caseResult!.pass).toBe(true);
    // The stored trial keeps the record, and run.json the write mode.
    expect(
      (await storedTrial(result.outputDir)).writeRecord.writes
    ).toHaveLength(1);
    const runRecord = JSON.parse(
      await fs.readFile(path.join(result.outputDir, 'run.json'), 'utf8')
    );
    expect(runRecord.variants[0].writeModes).toEqual({ notes: 'planned' });
    // The report shows the variant's write mode and its write cases.
    const report = buildRunReport(await readRunDirectory(result.outputDir));
    expect(report.variants[0]!.writes).toEqual({
      modes: { notes: 'planned' },
      casePassRate: 1,
      evidence: 'requested',
      unreported: 0,
      unrecorded: 0,
      unclassified: 0,
    });
    await expect(fs.stat(path.dirname(writes.file))).rejects.toThrow();
  }, 60_000);

  it("marks the trial's simulated writes in its transcript", async () => {
    const result = await run({ simulateWrites: true });
    expect((launches[0]!.writes as { simulate: boolean }).simulate).toBe(true);
    const [caseResult] = result.summary.results;
    expect(
      caseResult!.transcript!.events.map((event) => event.simulatedWrite)
    ).toEqual([true, undefined]);
    expect(caseResult!.writeRecord!.writes[0]).toMatchObject({
      mode: 'simulated',
      reply: expect.stringContaining('"ok":true'),
    });
    // A trial that wrote is a write case, so it is graded on its writes.
    expect(caseResult!.scores.writes?.pass).toBe(true);
    const stored = await storedTrial(result.outputDir);
    expect(stored.transcript.events[0]!.simulatedWrite).toBe(true);
  }, 60_000);

  it('fails a trial whose write is missing from its transcript (unreported)', async () => {
    const result = await run({ hidden: true });
    const [caseResult] = result.summary.results;
    expect(caseResult!.writeRecord!.unreported).toBe(1);
    expect(caseResult!.scores.writes).toMatchObject({ pass: false });
    expect(caseResult!.scores.writes!.details).toContain('unreported');
    expect(caseResult!.pass).toBe(false);
    expect(result.summary.variants[0]!.metrics).toMatchObject({
      unreported_writes: 1,
      write_case_passed_rate: 0,
    });
  }, 60_000);

  it("launches connectors with the run's ID", async () => {
    const result = await run();
    expect(launches.length).toBeGreaterThan(0);
    for (const context of launches)
      expect(context.runId).toBe(result.summary.runId);
  }, 60_000);

  it("refuses a connector whose proxy drops the launch context's writes", async () => {
    await expect(
      run({
        servers: {
          notes: { connector: 'w/connector/notes' },
          careless: { connector: 'w/connector/careless' },
        },
      })
    ).rejects.toThrow(
      'Connector server "careless" doesn\'t pass the launch context\'s writes to its dry-run proxy'
    );
  }, 60_000);
});
