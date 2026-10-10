import { simulationToClientRun } from './clientTrace.js';
import type { MstClientSimulationResult } from './mstClient/types.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import { runEval, type RunEvalOptions } from './runEval.js';
import {
  installPlugins,
  loadedNamespaces,
  resetPluginsForTests,
} from '../plugins/extensions.js';
import type { Plugin } from '../plugins/plugin.js';
import type { EvalCase, EvalDataset } from './datasetTypes.js';
import type {
  DatasetSource,
  ClientDefinition,
  ClientRunOptions,
  ClientRunInput,
  ClientRunContext,
  JudgeDefinition,
} from './evalFrameworkTypes.js';
import { FileEvalResultStore } from './resultStore.js';
import {
  compareEvalRuns,
  loadStoredEvalRunnerResult,
} from './evalRunComparison.js';

/** Matches a judge input whose reference answer is `answer`. */
function expectedAnswer(answer: unknown): unknown {
  return expect.objectContaining({
    case: expect.objectContaining({
      expected: expect.objectContaining({ answer }),
    }),
  });
}

const dirs: string[] = [];
let sequence = 0;

interface TestPlugin extends Plugin {
  clients: Record<string, ClientDefinition>;
  datasetSources: Record<string, DatasetSource>;
  judges: Record<string, JudgeDefinition>;
}
function newTestPlugin(): TestPlugin {
  return {
    meta: { name: 'run-eval-suite-test-plugin', namespace: 'test' },
    clients: {},
    datasetSources: {},
    judges: {},
  };
}
/** Every extension a test defines; evals load it as the `test` plugin. */
let testPlugin = newTestPlugin();
const KIND_SEGMENT = {
  clients: 'client',
  datasetSources: 'dataset',
  judges: 'judge',
} as const;
function addExtension<K extends 'clients' | 'datasetSources' | 'judges'>(
  kind: K,
  name: string,
  definition: TestPlugin[K][string]
): string {
  // Installing copies the plugin's extensions, so later additions would never resolve.
  if (loadedNamespaces().includes('test'))
    throw new Error('Define test extensions before the first run.');
  (testPlugin[kind] as Record<string, unknown>)[name] = definition;
  return `test/${KIND_SEGMENT[kind]}/${name}`;
}
function addClient(name: string, definition: ClientDefinition): string {
  return addExtension('clients', name, definition);
}
function addDatasetSource(name: string, definition: DatasetSource): string {
  return addExtension('datasetSources', name, definition);
}
function addJudge(name: string, definition: JudgeDefinition): string {
  return addExtension('judges', name, definition);
}
function runEvalConfig(options: RunEvalOptions) {
  return runEval({ plugins: [testPlugin], ...options });
}

afterEach(async () => {
  vi.unstubAllEnvs();
  resetPluginsForTests();
  testPlugin = newTestPlugin();
  await Promise.all(
    dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true }))
  );
});
async function fixture(
  cases: EvalCase[],
  extra: Record<string, unknown> = {},
  // The fixture client's simulation-shaped result, adapted to a trace below.
  run = vi.fn<(options: ClientRunOptions) => Promise<{ response: unknown }>>(
    async () => ({
      response: { success: true, response: 'WRONG', toolCalls: [] },
    })
  )
) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'suite-review-'));
  dirs.push(dir);
  const observe =
    vi.fn<(input: ClientRunInput, context: ClientRunContext) => void>();
  const load = vi.fn(
    async (): Promise<EvalDataset> => ({ name: 'canonical', cases })
  );
  const type = addClient(`review-client-${sequence++}`, {
    schema: z
      .object({ type: z.string(), model: z.string().default('default-model') })
      .passthrough(),
    evidence: 'structured',
    async run(input, config, context) {
      observe(input, context);
      const result = await run({
        dataset: { name: 'canonical', cases },
        cases,
        servers: input.servers,
        client: config,
        evalConfig: context.evalConfig,
        variant: context.variant,
      });
      return simulationToClientRun(
        result.response as MstClientSimulationResult,
        input.servers
      );
    },
  });
  const source = addDatasetSource(`review-source-${sequence++}`, {
    schema: z.object({ type: z.string() }),
    load,
  });
  const configPath = path.join(dir, 'eval.json');
  const evalConfig = {
    name: 'review',
    datasets: [{ type: source }],
    client: type,
    servers: {},
    ...extra,
  };
  await fs.writeFile(configPath, JSON.stringify(evalConfig));
  return { dir, configPath, evalConfig, run, type, observe, load };
}
const scenario: EvalCase = {
  id: 'same',
  input: 'Find documents',
};

