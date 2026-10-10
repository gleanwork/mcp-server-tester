import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runEval } from './runEval.js';
import { resetPluginsForTests } from '../plugins/extensions.js';
import { localCredentialStore } from '../auth/grants/localStore.js';
import type { TraceEvent } from './evalFrameworkTypes.js';

const mock = (name: string) =>
  fileURLToPath(new URL(`../../tests/mocks/${name}`, import.meta.url));
const dirs: string[] = [];

afterEach(async () => {
  resetPluginsForTests();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await Promise.all(
    dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true }))
  );
});

interface StoredTrace {
  trace: { events: TraceEvent[] };
}

describe('connector servers and tool metadata in an environment', () => {
  it("runs on a worker that expands the connector itself, gets its token from the coordinator, and applies the variant's tool metadata", async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mst-shard-conn-'));
    dirs.push(dir);
    // The worker's tokens directory (a tmpfs in worker images).
    const tokensDir = path.join(dir, 'worker-tokens');
    vi.stubEnv('MST_TOKENS_DIR', tokensDir);
    const store = localCredentialStore(path.join(dir, 'grants'));
    await store.put('sc.notes', {
      version: 1,
      type: 'oauth',
      tokenEndpoint: 'https://auth.example/token',
      clientId: 'c',
      refreshToken: 'refresh',
      accessToken: 'notes-token-1',
      accessTokenExpiresAt: new Date(Date.now() + 3600_000).toISOString(),
      scopes: [],
      resource: 'https://notes.example/mcp',
      signedInAt: new Date().toISOString(),
    });
    await fs.writeFile(
      path.join(dir, 'cases.json'),
      JSON.stringify({
        name: 'cases',
        cases: ['alpha', 'bravo'].map((id) => ({
          id,
          input: id,
          assertions: { containsText: 'token ok' },
        })),
      })
    );
    const configPath = path.join(dir, 'eval.json');
    await fs.writeFile(
      configPath,
      JSON.stringify({
        name: 'shard-connectors',
        plugins: [mock('forkEnvPlugin.ts'), mock('shardConnectorPlugin.ts')],
        client: 'sc/client/caller',
        datasets: ['./cases.json'],
        servers: { notes: { connector: 'sc/connector/notes' } },
        variants: [
          { name: 'current' },
          {
            name: 'renamed',
            tools: { 'notes.lookup': { name: 'find_note' } },
          },
        ],
        simulateWrites: true,
        redactStoredResponses: false,
      })
    );

    const result = await runEval({
      configPath,
      rootDir: dir,
      outputDir: path.join(dir, 'out'),
      env: 'fork/env/children',
      envOptions: { shards: '1' },
      credentialStore: store,
      report: false,
    });

    expect(result.summary.metrics).toMatchObject({ passed: 4, total: 4 });
    // Every trial came back from the shard's worker.
    const lines = log.mock.calls.map((call) => String(call[0]));
    expect(lines).toContain('[mst] shard 1/1: done');
    expect(lines.filter((line) => / #1 collected$/.test(line)).sort()).toEqual([
      '[mst] shard 1/1: current alpha #1 collected',
      '[mst] shard 1/1: current bravo #1 collected',
      '[mst] shard 1/1: renamed alpha #1 collected',
      '[mst] shard 1/1: renamed bravo #1 collected',
    ]);
    const trace = async (variant: string, caseId: string) =>
      (
        JSON.parse(
          await fs.readFile(
            path.join(result.outputDir, 'traces', variant, caseId, '0.json'),
            'utf8'
          )
        ) as StoredTrace
      ).trace.events.map(({ name, rawName, output, simulatedWrite }) => ({
        name,
        rawName,
        output,
        simulatedWrite,
      }));
    // The worker's notes server read the token the coordinator sent, and
    // its simulated write is marked.
    expect(await trace('current', 'alpha')).toEqual([
      {
        name: 'lookup',
        rawName: undefined,
        output: 'token ok',
        simulatedWrite: undefined,
      },
      {
        name: 'create_note',
        rawName: undefined,
        output: '{"ok":true}',
        simulatedWrite: true,
      },
    ]);
    // The variant's tool metadata was served by a proxy on the worker; the
    // call is recorded under the tool's original name.
    expect(await trace('renamed', 'bravo')).toEqual([
      {
        name: 'lookup',
        rawName: 'find_note',
        output: 'token ok',
        simulatedWrite: undefined,
      },
      {
        name: 'create_note',
        rawName: undefined,
        output: '{"ok":true}',
        simulatedWrite: true,
      },
    ]);
    // The worker removed its tokens; no token reached the run's files.
    await expect(fs.stat(tokensDir)).rejects.toThrow();
    const files = await fs.readdir(result.outputDir, { recursive: true });
    for (const file of files.map(String).filter((f) => f.endsWith('.json')))
      expect(
        await fs.readFile(path.join(result.outputDir, file), 'utf8')
      ).not.toContain('notes-token');
  }, 120_000);
});
