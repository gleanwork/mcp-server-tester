import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import {
  apiBuiltinSlot,
  BUILTIN_MODELS,
  BuiltinModelUses,
  defaultApiModel,
  mergeModelDefaults,
  resetBuiltinModelWarningsForTests,
  setProcessModelDefaults,
  warnBuiltinModels,
} from './modelDefaults.js';
import { validateJudge } from '../assertions/validators/judge.js';
import { loadEvalConfig } from '../evals/evalConfig.js';
import {
  SETTINGS_FILE,
  setConfigOverrideFile,
} from '../plugins/settingsFile.js';
import { getBuiltinClientConfig } from '../evals/builtinClients.js';
import { caseJudgesWithModels, judgeEntryIdentity } from '../evals/grading.js';
import type { CaseJudge } from '../evals/datasetTypes.js';
import { runEval } from '../evals/runEval.js';
import { installPlugins, resetPluginsForTests } from '../plugins/extensions.js';
import type { Plugin } from '../plugins/plugin.js';
import { z } from 'zod';

const dirs: string[] = [];

/** A plugin whose judge takes `models.judge.openai`, recording its model. */
function acmePick(seen: unknown[]): Plugin {
  return {
    meta: { name: 'acme-plugin', namespace: 'acme' },
    datasetSources: {
      cases: {
        schema: z.object({ type: z.string() }),
        load: async () => ({
          name: 'cases',
          cases: [{ id: 'one', input: 'hi' }],
        }),
      },
    },
    clients: {
      echo: {
        schema: z.object({ type: z.string() }).passthrough(),
        evidence: 'structured',
        run: async () => ({ finalText: 'hello', events: [] }),
      },
    },
    judges: {
      pick: {
        schema: z.object({ model: z.string().optional() }).passthrough(),
        modelSlot: () => ({ kind: 'judge', key: 'openai' }),
        evaluate: async (_input, options) => {
          seen.push((options as { model?: string }).model);
          return { score: 1 };
        },
      },
    },
  };
}

async function runRecord(outputDir: string): Promise<Record<string, unknown>> {
  return JSON.parse(
    await fs.readFile(path.join(outputDir, 'run.json'), 'utf8')
  ) as Record<string, unknown>;
}

/** The built-in model warnings a console.warn spy saw. */
function builtinWarnings(warn: MockInstance): string[] {
  return warn.mock.calls
    .map((call) => String(call[0]))
    .filter((message) => message.includes('built-in default'));
}

afterEach(async () => {
  vi.restoreAllMocks();
  resetBuiltinModelWarningsForTests();
  resetPluginsForTests();
  setConfigOverrideFile(undefined);
  setProcessModelDefaults(undefined);
  process.env.MST_USER_CONFIG = '';
  await Promise.all(
    dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true }))
  );
});

async function tempDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mst-models-'));
  dirs.push(dir);
  return dir;
}

/** A repo with an eval config, and an mst.config.json when `file` is given. */
async function repo(
  evalConfig: Record<string, unknown>,
  file?: Record<string, unknown>
): Promise<string> {
  const root = await tempDir();
  await fs.mkdir(path.join(root, '.git'));
  await fs.mkdir(path.join(root, 'evals'));
  if (file)
    await fs.writeFile(path.join(root, SETTINGS_FILE), JSON.stringify(file));
  const configPath = path.join(root, 'evals', 'eval.json');
  await fs.writeFile(
    configPath,
    JSON.stringify({
      name: 'models',
      datasets: ['acme/dataset/cases'],
      client: 'api',
      ...evalConfig,
    })
  );
  return configPath;
}

async function configFile(contents: Record<string, unknown>): Promise<string> {
  const file = path.join(await tempDir(), SETTINGS_FILE);
  await fs.writeFile(file, JSON.stringify(contents));
  return file;
}

describe('mergeModelDefaults', () => {
  it('replaces only the entries a later layer sets', () => {
    expect(
      mergeModelDefaults(
        { api: { anthropic: 'a1', openai: 'o1' }, computerUse: 'c1' },
        undefined,
        { api: { openai: 'o2' }, judge: { google: 'g2' } }
      )
    ).toEqual({
      api: { anthropic: 'a1', openai: 'o2' },
      judge: { google: 'g2' },
      computerUse: 'c1',
    });
  });

  it('is undefined when no layer sets anything', () => {
    expect(mergeModelDefaults(undefined, {})).toBeUndefined();
  });
});

