/**
 * One idea has one option name, and a config that can't run fails when it
 * loads (ADR 0011). A desktop client's action budget is `maxActions`: its
 * earlier names fail at every level, and its range is checked against the
 * OS the trials run on when MST knows it. A case can't change the client
 * settings of a client that runs a variant's cases in one app.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import { runEval, type RunEvalOptions } from './runEval.js';
import { resetPluginsForTests } from '../plugins/extensions.js';
import type { Plugin } from '../plugins/plugin.js';
import { maxActionsRenamed } from './desktopOS.js';

const dirs: string[] = [];

afterEach(async () => {
  resetPluginsForTests();
  vi.restoreAllMocks();
  await Promise.all(
    dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true }))
  );
});

const plugin: Plugin = {
  meta: { name: 'option-names-test-plugin', namespace: 'test' },
  environments: {
    vm: {
      schema: z.object({}).strict(),
      async open() {
        throw new Error('A dry run opens no environment.');
      },
    },
  },
};

type Level = 'eval' | 'variant' | 'case';

interface Fixture {
  client: string;
  /** The eval config's client options. */
  options?: Record<string, unknown>;
  /** The variant's client options. */
  variantOptions?: Record<string, unknown>;
  /** What the one case sets of its own. */
  caseFields?: {
    client?: string;
    model?: string;
    clientOptions?: Record<string, unknown>;
  };
  /** The cases, each with its own fields, instead of the one case. */
  cases?: Array<{ id: string } & Record<string, unknown>>;
}

/**
 * An eval of `client` with one variant, `only`, and one case, `one`. The
 * returned function dry-runs it.
 */
