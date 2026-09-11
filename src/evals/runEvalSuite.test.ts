import type { EvalExecutionResult } from './hostTrace.js';
import { simulationToHostTrace } from './hostTrace.js';
import type { MCPHostSimulationResult } from './mcpHost/mcpHostTypes.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import { runEvalSuite } from './runEvalSuite.js';
import { getBuiltinHostConfig } from './builtinHosts.js';
import {
  registerHost,
  registerDatasetSource,
  registerJudge,
} from './frameworkRegistries.js';
import type { EvalCase, EvalDataset } from './datasetTypes.js';
import type {
  DatasetSourceContext,
  HostDefinition,
  HostRunOptions,
  HostRunInput,
  HostRunContext,
} from './evalFrameworkTypes.js';
import { FileEvalResultStore } from './resultStore.js';
import {
  compareEvalRuns,
  loadStoredEvalRunnerResult,
} from './evalRunComparison.js';

const dirs: string[] = [];
let sequence = 0;
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(
    dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true }))
  );
});
async function fixture(
  cases: EvalCase[],
  extra: Record<string, unknown> = {},
  run = vi.fn<(options: HostRunOptions) => Promise<EvalExecutionResult>>(
    async () => ({
      response: { success: true, response: 'WRONG', toolCalls: [] },
    })
  )
) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'suite-review-'));
  dirs.push(dir);
  const type = `review-host-${sequence++}`;
  const source = `review-source-${sequence++}`;
  const observe =
    vi.fn<(input: HostRunInput, context: HostRunContext) => void>();
  const load = vi.fn(
    async (): Promise<EvalDataset> => ({ name: 'canonical', cases })
  );
  registerHost({
    name: type,
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
        host: config,
        manifest: context.manifest,
        arm: context.arm,
      });
      return simulationToHostTrace(
        result.response as MCPHostSimulationResult,
        input.servers
      );
    },
  });
  registerDatasetSource({
    name: source,
    schema: z.object({ type: z.string() }),
    load,
  });
  const manifestPath = path.join(dir, 'manifest.json');
  const manifest = {
    name: 'review',
    datasets: [{ type: source }],
    host: { type },
    servers: [],
    ...extra,
  };
  await fs.writeFile(manifestPath, JSON.stringify(manifest));
  return { dir, manifestPath, manifest, run, type, observe, load };
}
const scenario: EvalCase = {
  id: 'same',
  mode: 'mcp_host',
  scenario: 'Find documents',
  mcpHostConfig: { provider: 'anthropic' },
};

