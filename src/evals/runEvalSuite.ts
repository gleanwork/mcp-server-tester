import fs from 'node:fs/promises';
import path from 'node:path';
import {
  createMCPClientForConfig,
  closeMCPClient,
} from '../mcp/clientFactory.js';
import { createMCPFixture } from '../mcp/fixtures/mcpFixture.js';
import type { MCPConfig } from '../config/mcpConfig.js';
import {
  loadEvalManifest,
  type DatasetConfig,
  type EvalArm,
  type EvalManifest,
} from './evalManifest.js';
import type {
  EvaluationArmResult,
  EvaluationSummary,
} from './evalFrameworkTypes.js';
import { buildEvalDataset } from './buildEvalDataset.js';
import { getBuiltinHostConfig } from './builtinHosts.js';
import { runEvalDataset } from './evalRunner.js';
import type { EvalRunnerResult } from './evalRunner.js';
import type { EvalCaseResult } from '../types/reporter.js';
import type { UsageMetrics } from '../types/index.js';
import { loadPlugins } from '../plugins/loadPlugins.js';

export interface RunEvalSuiteOptions {
  manifestPath: string;
  rootDir?: string;
  pluginPaths?: string[];
  outputDir?: string;
  mcpConfig?: MCPConfig;
  dryRun?: boolean;
  arm?: string;
}

export interface RunEvalSuiteResult {
  manifest: EvalManifest;
  outputDir: string;
  datasets: Array<{
    source: DatasetConfig;
    dataset?: ReturnType<typeof buildEvalDataset>;
    result?: EvalRunnerResult;
  }>;
  summary: EvaluationSummary;
}

function applyManifestEnv(manifest: EvalManifest): void {
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
  process.env.CLAUDE_CODE_DISABLE_AUTO_MEMORY = '1';
  process.env.CLAUDE_CODE_DISABLE_CLAUDE_MDS = '1';
  if (manifest.model) process.env.EVAL_MODEL = manifest.model;
  if (manifest.timeout)
    process.env.EVAL_HOST_TIMEOUT = String(manifest.timeout);
  if (manifest.iterations) {
    process.env.EVAL_ITERATIONS = String(manifest.iterations);
  }
  if (manifest.maxToolCalls) {
    process.env.EVAL_MAX_TOOL_CALLS = String(manifest.maxToolCalls);
  }
  if (manifest.provider) process.env.EVAL_PROVIDER = manifest.provider;
}

async function expandDatasetPath(datasetPath: string): Promise<string[]> {
  const stat = await fs.stat(datasetPath);
  if (!stat.isDirectory()) return [datasetPath];
  return (await fs.readdir(datasetPath))
    .filter((name) => name.endsWith('.json'))
    .sort()
    .map((name) => path.join(datasetPath, name));
}

function selectedArms(manifest: EvalManifest, name?: string): EvalArm[] {
  const arms = manifest.arms?.length
    ? manifest.arms
    : [{ name: 'default' } satisfies EvalArm];
  if (!name) return arms;
  const arm = arms.find((candidate) => candidate.name === name);
  if (!arm) throw new Error(`Evaluation arm "${name}" was not found.`);
  return [arm];
}

function resolveServer(
  manifest: EvalManifest,
  arm: EvalArm,
  override?: MCPConfig
): MCPConfig {
  if (override) return override;
  const servers = arm.servers ?? manifest.servers ?? [];
  if (servers.length !== 1) {
    throw new Error(
      `The current runner requires exactly one MCPConfig per arm; arm "${arm.name}" has ${servers.length}.`
    );
  }
  return servers[0]!;
}

function sumUsage(
  a: Partial<UsageMetrics> | undefined,
  b: Partial<UsageMetrics>
): Partial<UsageMetrics> {
  const keys = [
    'inputTokens',
    'outputTokens',
    'totalCostUsd',
    'durationMs',
    'cacheReadInputTokens',
    'cacheCreationInputTokens',
  ] as const;
  const result: Partial<UsageMetrics> = { ...(a ?? {}) };
  for (const key of keys) {
    const va = a?.[key];
    const vb = b[key];
    if (va !== undefined || vb !== undefined) {
      result[key] = (va ?? 0) + (vb ?? 0);
    }
  }
  return result;
}