async function fixture({
  client,
  options,
  variantOptions,
  caseFields,
  cases,
}: Fixture) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mst-option-names-'));
  dirs.push(dir);
  await fs.writeFile(
    path.join(dir, 'cases.json'),
    JSON.stringify({
      name: 'cases',
      cases: (cases ?? [{ id: 'one', ...caseFields }]).map((evalCase) => ({
        input: evalCase.id,
        ...evalCase,
        assertions: { containsText: 'OK' },
      })),
    })
  );
  const configPath = path.join(dir, 'eval.json');
  await fs.writeFile(
    configPath,
    JSON.stringify({
      name: 'option-names',
      client,
      model: 'test-model',
      datasets: ['./cases.json'],
      servers: {},
      ...(options ? { clientOptions: options } : {}),
      variants: [
        {
          name: 'only',
          ...(variantOptions ? { clientOptions: variantOptions } : {}),
        },
      ],
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

/** `options` set at `level`. */
function at(level: Level, client: string, options: Record<string, unknown>) {
  return fixture({
    client,
    ...(level === 'eval' ? { options } : {}),
    ...(level === 'variant' ? { variantOptions: options } : {}),
    ...(level === 'case' ? { caseFields: { clientOptions: options } } : {}),
  });
}

const DESKTOP_CLIENTS = ['cowork', 'chatgpt', 'codex-app'] as const;
const LEVELS: Level[] = ['eval', 'variant', 'case'];

describe('the earlier names of maxActions', () => {
  const OLD_NAMES = [
    ['cowork', 'computerUseMaxActions'],
    ['chatgpt', 'computerUseMaxActions'],
    ['chatgpt', 'nativeMaxActions'],
    ['codex-app', 'computerUseMaxActions'],
    ['codex-app', 'nativeMaxActions'],
  ] as const;
  it.each(
    OLD_NAMES.flatMap(([client, old]) =>
      LEVELS.map((level) => [client, old, level] as const)
    )
  )(
    'fail on %s: %s, set in the %s, names maxActions',
    async (client, old, level) => {
      const run = await at(level, client, { [old]: 8 });
      await expect(run()).rejects.toThrow(maxActionsRenamed(old));
      await expect(run()).rejects.toThrow(
        `\`clientOptions.${old}\` is now \`maxActions\``
      );
    }
  );

  it.each(DESKTOP_CLIENTS)('%s takes maxActions', async (client) => {
    const run = await at('variant', client, { maxActions: 8 });
    await expect(run()).resolves.toBeDefined();
  });
});

describe('maxActions at load', () => {
  it("is 1 to 64 on Cowork, whatever the trials' OS", async () => {
    for (const maxActions of [1, 64]) {
      const run = await at('variant', 'cowork', { maxActions });
      await expect(run()).resolves.toBeDefined();
    }
    for (const maxActions of [0, 65]) {
      const run = await at('variant', 'cowork', { maxActions });
      await expect(run({ env: 'test/env/vm' })).rejects.toThrow(/maxActions/);
    }
  });

  it.each([
    ['darwin', 'macOS', 32],
    ['linux', 'Linux', 24],
  ] as const)(
    "on ChatGPT, fails outside the range of the host's OS for local: %s",
    async (host, name, fallback) => {
      vi.spyOn(process, 'platform', 'get').mockReturnValue(host);
      for (const level of ['eval', 'variant'] as const)
        for (const client of ['chatgpt', 'codex-app']) {
          const ok = await at(level, client, { maxActions: 64 });
          await expect(ok()).resolves.toBeDefined();
          const over = await at(level, client, { maxActions: 65 });
          await expect(over()).rejects.toThrow(
            `client "${client}" can't run as configured. maxActions is 65, and on ${name}, where this trial runs, it is 1 to 64 (default ${fallback}).`
          );
        }
    }
  );

  it("on ChatGPT, fails outside Linux's range for docker, and loads for a plugin's environment, whose worker checks it", async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin');
    const run = await at('variant', 'chatgpt', { maxActions: 65 });
    await expect(run({ env: 'docker' })).rejects.toThrow(
      'maxActions is 65, and on Linux, where this trial runs, it is 1 to 64 (default 24).'
    );
    await expect(run({ env: 'test/env/vm' })).resolves.toBeDefined();
    // Below 1 is outside every OS's range.
    const zero = await at('variant', 'chatgpt', { maxActions: 0 });
    await expect(zero({ env: 'test/env/vm' })).rejects.toThrow(/maxActions/);
  });
});

describe('a case override a desktop client runs in one app', () => {
  it.each(DESKTOP_CLIENTS)(
    'fails at load on %s when the case sets its own model',
    async (client) => {
      const run = await fixture({ client, caseFields: { model: 'other' } });
      // A plugin's environment too: nothing about the OS decides it.
      await expect(run({ env: 'test/env/vm' })).rejects.toThrow(
        `Case "one" in variant "only" sets its own \`model\`, which client "${client}" can't honour: it runs a variant's cases in one app, with the variant's settings. Use a variant for a different setting.`
      );
    }
  );

  it.each(DESKTOP_CLIENTS)(
    'fails at load on %s when the case changes a client option',
    async (client) => {
      const run = await fixture({
        client,
        variantOptions: { timeout: 1000 },
        caseFields: { clientOptions: { timeout: 2000 } },
      });
      await expect(run()).rejects.toThrow(
        `Case "one" in variant "only" sets its own \`clientOptions.timeout\`, which client "${client}" can't honour`
      );
    }
  );

  it.each(DESKTOP_CLIENTS)(
    'loads on %s when the case repeats the variant settings',
    async (client) => {
      const run = await fixture({
        client,
        options: { timeout: 1000 },
        caseFields: { model: 'test-model', clientOptions: { timeout: 1000 } },
      });
      await expect(run()).resolves.toBeDefined();
    }
  );

  it.each(DESKTOP_CLIENTS)(
    'fails at load on %s when a case names another client',
    async (client) => {
      const run = await fixture({ client, caseFields: { client: 'api' } });
      await expect(run()).rejects.toThrow(
        `Case "one" in variant "only" sets its own \`client\`, which client "${client}" can't honour: it runs a variant's cases in one app.`
      );
    }
  );

  it.each(DESKTOP_CLIENTS)(
    'loads cases on %s with different settings in an api variant: each runs in its own batch',
    async (client) => {
      const run = await fixture({
        client: 'api',
        cases: [
          { id: 'plain' },
          { id: 'a', client, model: 'm', clientOptions: { timeout: 1000 } },
          { id: 'b', client, model: 'm', clientOptions: { timeout: 2000 } },
        ],
      });
      await expect(run()).resolves.toBeDefined();
    }
  );

  it('loads on a client that runs each case on its own', async () => {
    const run = await fixture({
      client: 'api',
      caseFields: { model: 'other', clientOptions: { timeout: 5 } },
    });
    await expect(run()).resolves.toBeDefined();
  });
});