describe('suite review regressions', () => {
  it('isolates secrets files across dry, sequential, and concurrent suites', async () => {
    vi.stubEnv('SUITE_DUMMY_TOKEN', undefined);
    const f = await fixture([scenario], {
      servers: [
        {
          transport: 'http',
          serverUrl: 'https://example.com/eval',
          auth: { accessTokenEnv: 'SUITE_DUMMY_TOKEN' },
        },
      ],
    });
    const first = path.join(f.dir, 'first.env');
    const second = path.join(f.dir, 'second.json');
    await fs.writeFile(
      first,
      'SUITE_DUMMY_TOKEN=first-dummy\nSUITE_DUMMY_HOST_KEY=first-host'
    );
    await fs.writeFile(
      second,
      JSON.stringify({
        SUITE_DUMMY_TOKEN: 'second-dummy',
        SUITE_DUMMY_HOST_KEY: 'second-host',
      })
    );
    await runEvalSuite({
      manifestPath: f.manifestPath,
      rootDir: f.dir,
      secretsFile: first,
      dryRun: true,
    });
    expect(process.env.SUITE_DUMMY_TOKEN).toBeUndefined();
    await runEvalSuite({
      manifestPath: f.manifestPath,
      rootDir: f.dir,
      secretsFile: first,
    });
    await runEvalSuite({
      manifestPath: f.manifestPath,
      rootDir: f.dir,
      secretsFile: second,
    });
    await Promise.all([
      runEvalSuite({
        manifestPath: f.manifestPath,
        rootDir: f.dir,
        secretsFile: first,
      }),
      runEvalSuite({
        manifestPath: f.manifestPath,
        rootDir: f.dir,
        secretsFile: second,
      }),
    ]);
    const observedTokens = f.observe.mock.calls.map(
      ([input]) => input.env?.SUITE_DUMMY_TOKEN
    );
    expect(observedTokens.slice(0, 2)).toEqual(['first-dummy', 'second-dummy']);
    // Concurrent suites may finish in either order; each must keep its own token.
    expect(observedTokens.slice(2).sort()).toEqual([
      'first-dummy',
      'second-dummy',
    ]);
    expect(process.env.SUITE_DUMMY_TOKEN).toBeUndefined();
    await expect(
      runEvalSuite({ manifestPath: f.manifestPath, rootDir: f.dir })
    ).rejects.toThrow('SUITE_DUMMY_TOKEN');
  });

  it.each(['manifest', 'override'] as const)(
    'resolves %s server credentials before creating the source CLI config',
    async (serverSource) => {
      vi.stubEnv('SUITE_DUMMY_TOKEN', undefined);
      vi.stubEnv('SUITE_DUMMY_HOST_KEY', undefined);
      vi.stubEnv('MCP_PLUGIN_DIR', undefined);
      const name = `source-cli-${sequence++}`;
      const source = `source-cli-data-${sequence++}`;
      const run = vi.fn<NonNullable<HostDefinition['run']>>(async () => ({
        finalText: 'OK',
        events: [],
      }));
      registerHost({
        name,
        schema: z.object({}),
        createConfig(options) {
          const { type: _type, ...hostOptions } = options ?? {};
          return getBuiltinHostConfig('claude-cli', hostOptions);
        },
        run,
      });
      const sourceConfigs: DatasetSourceContext['hostConfig'][] = [];
      registerDatasetSource({
        name: source,
        schema: z.object({}),
        async load(_config, context) {
          sourceConfigs.push(context.hostConfig);
          return {
            name: 'cli-source',
            cases: [{ id: 'case', mode: 'host', scenario: 'Find documents' }],
          };
        },
      });
      const server = {
        transport: 'http' as const,
        label: 'protected',
        serverUrl: 'https://example.com/eval',
        auth: { accessTokenEnv: 'SUITE_DUMMY_TOKEN' },
      };
      const f = await fixture([], {
        datasets: [{ type: source }],
        host: { type: name },
        servers: serverSource === 'manifest' ? [server] : [],
      });
      const secretsFile = path.join(f.dir, 'secrets.env');
      await fs.writeFile(
        secretsFile,
        'SUITE_DUMMY_TOKEN=source-dummy\nSUITE_DUMMY_HOST_KEY=source-host'
      );
      const result = await runEvalSuite({
        manifestPath: f.manifestPath,
        rootDir: f.dir,
        secretsFile,
        ...(serverSource === 'override' ? { mcpConfig: server } : {}),
      });
      expect(result.summary.results[0]?.pass).toBe(true);
      expect(sourceConfigs).toHaveLength(1);
      expect(sourceConfigs[0]?.mcpServers?.protected).toMatchObject({
        headers: { Authorization: 'Bearer source-dummy' },
      });
      expect(sourceConfigs[0]?.cli?.env?.SUITE_DUMMY_HOST_KEY).toBe(
        'source-host'
      );
      expect(run.mock.calls[0]?.[0].servers[0]).toEqual({
        ...server,
        auth: { accessToken: 'source-dummy' },
      });
      expect(process.env.SUITE_DUMMY_TOKEN).toBeUndefined();
      expect(process.env.SUITE_DUMMY_HOST_KEY).toBeUndefined();
      const saved = await fs.readFile(
        path.join(result.outputDir, 'results.json'),
        'utf8'
      );
      expect(saved).not.toContain('source-dummy');
      expect(saved).not.toContain('source-host');
    }
  );

  it.each(['claude-cli', 'vercel-sdk'])(
    'preserves declared %s environment in dataset source context',
    async (type) => {
      vi.stubEnv('HOST_ENV_SHARED', 'ambient');
      vi.stubEnv('HOST_ENV_SUITE_ONLY', undefined);
      vi.stubEnv('HOST_ENV_DECLARED_ONLY', undefined);
      vi.stubEnv('MCP_PLUGIN_DIR', undefined);
      const source = `host-env-source-${sequence++}`;
      const sourceConfigs: DatasetSourceContext['hostConfig'][] = [];
      registerDatasetSource({
        name: source,
        schema: z.object({}),
        async load(_config, context) {
          sourceConfigs.push(context.hostConfig);
          return { name: 'host-env', cases: [] };
        },
      });
      const declaredEnv = {
        HOST_ENV_SHARED: 'declared',
        HOST_ENV_DECLARED_ONLY: 'host-only',
      };
      const f = await fixture([], {
        datasets: [{ type: source }],
        host: { type, env: declaredEnv },
      });
      const secretsFile = path.join(f.dir, 'secrets.env');
      await fs.writeFile(
        secretsFile,
        'HOST_ENV_SHARED=suite\nHOST_ENV_SUITE_ONLY=suite-only'
      );
      const result = await runEvalSuite({
        manifestPath: f.manifestPath,
        rootDir: f.dir,
        secretsFile,
      });
      expect(sourceConfigs).toHaveLength(1);
      const sourceConfig = sourceConfigs[0];
      expect(sourceConfig?.cli?.env ?? sourceConfig?.env).toMatchObject({
        HOST_ENV_SHARED: 'declared',
        HOST_ENV_DECLARED_ONLY: 'host-only',
        HOST_ENV_SUITE_ONLY: 'suite-only',
      });
      expect(result.manifest.host?.env).toEqual(declaredEnv);
      expect(JSON.parse(await fs.readFile(f.manifestPath, 'utf8'))).toEqual(
        f.manifest
      );
      expect(process.env.HOST_ENV_SHARED).toBe('ambient');
      expect(process.env.HOST_ENV_SUITE_ONLY).toBeUndefined();
      expect(process.env.HOST_ENV_DECLARED_ONLY).toBeUndefined();
    }
  );

  it('loads canonical datasets once and isolates arm prompts', async () => {
    const original = { ...scenario, args: { nested: { untouched: true } } };
    const f = await fixture([original], {
      arms: [
        { name: 'a', scenarioTemplate: 'A {{scenario}}' },
        { name: 'b', scenarioTemplate: 'B {{scenario}}' },
      ],
    });
    const result = await runEvalSuite({
      manifestPath: f.manifestPath,
      rootDir: f.dir,
    });
    expect(f.load).toHaveBeenCalledTimes(1);
    expect(f.observe.mock.calls.map(([input]) => input.scenario)).toEqual([
      'A Find documents',
      'B Find documents',
    ]);
    expect(original.scenario).toBe('Find documents');
    expect(result.datasets[0]?.dataset).toEqual({
      name: 'canonical',
      cases: [original],
    });
  });

  it('merges raw base, arm, and case host options before parsing transforms once', async () => {
    const name = `transform-host-${sequence++}`;
    const run = vi.fn(async () => ({ finalText: 'OK', events: [] }));
    registerHost({
      name,
      schema: z.object({
        count: z.number().transform((value) => value * 3),
        model: z.string(),
      }),
      run,
    });
    const f = await fixture(
      [{ ...scenario, host: { type: name, model: 'case' } }],
      {
        host: { type: name, count: 2, model: 'base' },
        arms: [{ name: 'a', host: { model: 'arm' } }],
      }
    );
    await runEvalSuite({ manifestPath: f.manifestPath, rootDir: f.dir });
    expect(run).toHaveBeenCalledWith(
      expect.anything(),
      { type: name, count: 6, model: 'case' },
      expect.anything()
    );
  });

  it('retains top-level host defaults when a case patches the model', async () => {
    const name = `defaults-host-${sequence++}`;
    const run = vi.fn<NonNullable<HostDefinition['run']>>(async () => ({
      finalText: 'OK',
      events: [],
    }));
    registerHost({
      name,
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
        { ...scenario, id: 'patched', host: { type: name, model: 'case' } },
      ],
      {
        host: { type: name, count: 2 },
        model: 'suite',
        provider: 'openai',
        timeout: 123,
        maxToolCalls: 0,
        arms: [
          { name: 'inherited' },
          { name: 'override', host: { timeout: 321 } },
        ],
      }
    );
    const result = await runEvalSuite({
      manifestPath: f.manifestPath,
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
      { filterTags: ['wanted'], run: { iterations: 2, maxCases: 1 } }
    );
    const result = await runEvalSuite({
      manifestPath: f.manifestPath,
      rootDir: f.dir,
    });
    expect(f.run).toHaveBeenCalledTimes(2);
    expect(result.summary.results.map((entry) => entry.id)).toEqual([
      'selected',
    ]);
    for (const extra of [
      { profile: 'ignored' },
      { run: { profile: 'ignored' } },
      { run: { unknown: true } },
      { iterations: 3, run: { iterations: 2 } },
    ]) {
      const invalid = await fixture([scenario], extra);
      await expect(
        runEvalSuite({
          manifestPath: invalid.manifestPath,
          rootDir: invalid.dir,
          dryRun: true,
        })
      ).rejects.toThrow();
      expect(invalid.run).not.toHaveBeenCalled();
    }
  });

  it('traverses recursive directories through the public suite source path', async () => {
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
      f.manifestPath,
      JSON.stringify({
        ...f.manifest,
        datasets: [{ type: 'dir', path: sourceDir, recursive: true }],
      })
    );
    const result = await runEvalSuite({
      manifestPath: f.manifestPath,
      rootDir: f.dir,
    });
    expect(result.summary.results.map((entry) => entry.id)).toEqual(['a', 'b']);
  });

  it('does not mutate TLS or per-suite environment settings, including dry runs', async () => {
    vi.stubEnv('NODE_TLS_REJECT_UNAUTHORIZED', '1');
    vi.stubEnv('EVAL_ITERATIONS', 'untouched');
    const f = await fixture([scenario], { iterations: 9, model: 'chosen' });
    await runEvalSuite({
      manifestPath: f.manifestPath,
      rootDir: f.dir,
      dryRun: true,
    });
    expect(process.env.NODE_TLS_REJECT_UNAUTHORIZED).toBe('1');
    expect(process.env.EVAL_ITERATIONS).toBe('untouched');
    expect(f.run).not.toHaveBeenCalled();
  });
  it('runs text, call-count and registered judge assertions for every custom-host iteration', async () => {
    const judge = vi.fn(async () => ({ score: 0 }));
    const judgeName = `review-judge-${sequence++}`;
    registerJudge({
      name: judgeName,
      schema: z.object({}).passthrough(),
      evaluate: judge,
    });
    const f = await fixture([
      {
        ...scenario,
        iterations: 3,
        expect: {
          containsText: 'EXPECTED',
          toolCallCount: { min: 1 },
          passesJudge: { judge: judgeName },
        },
      },
    ]);
    const result = await runEvalSuite({
      manifestPath: f.manifestPath,
      rootDir: f.dir,
    });
    expect(f.run).toHaveBeenCalledTimes(3);
    expect(judge).toHaveBeenCalledTimes(3);
    expect(result.summary.results[0]?.pass).toBe(false);
    expect(result.summary.results[0]?.iterationResults).toHaveLength(3);
  });
  it('preserves per-case host overrides and iterations for canonical host mode', async () => {
    const alternate = await fixture([scenario]);
    const f = await fixture(
      [
        {
          ...scenario,
          mode: 'host',
          host: { type: alternate.type, model: 'case-model' },
        },
      ],
      { iterations: 2 }
    );
    await runEvalSuite({ manifestPath: f.manifestPath, rootDir: f.dir });
    expect(f.run).not.toHaveBeenCalled();
    expect(alternate.run).toHaveBeenCalledTimes(2);
    expect(alternate.run.mock.calls[0]?.[0].host.model).toBe('case-model');
  });
  it('retains manifest and arm judge settings with a stripping policy schema', async () => {
    const name = `options-judge-${sequence++}`;
    const evaluate = vi.fn(async () => ({ score: 0.8 }));
    registerJudge({
      name,
      schema: z.object({ count: z.number().transform((value) => value * 3) }),
      evaluate,
    });
    const f = await fixture([scenario], {
      judges: [
        { type: name, count: 2, threshold: 0.9, reference: 'manifest-gold' },
      ],
      arms: [
        { name: 'baseline' },
        {
          name: 'variant',
          judges: [
            { type: name, count: 4, threshold: 0.95, reference: 'arm-gold' },
          ],
        },
      ],
    });
    const result = await runEvalSuite({
      manifestPath: f.manifestPath,
      rootDir: f.dir,
    });
    expect(result.summary.arms.map((arm) => arm.result?.passed)).toEqual([
      0, 0,
    ]);
    expect(evaluate).toHaveBeenCalledTimes(2);
    expect(evaluate).toHaveBeenNthCalledWith(
      1,
      expect.anything(),
      'manifest-gold',
      {
        count: 6,
      }
    );
    expect(evaluate).toHaveBeenNthCalledWith(2, expect.anything(), 'arm-gold', {
      count: 12,
    });
  });

  it.each([
    ['stripping', 'nested'],
    ['stripping', 'flat'],
    ['passthrough', 'nested'],
    ['passthrough', 'flat'],
  ] as const)(
    'lets case judge settings override manifest defaults with a %s schema and %s policy',
    async (policyMode, casePolicy) => {
      const name = `precedence-judge-${sequence++}`;
      const policySchema = z.object({
        count: z.number().transform((value) => value * 3),
        retained: z.string(),
      });
      const evaluate = vi.fn(async () => ({ score: 0.8 }));
      registerJudge({
        name,
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
            canonicalAnswer: 'canonical-gold',
            expect: {
              passesJudge: {
                judge: name,
                threshold: 0.9,
                reference: 'case-gold',
                ...(casePolicy === 'nested'
                  ? { options: { count: 4 } }
                  : { count: 4 }),
              },
            },
          },
        ],
        {
          judges: [
            {
              type: name,
              count: 2,
              retained: 'manifest-policy',
              threshold: 0.7,
              reference: 'manifest-gold',
            },
          ],
        }
      );
      const result = await runEvalSuite({
        manifestPath: f.manifestPath,
        rootDir: f.dir,
      });
      expect(result.summary.results.map((entry) => entry.pass)).toEqual([
        true,
        false,
      ]);
      expect(evaluate).toHaveBeenCalledTimes(2);
      expect(evaluate).toHaveBeenNthCalledWith(
        1,
        expect.anything(),
        'manifest-gold',
        expect.objectContaining({ count: 6, retained: 'manifest-policy' })
      );
      expect(evaluate).toHaveBeenNthCalledWith(
        2,
        expect.anything(),
        'case-gold',
        expect.objectContaining({ count: 12, retained: 'manifest-policy' })
      );
    }
  );

  it('applies manifest judges to canonical cases and respects arm judge overrides', async () => {
    const name = `manifest-judge-${sequence++}`;
    const evaluate = vi.fn(async () => ({ score: 0 }));
    registerJudge({ name, schema: z.object({}).passthrough(), evaluate });
    const f = await fixture([scenario], {
      judges: [{ type: name, reference: 'expected' }],
      arms: [{ name: 'judged' }, { name: 'unjudged', judges: [] }],
    });
    const result = await runEvalSuite({
      manifestPath: f.manifestPath,
      rootDir: f.dir,
    });
    expect(evaluate).toHaveBeenCalledTimes(1);
    expect(result.summary.arms.map((arm) => arm.result?.passed)).toEqual([
      0, 1,
    ]);
  });
  it('merges host patches, forwards parsed defaults and computes each arm independently', async () => {
    const f = await fixture([
      { ...scenario, expect: { containsText: 'EXPECTED' } },
    ]);
    f.manifest.host = {
      type: f.type,
      model: 'base',
      retained: 'yes',
    } as typeof f.manifest.host;
    await fs.writeFile(
      f.manifestPath,
      JSON.stringify({
        ...f.manifest,
        metrics: ['passed'],
        arms: [
          { name: 'a' },
          { name: 'b', host: { type: f.type, model: 'variant' } },
        ],
      })
    );
    f.run.mockImplementation(async (options) => ({
      response: {
        success: true,
        response: options.host.model === 'base' ? 'EXPECTED' : 'WRONG',
        toolCalls: [],
      },
    }));
    const result = await runEvalSuite({
      manifestPath: f.manifestPath,
      rootDir: f.dir,
    });
    expect(f.run.mock.calls.map(([options]) => options.host.model)).toEqual([
      'base',
      'variant',
    ]);
    expect(f.run.mock.calls[1]?.[0].host.retained).toBe('yes');
    expect(result.summary.arms.map((arm) => arm.result?.passed)).toEqual([
      1, 0,
    ]);
    expect(result.summary.arms.map((arm) => arm.metrics?.passed_rate)).toEqual([
      1, 0,
    ]);
  });
  it('maps multiple native tools to a canonical expectation without dropping argument checks', async () => {
    const f = await fixture(
      [
        {
          ...scenario,
          expect: {
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
      (await runEvalSuite({ manifestPath: f.manifestPath, rootDir: f.dir }))
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
      (await runEvalSuite({ manifestPath: f.manifestPath, rootDir: f.dir }))
        .summary.results[0]?.pass
    ).toBe(true);
  });
  it('passes complete labeled server sets but only persists allowlisted unresolved descriptions', async () => {
    vi.stubEnv('REVIEW_TOKEN', 'dummy-secret-do-not-save');
    const f = await fixture([scenario], {
      servers: [
        {
          transport: 'http',
          label: 'one',
          serverUrl: 'https://example.com/eval',
          headers: { 'X-Secret': 'header-secret' },
          auth: { accessTokenEnv: 'REVIEW_TOKEN' },
        },
        {
          transport: 'stdio',
          label: 'two',
          command: 'test',
          args: ['arg-secret'],
          env: { KEY: 'env-secret' },
        },
      ],
    });
    const result = await runEvalSuite({
      manifestPath: f.manifestPath,
      rootDir: f.dir,
    });
    expect(f.run.mock.calls[0]?.[0].servers).toHaveLength(2);
    const json = await fs.readFile(
      path.join(result.outputDir, 'results.json'),
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
  it.each([true, false])(
    'redacts every persisted response by default with explicit opt-out (%s)',
    async (redact) => {
      const f = await fixture([{ ...scenario, iterations: 2 }]);
      f.run.mockResolvedValue({
        response: {
          success: true,
          response: 'PRIVATE_RESPONSE_MARKER',
          toolCalls: [],
        },
      });
      const storeDir = path.join(f.dir, 'store');
      await fs.writeFile(
        f.manifestPath,
        JSON.stringify({
          ...f.manifest,
          results: { store: { type: 'file', dir: storeDir } },
          ...(redact ? {} : { redactStoredResponses: false }),
        })
      );
      const result = await runEvalSuite({
        manifestPath: f.manifestPath,
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

  it('keeps unique per-arm canonical artifacts consumable by comparison and stores separate summaries', async () => {
    const f = await fixture([scenario]);
    const storeDir = path.join(f.dir, 'store');
    await fs.writeFile(
      f.manifestPath,
      JSON.stringify({
        ...f.manifest,
        results: { store: { type: 'file', dir: storeDir } },
      })
    );
    await runEvalSuite({ manifestPath: f.manifestPath, rootDir: f.dir });
    await runEvalSuite({ manifestPath: f.manifestPath, rootDir: f.dir });
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
