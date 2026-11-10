/**
 * First-party Cowork in a run: MST must not probe the account's servers
 * itself. The account's own sign-in is the only credential for them, so a
 * direct MCP connection from MST would be unauthenticated. Every run here
 * stops before any client starts (`beforeCollect` throws), so nothing opens
 * the desktop app or calls the account.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { runEval } from './runEval.js';
import { resetPluginsForTests } from '../plugins/extensions.js';

const STOPPED_BEFORE_COLLECT = 'stopped before any client started';
const dirs: string[] = [];
const listeners: net.Server[] = [];

beforeEach(() => {
  // First-party mode runs on macOS only; the run's OS is this machine's.
  vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin');
});

afterEach(async () => {
  resetPluginsForTests();
  vi.restoreAllMocks();
  await Promise.all(
    listeners
      .splice(0)
      .map((server) => new Promise((done) => server.close(done)))
  );
  await Promise.all(
    dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true }))
  );
});

/**
 * A local socket that counts the connections made to it: a stand-in for the
 * account's endpoint that records any direct probe from MST.
 */
async function startProbeCounter(): Promise<{
  url: string;
  connections: () => number;
}> {
  let connections = 0;
  const server = net.createServer((socket) => {
    connections += 1;
    socket.destroy();
  });
  listeners.push(server);
  await new Promise<void>((ready) => server.listen(0, '127.0.0.1', ready));
  const { port } = server.address() as net.AddressInfo;
  return {
    url: `https://127.0.0.1:${port}/mcp`,
    connections: () => connections,
  };
}

async function fixture(
  serverUrl: string,
  clientOptions: Record<string, unknown>
) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mst-first-party-'));
  dirs.push(dir);
  await fs.writeFile(
    path.join(dir, 'cases.json'),
    JSON.stringify({
      name: 'cases',
      cases: [{ id: 'alpha', input: 'alpha', assertions: {} }],
    })
  );
  const configPath = path.join(dir, 'eval.json');
  await fs.writeFile(
    configPath,
    JSON.stringify({
      name: 'first-party',
      client: 'cowork',
      clientOptions,
      datasets: ['./cases.json'],
      servers: { account: { transport: 'http', serverUrl } },
      redactStoredResponses: false,
    })
  );
  return {
    run: (options: { recordServedTools?: boolean } = {}) =>
      runEval({
        configPath,
        rootDir: dir,
        outputDir: path.join(dir, 'out'),
        report: false,
        beforeCollect: () => {
          throw new Error(STOPPED_BEFORE_COLLECT);
        },
        ...options,
      }),
  };
}

describe('first-party Cowork in a run', () => {
  it('refuses recordServedTools without probing the account endpoint', async () => {
    const endpoint = await startProbeCounter();
    const f = await fixture(endpoint.url, { mode: 'first-party' });
    await expect(f.run({ recordServedTools: true })).rejects.toThrow(
      'First-party mode records its account tool inventory in connector-policy.json; direct recordServedTools probes are unsupported.'
    );
    expect(endpoint.connections()).toBe(0);
  });

  it('control: recordServedTools lists a third-party variant’s servers directly', async () => {
    const endpoint = await startProbeCounter();
    const f = await fixture(endpoint.url, {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    await expect(f.run({ recordServedTools: true })).rejects.toThrow(
      /^(?!First-party mode)/s
    );
    expect(endpoint.connections()).toBeGreaterThan(0);
  });

  it('leaves the account servers’ tools to the client after it prepares, with no direct MCP probe', async () => {
    const endpoint = await startProbeCounter();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const f = await fixture(endpoint.url, { mode: 'first-party' });
    // The write-mode load check passes, and the run reaches beforeCollect.
    await expect(f.run()).rejects.toThrow(STOPPED_BEFORE_COLLECT);
    expect(endpoint.connections()).toBe(0);
    expect(warn).not.toHaveBeenCalledWith(
      expect.stringContaining("Couldn't list server")
    );
  });

  it('control: the load check lists a third-party variant’s read-only servers directly', async () => {
    const endpoint = await startProbeCounter();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const f = await fixture(endpoint.url, {});
    await expect(f.run()).rejects.toThrow(STOPPED_BEFORE_COLLECT);
    expect(endpoint.connections()).toBeGreaterThan(0);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("Couldn't list server")
    );
  });
});