describe('built-in model warnings', () => {
  it('collects each setting once, with every user', () => {
    const uses = new BuiltinModelUses();
    uses.add({ kind: 'judge', key: 'anthropic' }, 'judge rubric');
    uses.add({ kind: 'judge', key: 'anthropic' }, 'judge correctness');
    uses.add({ kind: 'judge', key: 'anthropic' }, 'judge rubric');
    uses.add({ kind: 'api', key: 'azure' }, 'api client');
    uses.add({ kind: 'computerUse' }, 'cowork client');
    expect(uses.list()).toEqual([
      {
        setting: 'models.computerUse',
        model: BUILTIN_MODELS.computerUse,
        usedBy: ['cowork client'],
      },
      {
        setting: 'models.judge.anthropic',
        model: BUILTIN_MODELS.judge.anthropic,
        usedBy: ['judge correctness', 'judge rubric'],
      },
    ]);
  });

  it('warns once per process for each setting', () => {
    const warn = vi.fn();
    const use = { setting: 'models.api.openai', model: 'm', usedBy: ['x'] };
    warnBuiltinModels([use], warn);
    warnBuiltinModels([use], warn);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]![0]).toContain('mst.config.json');
    expect(warn.mock.calls[0]![0]).toContain('models.api.openai: m (x)');
  });

  it("names the api client's slot only when it falls back on a built-in model", () => {
    expect(apiBuiltinSlot({}, undefined)).toEqual({
      kind: 'api',
      key: 'anthropic',
    });
    expect(apiBuiltinSlot({ provider: 'openai' }, undefined)).toEqual({
      kind: 'api',
      key: 'openai',
    });
    expect(apiBuiltinSlot({ model: 'm' }, undefined)).toBeUndefined();
    expect(
      apiBuiltinSlot({ provider: 'openai' }, { api: { openai: 'o' } })
    ).toBeUndefined();
  });

  it("warns when an assertion's judge runs on a built-in model, and not when the fixtures set one", async () => {
    const seen: unknown[] = [];
    installPlugins([acmePick(seen)]);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await validateJudge('answer', { judge: 'acme/judge/pick' });
    await validateJudge('answer', { judge: 'acme/judge/pick' });
    expect(builtinWarnings(warn)).toHaveLength(1);
    resetBuiltinModelWarningsForTests();
    setProcessModelDefaults({ judge: { openai: 'fixture' } });
    await validateJudge('answer', { judge: 'acme/judge/pick' });
    expect(builtinWarnings(warn)).toHaveLength(1);
    expect(seen).toEqual([undefined, undefined, 'fixture']);
  });
});

describe('the api client model', () => {
  it("defaults to the provider's own model, not Claude's", () => {
    expect(getBuiltinClientConfig('api', { provider: 'openai' }).model).toBe(
      BUILTIN_MODELS.api.openai
    );
    expect(getBuiltinClientConfig('api', { provider: 'google' }).model).toBe(
      BUILTIN_MODELS.api.google
    );
    expect(getBuiltinClientConfig('api', {}).model).toBe(
      BUILTIN_MODELS.api.anthropic
    );
  });

  it('takes the configured default for the provider, and an explicit model over it', () => {
    const models = { api: { openai: 'gpt-next' } };
    expect(
      getBuiltinClientConfig('api', { provider: 'openai' }, undefined, models)
        .model
    ).toBe('gpt-next');
    expect(
      getBuiltinClientConfig(
        'api',
        { provider: 'openai', model: 'gpt-pinned' },
        undefined,
        models
      ).model
    ).toBe('gpt-pinned');
    // Another provider's entry doesn't apply.
    expect(getBuiltinClientConfig('api', {}, undefined, models).model).toBe(
      BUILTIN_MODELS.api.anthropic
    );
  });

  it('names where to set a model for a provider without a built-in one', () => {
    expect(() => defaultApiModel('azure', undefined)).toThrow(
      'models.api.azure'
    );
    expect(defaultApiModel('azure', { api: { azure: 'my-deployment' } })).toBe(
      'my-deployment'
    );
  });
});

describe('judge models', () => {
  const rubric: CaseJudge = { type: 'rubric', rubric: 'correctness' };

  it('writes the configured model for the judge provider into options that name none', () => {
    const models = { judge: { anthropic: 'claude-next', openai: 'gpt-next' } };
    expect(caseJudgesWithModels([rubric], models)).toEqual([
      { ...rubric, model: 'claude-next' },
    ]);
    expect(
      caseJudgesWithModels([{ ...rubric, provider: 'openai' }], models)
    ).toEqual([{ ...rubric, provider: 'openai', model: 'gpt-next' }]);
    expect(
      caseJudgesWithModels([{ ...rubric, model: 'pinned' }], models)
    ).toEqual([{ ...rubric, model: 'pinned' }]);
    expect(caseJudgesWithModels([rubric], { judge: { google: 'g' } })).toEqual([
      rubric,
    ]);
  });

  it('gives a judge graded on a configured model the identity of one that names it', () => {
    const named = judgeEntryIdentity({ ...rubric, model: 'claude-next' }, {});
    const [filled] = caseJudgesWithModels([rubric], {
      judge: { anthropic: 'claude-next' },
    });
    expect(judgeEntryIdentity(filled!, {})).toBe(named);
    expect(judgeEntryIdentity(rubric, {})).not.toBe(named);
  });

  it("applies the process's defaults (the Playwright fixtures') to an assertion's judge", () => {
    const named = judgeEntryIdentity({ ...rubric, model: 'claude-next' }, {});
    setProcessModelDefaults({ judge: { anthropic: 'claude-next' } });
    expect(judgeEntryIdentity(rubric, {})).toBe(named);
  });
});

