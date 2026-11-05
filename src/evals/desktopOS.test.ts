/**
 * How a desktop client runs follows from the OS of the machine that runs the
 * trial (ADR 0011). `computerUseProvider` is gone at every level, and the
 * options only one OS uses fail when the eval config loads, when MST knows
 * the OS its trials run on: the host's for `local`, Linux for `docker`. A
 * plugin's environment can declare its OS; without one, it leaves the check
 * to its worker, before app setup (`coworkClient.test.ts`, `chatgptClient.test.ts`).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import { runEval, type RunEvalOptions } from './runEval.js';
import { installPlugins, resetPluginsForTests } from '../plugins/extensions.js';
import type { Plugin } from '../plugins/plugin.js';
import { environmentOS } from './environments/builtinEnvironments.js';
import { COMPUTER_USE_PROVIDER_GONE } from './desktopOS.js';

const dirs: string[] = [];

afterEach(async () => {
  resetPluginsForTests();
  vi.restoreAllMocks();
  await Promise.all(
    dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true }))
  );
});

const plugin: Plugin = {
  meta: { name: 'os-test-plugin', namespace: 'test' },
  clients: {
    mac: {
      schema: z
        .object({ type: z.string(), model: z.string().optional() })
        .strict(),
      requirements: { os: ['macos'] },
      async run() {
        throw new Error('A dry run runs no client.');
      },
    },
  },
  environments: {
    vm: {
      schema: z.object({}).strict(),
      async open() {
        throw new Error('A dry run opens no environment.');
      },
    },
    linux: {
      schema: z.object({}).strict(),
      os: 'linux',
      async open() {
        throw new Error('A dry run opens no environment.');
      },
    },
    mac: {
      schema: z.object({}).strict(),
      os: 'macos',
      async open() {
        throw new Error('A dry run opens no environment.');
      },
    },
  },
};

type Level = 'eval' | 'variant' | 'case';

/**
 * An eval of `client` that sets `options` at `level`: in the eval config,
 * in a variant, or on its one case. `run` dry-runs it.
 */
async function fixture(
  client: string,
  level: Level,
  options: Record<string, unknown>,
  overrideClient?: string
) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mst-desktop-os-'));
  dirs.push(dir);
  await fs.writeFile(
    path.join(dir, 'cases.json'),
    JSON.stringify({
      name: 'cases',
      cases: [
        {
          id: 'one',
          input: 'one',
          ...(level === 'case'
            ? {
                clientOptions: options,
                ...(overrideClient ? { client: overrideClient } : {}),
              }
            : {}),
          assertions: { containsText: 'OK' },
        },
      ],
    })
  );
  const configPath = path.join(dir, 'eval.json');
  await fs.writeFile(
    configPath,
    JSON.stringify({
      name: 'desktop-os',
      client,
      model: 'test-model',
      datasets: ['./cases.json'],
      servers: {},
      ...(level === 'eval' ? { clientOptions: options } : {}),
      ...(level === 'variant'
        ? {
            variants: [
              {
                name: 'only',
                clientOptions: options,
                ...(overrideClient ? { client: overrideClient } : {}),
              },
            ],
          }
        : {}),
    })
  );
  return (run: Partial<RunEvalOptions> = {}) =>
    runEval({
      configPath,
      rootDir: dir,
      plugins: [plugin],
      outputDir: path.join(dir, 'out'),
      dryRun: true,
      ...run,
    });
}

const CLIENTS = ['cowork', 'chatgpt', 'codex-app'] as const;
const LEVELS: Level[] = ['eval', 'variant', 'case'];

describe('computerUseProvider', () => {
  it.each(CLIENTS.flatMap((client) => LEVELS.map((level) => [client, level])))(
    'fails on %s, set in the %s, naming the OS as what decides',
    async (client, level) => {
      const run = await fixture(client, level as Level, {
        computerUseProvider: 'anthropic-computer-use',
      });
      await expect(run()).rejects.toThrow(COMPUTER_USE_PROVIDER_GONE);
    }
  );
});

describe("the OS an environment's trials run on", () => {
  it('uses local, docker, or declared plugin OS without opening machines', () => {
    installPlugins([plugin]);
    expect(environmentOS('local')).toBe(process.platform);
    expect(environmentOS('mst/env/local')).toBe(process.platform);
    expect(environmentOS('docker')).toBe('linux');
    expect(environmentOS('mst/env/docker')).toBe('linux');
    expect(environmentOS('test/env/vm')).toBeUndefined();
    expect(environmentOS('test/env/linux')).toBe('linux');
    expect(environmentOS('test/env/mac')).toBe('darwin');
  });
});