describe('eval review regressions', () => {
  it('isolates secrets files across dry, sequential, and concurrent evals', async () => {
    vi.stubEnv('SUITE_DUMMY_TOKEN', undefined);
    const f = await fixture([scenario], {
      servers: {
        'server-1': {
          transport: 'http',
          serverUrl: 'https://example.com/eval',
          auth: { accessTokenEnv: 'SUITE_DUMMY_TOKEN' },
        },
      },
    });
    const first = path.join(f.dir, 'first.env');
    const second = path.join(f.dir, 'second.json');
    await fs.writeFile(
      first,
      'SUITE_DUMMY_TOKEN=first-dummy\nSUITE_DUMMY_HOST_KEY=first-client'
    );
    await fs.writeFile(
      second,
      JSON.stringify({
        SUITE_DUMMY_TOKEN: 'second-dummy',
        EVAL_DUMMY_CLIENT_KEY: 'second-host',
      })
    );
    await runEvalConfig({
      configPath: f.configPath,
      rootDir: f.dir,
      secretsFile: first,
      dryRun: true,
    });
    expect(process.env.SUITE_DUMMY_TOKEN).toBeUndefined();
    await runEvalConfig({
      configPath: f.configPath,
      rootDir: f.dir,
      secretsFile: first,
    });
    await runEvalConfig({
      configPath: f.configPath,
      rootDir: f.dir,
      secretsFile: second,
    });
    await Promise.all([
      runEvalConfig({
        configPath: f.configPath,
        rootDir: f.dir,
        secretsFile: first,
      }),
      runEvalConfig({
        configPath: f.configPath,
        rootDir: f.dir,
        secretsFile: second,
      }),
    ]);
    const observedTokens = f.observe.mock.calls.map(
      ([input]) => input.env?.SUITE_DUMMY_TOKEN
    );
    expect(observedTokens.slice(0, 2)).toEqual(['first-dummy', 'second-dummy']);
    // Concurrent evals may finish in either order; each must keep its own token.
    expect(observedTokens.slice(2).sort()).toEqual([
      'first-dummy',
      'second-dummy',
    ]);
    expect(process.env.SUITE_DUMMY_TOKEN).toBeUndefined();
    await expect(
      runEvalConfig({ configPath: f.configPath, rootDir: f.dir })
    ).rejects.toThrow('SUITE_DUMMY_TOKEN');
  });

  it.each(['config', 'override'] as const)(
    'resolves %s server credentials for the client, and stores none',
    async (serverSource) => {
      vi.stubEnv('SUITE_DUMMY_TOKEN', undefined);
      vi.stubEnv('EVAL_DUMMY_CLIENT_KEY', undefined);
      vi.stubEnv('MCP_PLUGIN_DIR', undefined);
      const run = vi.fn<NonNullable<ClientDefinition['run']>>(async () => ({
        finalText: 'OK',
        events: [],
      }));
      const name = addClient(`source-cli-${sequence++}`, {
        schema: z.object({}),
        run,
      });
      const source = addDatasetSource(`source-cli-data-${sequence++}`, {
        schema: z.object({}),
        async load() {
          return {
            name: 'cli-source',
            cases: [{ id: 'case', input: 'Find documents' }],
          };
        },
      });
      const server = {
        transport: 'http' as const,
        label: 'protected',
        serverUrl: 'https://example.com/eval',
        auth: { accessTokenEnv: 'SUITE_DUMMY_TOKEN' },
      };
      const { label, ...unlabelled } = server;
      const f = await fixture([], {
        datasets: [{ type: source }],
        client: name,
        servers: serverSource === 'config' ? { [label]: unlabelled } : {},
      });
      const secretsFile = path.join(f.dir, 'secrets.env');
      await fs.writeFile(
        secretsFile,
        'SUITE_DUMMY_TOKEN=source-dummy\nSUITE_DUMMY_HOST_KEY=source-client'
      );
      const result = await runEvalConfig({
        configPath: f.configPath,
        rootDir: f.dir,
        secretsFile,
        ...(serverSource === 'override' ? { mcpConfig: server } : {}),
      });
      expect(result.summary.results[0]?.pass).toBe(true);
      expect(run.mock.calls[0]?.[0].servers[0]).toEqual({
        ...server,
        auth: { accessToken: 'source-dummy' },
      });
      expect(process.env.SUITE_DUMMY_TOKEN).toBeUndefined();
      expect(process.env.EVAL_DUMMY_CLIENT_KEY).toBeUndefined();
      const saved = await fs.readFile(
        path.join(result.outputDir, 'results.json'),
        'utf8'
      );
      expect(saved).not.toContain('source-dummy');
      expect(saved).not.toContain('source-host');
    }
  );

  it('inherits Cowork write policy for empty variant settings and honors explicit false', async () => {
    const f = await fixture([scenario], {
      coworkSetup: { approveWriteTools: true },
      variants: [
        { name: 'inherited' },
        { name: 'empty', coworkSetup: {} },
        { name: 'read-only', coworkSetup: { approveWriteTools: false } },
      ],
    });
    await runEvalConfig({ configPath: f.configPath, rootDir: f.dir });
    expect(
      f.observe.mock.calls.map(([, context]) => context.evalConfig.coworkSetup)
    ).toEqual([
      { approveWriteTools: true },
      { approveWriteTools: true },
      { approveWriteTools: false },
    ]);
  });

  it('loads canonical datasets once and isolates variant prompts', async () => {
    const original = { ...scenario, args: { nested: { untouched: true } } };
    const f = await fixture([original], {
      variants: [
        { name: 'a', inputTemplate: 'A {{input}}' },
        { name: 'b', inputTemplate: 'B {{input}}' },
      ],
    });
    const result = await runEvalConfig({
      configPath: f.configPath,
      rootDir: f.dir,
    });
    expect(f.load).toHaveBeenCalledTimes(1);
    expect(f.observe.mock.calls.map(([input]) => input.prompt)).toEqual([
      'A Find documents',
      'B Find documents',
    ]);
    expect(original.input).toBe('Find documents');
    expect(result.datasets[0]?.dataset).toEqual({
      name: 'canonical',
      cases: [original],
      // A plugin's dataset says which one it is.
      origin: { type: expect.stringMatching(/^test\/dataset\//) },
    });
  });

  it('merges raw base, variant, and case client options before parsing transforms once', async () => {
    const run = vi.fn(async () => ({ finalText: 'OK', events: [] }));
    const name = addClient(`transform-client-${sequence++}`, {
      schema: z.object({
        count: z.number().transform((value) => value * 3),
        model: z.string(),
      }),
      run,
    });
    const f = await fixture([{ ...scenario, client: name, model: 'case' }], {
      client: name,
      model: 'base',
      clientOptions: { count: 2 },
      variants: [{ name: 'a', model: 'variant' }],
    });
    await runEvalConfig({ configPath: f.configPath, rootDir: f.dir });
    expect(run).toHaveBeenCalledWith(
      expect.anything(),
      { type: name, count: 6, model: 'case' },
      expect.anything()
    );
  });

  it('retains top-level client defaults when a case patches the model', async () => {
    const run = vi.fn<NonNullable<ClientDefinition['run']>>(async () => ({
      finalText: 'OK',
      events: [],
    }));
    const name = addClient(`defaults-client-${sequence++}`, {
      schema: z.object({
        count: z.number().transform((value) => value * 3),
        model: z.string().optional(),
        provider: z.string().optional(),
        timeout: z.number().optional(),
        maxToolCalls: z.number().optional(),
      }),
      run,
    });
    const f = await fixture(
      [
        { ...scenario, id: 'baseline' },
        { ...scenario, id: 'patched', client: name, model: 'case' },
      ],
      {
        client: name,
        clientOptions: { count: 2 },
        model: 'suite',
        provider: 'openai',
        timeout: 123,
        maxToolCalls: 0,
        variants: [
          { name: 'inherited' },
          { name: 'override', clientOptions: { timeout: 321 } },
        ],
      }
    );
    const result = await runEvalConfig({
      configPath: f.configPath,
      rootDir: f.dir,
    });
    expect(result.summary.results.every((entry) => entry.pass)).toBe(true);
    expect(run.mock.calls.map(([, config]) => config)).toEqual([
      {
        type: name,
        count: 6,
        model: 'suite',
        provider: 'openai',
        timeout: 123,
        maxToolCalls: 0,
      },
      {
        type: name,
        count: 6,
        model: 'case',
        provider: 'openai',
        timeout: 123,
        maxToolCalls: 0,
      },
      {
        type: name,
        count: 6,
        model: 'suite',
        provider: 'openai',
        timeout: 321,
        maxToolCalls: 0,
      },
      {
        type: name,
        count: 6,
        model: 'case',
        provider: 'openai',
        timeout: 321,
        maxToolCalls: 0,
      },
    ]);
  });

  it('applies run controls and rejects unsupported/conflicting controls', async () => {
    const f = await fixture(
      [
        { ...scenario, id: 'skip', tags: ['other'] },
        { ...scenario, id: 'selected', tags: ['wanted'] },
        { ...scenario, id: 'capped', tags: ['wanted'] },
      ],
      { filterTags: ['wanted'], run: { trials: 2, maxCases: 1 } }
    );
    // Every client must exist before the first run installs the test plugin.
    const invalidFixtures = [];
    for (const extra of [
      { profile: 'ignored' },
      { run: { profile: 'ignored' } },
      { run: { unknown: true } },
      { trials: 3, run: { trials: 2 } },
    ])
      invalidFixtures.push(await fixture([scenario], extra));
    const result = await runEvalConfig({
      configPath: f.configPath,
      rootDir: f.dir,
    });
    expect(f.run).toHaveBeenCalledTimes(2);
    expect(result.summary.results.map((entry) => entry.id)).toEqual([
      'selected',
    ]);
    for (const invalid of invalidFixtures) {
      await expect(
        runEvalConfig({
          configPath: invalid.configPath,
          rootDir: invalid.dir,
          dryRun: true,
        })
      ).rejects.toThrow();
      expect(invalid.run).not.toHaveBeenCalled();
    }
  });

  it('traverses recursive directories through the public eval source path', async () => {
    const f = await fixture([scenario]);
    const sourceDir = path.join(f.dir, 'datasets');
    await fs.mkdir(path.join(sourceDir, 'nested'), { recursive: true });
    await fs.writeFile(
      path.join(sourceDir, 'a.json'),
      JSON.stringify({ name: 'a', cases: [{ ...scenario, id: 'a' }] })
    );
    await fs.writeFile(
      path.join(sourceDir, 'nested', 'b.json'),
      JSON.stringify({ name: 'b', cases: [{ ...scenario, id: 'b' }] })
    );
    await fs.writeFile(
      f.configPath,
      JSON.stringify({
        ...f.evalConfig,
        datasets: [{ type: 'dir', path: sourceDir, recursive: true }],
      })
    );
    const result = await runEvalConfig({
      configPath: f.configPath,
      rootDir: f.dir,
    });
    expect(result.summary.results.map((entry) => entry.id)).toEqual(['a', 'b']);
  });

  it('does not mutate TLS or per-eval environment settings, including dry runs', async () => {
    vi.stubEnv('NODE_TLS_REJECT_UNAUTHORIZED', '1');
    vi.stubEnv('EVAL_ITERATIONS', 'untouched');
    const f = await fixture([scenario], { trials: 9, model: 'chosen' });
    await runEvalConfig({
      configPath: f.configPath,
      rootDir: f.dir,
      dryRun: true,
    });
    expect(process.env.NODE_TLS_REJECT_UNAUTHORIZED).toBe('1');
    expect(process.env.EVAL_ITERATIONS).toBe('untouched');
    expect(f.run).not.toHaveBeenCalled();
  });
  it('runs text, call-count and plugin judge assertions for every custom-client trial', async () => {
    const judge = vi.fn(async () => ({ score: 0 }));
    const judgeName = addJudge(`review-judge-${sequence++}`, {
      schema: z.object({}).passthrough(),
      evaluate: judge,
    });
    const f = await fixture([
      {
        ...scenario,
        trials: 3,
        assertions: { containsText: 'EXPECTED', toolCallCount: { min: 1 } },
        judges: [{ type: judgeName }],
      },
    ]);
    const result = await runEvalConfig({
      configPath: f.configPath,
      rootDir: f.dir,
    });
    expect(f.run).toHaveBeenCalledTimes(3);
    expect(judge).toHaveBeenCalledTimes(3);
    expect(result.summary.results[0]?.pass).toBe(false);
    expect(result.summary.results[0]?.trialResults).toHaveLength(3);
  });
  it('preserves per-case client overrides and trials for canonical client mode', async () => {
    const alternate = await fixture([scenario]);
    const f = await fixture(
      [
        {
          ...scenario,
          client: alternate.type,
          model: 'case-model',
        },
      ],
      { trials: 2 }
    );
    await runEvalConfig({ configPath: f.configPath, rootDir: f.dir });
    expect(f.run).not.toHaveBeenCalled();
    expect(alternate.run).toHaveBeenCalledTimes(2);
    expect(alternate.run.mock.calls[0]?.[0].client.model).toBe('case-model');
  });
  it('retains eval config and variant judge settings with a stripping policy schema', async () => {
    const evaluate = vi.fn(async () => ({ score: 0.8 }));
    const name = addJudge(`options-judge-${sequence++}`, {
      schema: z.object({ count: z.number().transform((value) => value * 3) }),
      evaluate,
    });
    const f = await fixture([scenario], {
      judges: [
        { type: name, count: 2, threshold: 0.9, reference: 'config-gold' },
      ],
      variants: [
        { name: 'baseline' },
        {
          name: 'variant',
          judges: [
            {
              type: name,
              count: 4,
              threshold: 0.95,
              reference: 'variant-gold',
            },
          ],
        },
      ],
    });
    const result = await runEvalConfig({
      configPath: f.configPath,
      rootDir: f.dir,
    });
    expect(
      result.summary.variants.map((variant) => variant.result?.passed)
    ).toEqual([0, 0]);
    expect(evaluate).toHaveBeenCalledTimes(2);
    expect(evaluate).toHaveBeenNthCalledWith(1, expectedAnswer('config-gold'), {
      count: 6,
    });
    expect(evaluate).toHaveBeenNthCalledWith(
      2,
      expectedAnswer('variant-gold'),
      {
        count: 12,
      }
    );
  });

  it.each([
    ['stripping', 'nested'],
    ['stripping', 'flat'],
    ['passthrough', 'nested'],
    ['passthrough', 'flat'],
  ] as const)(
    'lets case judge settings override eval config defaults with a %s schema and %s policy',
    async (policyMode, casePolicy) => {
      const policySchema = z.object({
        count: z.number().transform((value) => value * 3),
        retained: z.string(),
      });
      const evaluate = vi.fn(async () => ({ score: 0.8 }));
      const name = addJudge(`precedence-judge-${sequence++}`, {
        schema:
          policyMode === 'passthrough'
            ? policySchema.passthrough()
            : policySchema,
        evaluate,
      });
      const f = await fixture(
        [
          {
            ...scenario,
            id: 'default',
          },
          {
            ...scenario,
            id: 'case',
            expected: { answer: 'canonical-gold' },
            judges: [
              {
                type: name,
                threshold: 0.9,
                reference: 'case-gold',
                ...(casePolicy === 'nested'
                  ? { options: { count: 4 } }
                  : { count: 4 }),
              },
            ],
          },
        ],
        {
          judges: [
            {
              type: name,
              count: 2,
              retained: 'config-policy',
              threshold: 0.7,
              reference: 'config-gold',
            },
          ],
        }
      );
      const result = await runEvalConfig({
        configPath: f.configPath,
        rootDir: f.dir,
      });
      expect(result.summary.results.map((entry) => entry.pass)).toEqual([
        true,
        false,
      ]);
      expect(evaluate).toHaveBeenCalledTimes(2);
      expect(evaluate).toHaveBeenNthCalledWith(
        1,
        expectedAnswer('config-gold'),
        expect.objectContaining({ count: 6, retained: 'config-policy' })
      );
      expect(evaluate).toHaveBeenNthCalledWith(
        2,
        expectedAnswer('case-gold'),
        expect.objectContaining({ count: 12, retained: 'config-policy' })
      );
    }
  );

  it('applies eval config judges to canonical cases and respects variant judge overrides', async () => {
    const evaluate = vi.fn(async () => ({ score: 0 }));
    const name = addJudge(`config-judge-${sequence++}`, {
      schema: z.object({}).passthrough(),
      evaluate,
    });
    const f = await fixture([scenario], {
      judges: [{ type: name, reference: 'expected' }],
      variants: [{ name: 'judged' }, { name: 'unjudged', judges: [] }],
    });
    const result = await runEvalConfig({
      configPath: f.configPath,
      rootDir: f.dir,
    });
    expect(evaluate).toHaveBeenCalledTimes(1);
    expect(
      result.summary.variants.map((variant) => variant.result?.passed)
    ).toEqual([0, 1]);
  });
  it('merges client patches, forwards parsed defaults and computes each variant independently', async () => {
    const f = await fixture([
      { ...scenario, assertions: { containsText: 'EXPECTED' } },
    ]);
    await fs.writeFile(
      f.configPath,
      JSON.stringify({
        ...f.evalConfig,
        client: f.type,
        model: 'base',
        clientOptions: { retained: 'yes' },
        metrics: ['passed'],
        variants: [
          { name: 'a' },
          { name: 'b', client: f.type, model: 'variant' },
        ],
      })
    );
    f.run.mockImplementation(async (options) => ({
      response: {
        success: true,
        response: options.client.model === 'base' ? 'EXPECTED' : 'WRONG',
        toolCalls: [],
      },
    }));
    const result = await runEvalConfig({
      configPath: f.configPath,
      rootDir: f.dir,
    });
    expect(f.run.mock.calls.map(([options]) => options.client.model)).toEqual([
      'base',
      'variant',
    ]);
    expect(f.run.mock.calls[1]?.[0].client.retained).toBe('yes');
    expect(
      result.summary.variants.map((variant) => variant.result?.passed)
    ).toEqual([1, 0]);
    expect(
      result.summary.variants.map((variant) => variant.metrics?.passed_rate)
    ).toEqual([1, 0]);
  });
  it('maps multiple native tools to a canonical assertion without dropping argument checks', async () => {
    const f = await fixture(
      [
        {
          ...scenario,
          assertions: {
            toolsTriggered: {
              calls: [
                {
                  name: 'search',
                  required: true,
                  arguments: { query: 'wanted' },
                },
              ],
            },
          },
        },
      ],
      { toolMap: { search: ['github.search', 'chat.search'] } }
    );
    f.run.mockResolvedValue({
      response: {
        success: true,
        response: 'OK',
        toolCalls: [{ name: 'chat.search', arguments: { query: 'wrong' } }],
      },
    });
    expect(
      (await runEvalConfig({ configPath: f.configPath, rootDir: f.dir }))
        .summary.results[0]?.pass
    ).toBe(false);
    f.run.mockResolvedValue({
      response: {
        success: true,
        response: 'OK',
        toolCalls: [{ name: 'github.search', arguments: { query: 'wanted' } }],
      },
    });
    expect(
      (await runEvalConfig({ configPath: f.configPath, rootDir: f.dir }))
        .summary.results[0]?.pass
    ).toBe(true);
  });
  it('passes complete labeled server sets but only persists allowlisted unresolved descriptions', async () => {
    vi.stubEnv('REVIEW_TOKEN', 'dummy-secret-do-not-save');
    const f = await fixture([scenario], {
      servers: {
        one: {
          transport: 'http',
          serverUrl: 'https://example.com/eval',
          headers: { 'X-Secret': 'header-secret' },
          auth: { accessTokenEnv: 'REVIEW_TOKEN' },
        },
        two: {
          transport: 'stdio',
          command: 'test',
          args: ['arg-secret'],
          env: { KEY: 'env-secret' },
        },
      },
    });
    const result = await runEvalConfig({
      configPath: f.configPath,
      rootDir: f.dir,
    });
    expect(f.run.mock.calls[0]?.[0].servers).toHaveLength(2);
    const json = await fs.readFile(
      path.join(result.outputDir, 'summary.json'),
      'utf8'
    );
    for (const secret of [
      'dummy-secret-do-not-save',
      'header-secret',
      'arg-secret',
      'env-secret',
    ])
      expect(json).not.toContain(secret);
    expect(json).toContain('REVIEW_TOKEN');
  });
  it('passes client-resolved stdio eval servers unmerged and checks their url against /eval', async () => {
    vi.stubEnv('FAKE_TOKEN', 'dummy-token-do-not-merge');
    const evalServer = {
      transport: 'stdio',
      label: 'fake-eval',
      command: 'node',
      args: ['${pluginRoot:fake}/mcp/start.mjs'],
      url: 'https://example.com/mcp/default/eval',
      auth: { accessTokenEnv: 'FAKE_TOKEN' },
      env: { FAKE_MCP_URL: '${url}' },
    };
    const { label, ...unlabelled } = evalServer;
    const f = await fixture([scenario], {
      servers: { [label]: unlabelled },
      requireEvalEndpoint: true,
    });
    const bad = await fixture([scenario], {
      servers: {
        [label]: { ...unlabelled, url: 'https://example.com/mcp/default' },
      },
      requireEvalEndpoint: true,
    });
    await runEvalConfig({ configPath: f.configPath, rootDir: f.dir });
    const passed = f.run.mock.calls[0]?.[0].servers;
    expect(passed).toEqual([evalServer]);
    expect(JSON.stringify(passed)).not.toContain('dummy-token-do-not-merge');
    await expect(
      runEvalConfig({ configPath: bad.configPath, rootDir: bad.dir })
    ).rejects.toThrow('/eval MCP endpoint');
  });
  it.each([true, false])(
    'redacts every persisted response by default with explicit opt-out (%s)',
    async (redact) => {
      const f = await fixture([{ ...scenario, trials: 2 }]);
      f.run.mockResolvedValue({
        response: {
          success: true,
          response: 'PRIVATE_RESPONSE_MARKER',
          toolCalls: [],
        },
      });
      const storeDir = path.join(f.dir, 'store');
      await fs.writeFile(
        f.configPath,
        JSON.stringify({
          ...f.evalConfig,
          results: { store: { type: 'file', dir: storeDir } },
          ...(redact ? {} : { redactStoredResponses: false }),
        })
      );
      const result = await runEvalConfig({
        configPath: f.configPath,
        rootDir: f.dir,
      });
      const local = await fs.readFile(
        path.join(result.outputDir, 'results.json'),
        'utf8'
      );
      expect(local.includes('PRIVATE_RESPONSE_MARKER')).toBe(!redact);
      const store = new FileEvalResultStore({
        provider: 'file',
        dir: storeDir,
      });
      for (const kind of ['eval-runner-result', 'eval-run-summary'] as const) {
        expect(
          JSON.stringify(await store.loadLatestArtifact(kind)).includes(
            'PRIVATE_RESPONSE_MARKER'
          )
        ).toBe(!redact);
      }
    }
  );

  it('keeps unique per-variant canonical artifacts consumable by comparison and stores separate summaries', async () => {
    const f = await fixture([scenario]);
    const storeDir = path.join(f.dir, 'store');
    await fs.writeFile(
      f.configPath,
      JSON.stringify({
        ...f.evalConfig,
        results: { store: { type: 'file', dir: storeDir } },
      })
    );
    await runEvalConfig({ configPath: f.configPath, rootDir: f.dir });
    await runEvalConfig({ configPath: f.configPath, rootDir: f.dir });
    const store = new FileEvalResultStore({ provider: 'file', dir: storeDir });
    const entries = await store.listArtifacts('eval-runner-result');
    expect(entries).toHaveLength(2);
    expect(await store.listArtifacts('eval-run-summary')).toHaveLength(2);
    const result = await loadStoredEvalRunnerResult(store, {
      id: entries[0]!.id,
    });
    expect(result.data.caseResults).toHaveLength(1);
    expect(() =>
      compareEvalRuns({ baseline: result.data, candidate: result.data })
    ).not.toThrow();
  });
});

describe('eval plugins', () => {
  const acceptAll = `{ safeParse: (value) => ({ success: true, data: value }) }`;

  it('rejects an eval config that references a plugin it does not load, even when another eval installed it', async () => {
    const f = await fixture([scenario]);
    // Another eval in this process has already installed the plugin.
    installPlugins([testPlugin]);
    expect(loadedNamespaces()).toContain('test');

    await expect(
      runEval({ configPath: f.configPath, rootDir: f.dir })
    ).rejects.toThrow(`doesn't load the "test" plugin`);
    expect(f.load).not.toHaveBeenCalled();
    expect(f.run).not.toHaveBeenCalled();
  });

  it('adds CLI plugin paths to the eval config plugins', async () => {
    const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'suite-plugins-'));
    dirs.push(rootDir);
    const evalDir = path.join(rootDir, 'suite');
    await fs.mkdir(evalDir);
    await fs.writeFile(
      path.join(evalDir, 'config-plugin.mjs'),
      `export default {
        meta: { name: 'config-plugin', namespace: 'mp' },
        datasetSources: {
          cases: {
            schema: ${acceptAll},
            load: async () => ({
              name: 'from-config-plugin',
              cases: [{ id: 'case', input: 'hello' }],
            }),
          },
        },
      };`
    );
    await fs.writeFile(
      path.join(rootDir, 'cli-plugin.mjs'),
      `export default {
        meta: { name: 'cli-plugin', namespace: 'cli' },
        clients: {
          echo: {
            schema: ${acceptAll},
            run: async () => ({ finalText: 'OK', events: [] }),
          },
        },
      };`
    );
    const configPath = path.join(evalDir, 'eval.json');
    await fs.writeFile(
      configPath,
      JSON.stringify({
        name: 'cli-and-config-plugins',
        plugins: ['./config-plugin.mjs'],
        datasets: [{ type: 'mp/dataset/cases' }],
        client: 'cli/client/echo',
      })
    );

    const result = await runEval({
      configPath,
      rootDir,
      pluginPaths: ['./cli-plugin.mjs'],
    });

    expect(loadedNamespaces()).toEqual(['cli', 'mp']);
    expect(result.datasets[0]?.dataset?.name).toBe('from-config-plugin');
    expect(result.summary.results.map((entry) => entry.pass)).toEqual([true]);
  });

  it('rejects a dataset judge from a plugin the eval does not load', async () => {
    const evaluate = vi.fn(async () => ({ score: 1 }));
    const other: Plugin = {
      meta: { name: 'other-plugin', namespace: 'other' },
      judges: { x: { schema: z.object({}).passthrough(), evaluate } },
    };
    installPlugins([other]);
    const f = await fixture([
      { ...scenario, judges: [{ type: 'other/judge/x' }] },
    ]);

    await expect(
      runEvalConfig({ configPath: f.configPath, rootDir: f.dir })
    ).rejects.toThrow(
      `Dataset "canonical" references "other/judge/x", but doesn't load the "other" plugin`
    );
    expect(f.run).not.toHaveBeenCalled();
    expect(evaluate).not.toHaveBeenCalled();
  });
});