describe('the models cascade', () => {
  it('leaves an eval config without files as written', async () => {
    const configPath = await repo({});
    const config = loadEvalConfig(configPath);
    expect('models' in config).toBe(false);
  });

  it("merges the user's, the repo's, the eval config's and --mst-config's models in order", async () => {
    process.env.MST_USER_CONFIG = await configFile({
      models: {
        api: { anthropic: 'user-a', openai: 'user-o', google: 'user-g' },
        computerUse: 'user-cu',
      },
    });
    const configPath = await repo(
      { models: { api: { openai: 'eval-o' }, judge: { openai: 'eval-j' } } },
      { models: { api: { anthropic: 'repo-a', openai: 'repo-o' } } }
    );
    setConfigOverrideFile(
      await configFile({ models: { judge: { openai: 'cli-j' } } })
    );
    expect(loadEvalConfig(configPath).models).toEqual({
      api: { anthropic: 'repo-a', openai: 'eval-o', google: 'user-g' },
      judge: { openai: 'cli-j' },
      computerUse: 'user-cu',
    });
  });

  it('reads no file for an eval config sent with its models in it', async () => {
    process.env.MST_USER_CONFIG = await configFile({
      models: { computerUse: 'user-cu' },
    });
    const configPath = await repo({ models: { computerUse: 'sent' } });
    expect(loadEvalConfig(configPath, { settingsFile: false }).models).toEqual({
      computerUse: 'sent',
    });
  });

  it("rejects plugin settings in the user's file", async () => {
    process.env.MST_USER_CONFIG = await configFile({
      settings: { acme: { project: 'p' } },
    });
    const configPath = await repo({});
    expect(() => loadEvalConfig(configPath)).toThrow('sets only `models`');
  });

  it('rejects an unknown model kind or provider', async () => {
    const configPath = await repo({}, { models: { api: { nope: 'x' } } });
    expect(() => loadEvalConfig(configPath)).toThrow(SETTINGS_FILE);
    const second = await repo({}, { models: { planner: 'x' } });
    expect(() => loadEvalConfig(second)).toThrow(SETTINGS_FILE);
  });

  it("grades an eval's judges on the repo file's model", async () => {
    const seen: unknown[] = [];
    const configPath = await repo(
      {
        plugins: [],
        client: 'acme/client/echo',
        judges: ['acme/judge/pick', { type: 'acme/judge/pick', model: 'own' }],
      },
      { models: { judge: { openai: 'from-file' } } }
    );
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const result = await runEval({
      configPath,
      rootDir: path.dirname(path.dirname(configPath)),
      plugins: [acmePick(seen)],
    });
    expect(seen.sort()).toEqual(['from-file', 'own']);
    // Every model is set, so nothing to warn about or record.
    expect(builtinWarnings(warn)).toEqual([]);
    expect(await runRecord(result.outputDir)).not.toHaveProperty(
      'builtinModels'
    );
  });

  it('warns about and records the built-in models a run falls back on', async () => {
    const seen: unknown[] = [];
    const configPath = await repo({
      plugins: [],
      client: 'acme/client/echo',
      judges: ['acme/judge/pick'],
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const result = await runEval({
      configPath,
      rootDir: path.dirname(path.dirname(configPath)),
      plugins: [acmePick(seen)],
    });
    expect(seen).toEqual([undefined]);
    const expected = {
      setting: 'models.judge.openai',
      model: BUILTIN_MODELS.judge.openai,
      usedBy: ['judge acme/judge/pick'],
    };
    expect((await runRecord(result.outputDir)).builtinModels).toEqual([
      expected,
    ]);
    // Once, at the start, though the judge then runs.
    const warnings = builtinWarnings(warn);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain(
      `models.judge.openai: ${BUILTIN_MODELS.judge.openai} (judge acme/judge/pick)`
    );
  });

  it('fails for a --mst-config file that does not exist', () => {
    expect(() => setConfigOverrideFile('/nonexistent/mst.config.json')).toThrow(
      "doesn't exist"
    );
  });
});