describe('client OS requirements', () => {
  it.each(['docker', 'mst/env/docker', 'test/env/linux'])(
    'rejects a macOS-only client on %s even from a Mac',
    async (env) => {
      vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin');
      const run = await fixture('test/client/mac', 'eval', {});
      await expect(run({ env })).rejects.toThrow(
        `client "test/client/mac" can't run in environment "${env === 'mst/env/docker' ? 'docker' : env}" (Linux); supported OS: macOS.`
      );
    }
  );

  it.each(['variant', 'case'] as const)(
    'checks the %s client, not only the eval client',
    async (level) => {
      const run = await fixture('api', level, {}, 'test/client/mac');
      await expect(run({ env: 'docker' })).rejects.toThrow(
        `${level === 'case' ? 'Case "one" in variant "default"' : 'Variant "only"'}: client "test/client/mac" can't run in environment "docker" (Linux); supported OS: macOS.`
      );
    }
  );

  it('uses the executing machine for local and does not guess an undeclared OS', async () => {
    const run = await fixture('test/client/mac', 'eval', {});
    vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin');
    await expect(run()).resolves.toBeDefined();
    vi.spyOn(process, 'platform', 'get').mockReturnValue('linux');
    await expect(run()).rejects.toThrow(
      'environment "local" (Linux); supported OS: macOS.'
    );
    await expect(run({ env: 'test/env/mac' })).resolves.toBeDefined();
    await expect(run({ env: 'test/env/vm' })).resolves.toBeDefined();
  });

  it.each(CLIENTS)('rejects %s on an unsupported local OS', async (client) => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
    const run = await fixture(client, 'eval', {});
    await expect(run()).rejects.toThrow(
      `client "${client}" can't run in environment "local" (win32); supported OS: macOS, Linux.`
    );
    // Docker's Linux, not the coordinator's OS, also decides desktop defaults.
    const result = await run({ env: 'docker' });
    if (client !== 'cowork')
      expect(result.evalConfig.clientOptions).not.toHaveProperty('maxActions');
  });

  it('keeps clients with no OS requirements compatible', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
    const run = await fixture('api', 'eval', {});
    await expect(run()).resolves.toBeDefined();
  });
});

describe('options only one OS uses', () => {
  it.each(LEVELS)(
    'fail at load for docker, which runs Linux, when set in the %s',
    async (level) => {
      const run = await fixture('cowork', level, { appVersion: '1.2.3' });
      await expect(run({ env: 'docker' })).rejects.toThrow(
        'client "cowork" can\'t run as configured. appVersion pins Claude Desktop on macOS, and this trial runs on Linux'
      );
    }
  );

  it.each([
    ['cowork', 'linux', { appVersion: '1.2.3' }, 'appVersion pins'],
    ['cowork', 'linux', { computerUseModel: 'planner' }, 'computerUseModel'],
    ['cowork', 'darwin', { mcpDataRoot: '/run/data' }, 'pluginRoots and'],
    ['chatgpt', 'linux', { computerUseModel: 'planner' }, 'computerUseModel'],
  ] as const)(
    "fail at load for local on the host's OS: %s on %s with %o",
    async (client, host, options, message) => {
      vi.spyOn(process, 'platform', 'get').mockReturnValue(host);
      const run = await fixture(client, 'variant', options);
      await expect(run()).rejects.toThrow(
        `Variant "only": client "${client}" can't run as configured. ${message}`
      );
      // The same options load where the other OS runs the trials.
      vi.spyOn(process, 'platform', 'get').mockReturnValue(
        host === 'linux' ? 'darwin' : 'linux'
      );
      await expect(run()).resolves.toBeDefined();
    }
  );

  it("load for a plugin's environment, whose worker checks its own OS", async () => {
    const run = await fixture('cowork', 'variant', { appVersion: '1.2.3' });
    vi.spyOn(process, 'platform', 'get').mockReturnValue('linux');
    await expect(run()).rejects.toThrow('appVersion pins');
    await expect(run({ env: 'test/env/vm' })).resolves.toBeDefined();
  });
});