function summarizeArm(
  arm: EvalArm,
  server: MCPConfig,
  results: Array<{ name: string; result: EvalRunnerResult }>
): EvaluationArmResult {
  const caseResults: EvalCaseResult[] = [];
  let totalHostUsage: Partial<UsageMetrics> | undefined;
  for (const { result } of results) {
    caseResults.push(...result.caseResults);
    if (result.totalHostUsage) {
      totalHostUsage = sumUsage(totalHostUsage, result.totalHostUsage);
    }
  }
  return {
    name: arm.name,
    servers: [server],
    result: {
      caseResults,
      total: caseResults.length,
      passed: caseResults.filter((result) => result.pass).length,
      failed: caseResults.filter((result) => !result.pass).length,
      durationMs: results.reduce(
        (sum, item) => sum + item.result.durationMs,
        0
      ),
      totalHostUsage,
    },
  };
}

export async function runEvalSuite(
  options: RunEvalSuiteOptions
): Promise<RunEvalSuiteResult> {
  const rootDir = options.rootDir ?? process.cwd();
  const manifest = loadEvalManifest(options.manifestPath, { rootDir });
  applyManifestEnv(manifest);

  const pluginPaths = options.pluginPaths ?? manifest.plugins ?? [];
  if (pluginPaths.length > 0) {
    await loadPlugins(
      pluginPaths.map((pluginPath) =>
        path.isAbsolute(pluginPath)
          ? pluginPath
          : path.resolve(rootDir, pluginPath)
      )
    );
  }

  const outputDir =
    options.outputDir ?? path.join(rootDir, '.mcp-test-results', manifest.name);
  const arms = selectedArms(manifest, options.arm);
  const datasets = manifest.datasets.flatMap((source) => {
    if (source.type !== 'file' && source.type !== 'dir') return [source];
    return [source];
  });

  if (options.dryRun) {
    return {
      manifest,
      outputDir,
      datasets: datasets.map((source) => ({ source })),
      summary: {
        timestamp: new Date().toISOString(),
        durationMs: 0,
        manifestName: manifest.name,
        arms: [],
        metrics: {},
        results: [],
      },
    };
  }

  const armResults: EvaluationArmResult[] = [];
  const allDatasets: RunEvalSuiteResult['datasets'] = [];
  const allResults: EvalCaseResult[] = [];

  for (const arm of arms) {
    const server = resolveServer(manifest, arm, options.mcpConfig);
    const client = await createMCPClientForConfig(server);
    const mcp = createMCPFixture(client, undefined, { authType: 'api-token' });
    const hostType = arm.host?.type ?? manifest.host?.type ?? 'claude-cli';
    const hostConfig = getBuiltinHostConfig(hostType, {
      model: manifest.model,
      maxToolCalls: manifest.maxToolCalls,
      timeout: manifest.timeout,
      provider: manifest.provider,
      server,
    });
    const armDatasetResults: Array<{
      name: string;
      result: EvalRunnerResult;
    }> = [];

    try {
      for (const source of datasets) {
        if (source.type !== 'file' && source.type !== 'dir') {
          throw new Error(
            `Dataset source "${source.type}" is not registered in the built-in runner.`
          );
        }
        const datasetPath = source.path;
        if (typeof datasetPath !== 'string') {
          throw new Error(`Dataset source "${source.type}" requires a path.`);
        }
        for (const filePath of await expandDatasetPath(
          path.isAbsolute(datasetPath)
            ? datasetPath
            : path.resolve(rootDir, datasetPath)
        )) {
          const raw = JSON.parse(
            await fs.readFile(filePath, 'utf8')
          ) as unknown;
          const dataset = buildEvalDataset(raw, hostConfig, manifest);
          const result = await runEvalDataset(
            {
              dataset,
              concurrency: manifest.concurrency ?? 1,
              defaultLlmIterations: manifest.iterations || undefined,
            },
            { mcp }
          );
          allDatasets.push({ source, dataset, result });
          armDatasetResults.push({ name: dataset.name, result });
          allResults.push(...result.caseResults);
        }
      }
    } finally {
      await closeMCPClient(client);
    }

    armResults.push(summarizeArm(arm, server, armDatasetResults));
  }

  const durationMs = armResults.reduce(
    (sum, arm) => sum + (arm.result?.durationMs ?? 0),
    0
  );
  const summary: EvaluationSummary = {
    timestamp: new Date().toISOString(),
    durationMs,
    manifestName: manifest.name,
    arms: armResults,
    metrics: {
      total: allResults.length,
      passed: allResults.filter((result) => result.pass).length,
      failed: allResults.filter((result) => !result.pass).length,
      passRate:
        allResults.length > 0
          ? allResults.filter((result) => result.pass).length /
            allResults.length
          : 0,
    },
    results: allResults,
  };

  await fs.mkdir(outputDir, { recursive: true });
  await fs.writeFile(
    path.join(outputDir, 'results.json'),
    `${JSON.stringify(summary, null, 2)}\n`
  );
  return { manifest, outputDir, datasets: allDatasets, summary };
}
