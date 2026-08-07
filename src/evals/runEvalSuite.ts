import fs from 'node:fs/promises';
import path from 'node:path';
import {
  createMCPClientForConfig,
  closeMCPClient,
} from '../mcp/clientFactory.js';
import { createMCPFixture } from '../mcp/fixtures/mcpFixture.js';
import type { MCPConfig } from '../config/mcpConfig.js';
import type { EvalConfig } from './evalConfigSchema.js';
import {
  loadEvalConfig,
  resolveEvalModeConfig,
  resolveEvalsetPaths,
} from './evalConfigSchema.js';
import { buildEvalDataset } from './buildEvalDataset.js';
import { getBuiltinHostConfig } from './builtinHosts.js';
import { runEvalDataset } from './evalRunner.js';
import type { EvalRunnerResult } from './evalRunner.js';
import type { EvalCaseResult } from '../types/reporter.js';
import type { UsageMetrics } from '../types/index.js';
import { loadPlugins } from '../plugins/loadPlugins.js';

export interface RunEvalSuiteOptions {
  configPath: string;
  rootDir?: string;
  pluginPaths?: string[];
  outputDir?: string;
  mcpConfig?: MCPConfig;
  dryRun?: boolean;
}

export interface RunEvalSuiteResult {
  config: EvalConfig;
  outputDir: string;
  datasets: Array<{ path: string; name: string; result?: EvalRunnerResult }>;
  merged: ScioCompatibleResults;
}

export interface ScioCompatibleResults {
  timestamp: string;
  durationMs: number;
  configName: string;
  evalMode: string;
  mcpUrl?: string;
  evalsetFilePaths?: string[];
  metrics: {
    total: number;
    passed: number;
    failed: number;
    passRate: number;
    datasetBreakdown: Record<string, number>;
    totalHostUsage?: Partial<UsageMetrics>;
  };
  results: EvalCaseResult[];
}

function applyConfigEnv(config: EvalConfig): void {
  if (config.mcpUrl) {
    process.env.GLEAN_MCP_URL = config.mcpUrl;
  }
  if (config.model) {
    process.env.EVAL_MODEL = config.model;
  }
  if (config.timeout) {
    process.env.EVAL_HOST_TIMEOUT = String(config.timeout);
  }
  if (config.iterations) {
    process.env.EVAL_ITERATIONS = String(config.iterations);
  }
  if (config.maxToolCalls) {
    process.env.EVAL_MAX_TOOL_CALLS = String(config.maxToolCalls);
  }
  if (config.provider) {
    process.env.EVAL_PROVIDER = config.provider;
  }
  if (config.judges?.length) {
    process.env.EVAL_JUDGES = config.judges.join(',');
  }
  if (config.plugins?.[0]) {
    const plugin = config.plugins[0];
    process.env.PLUGIN_DIR = plugin.dir.replace(/^~/, process.env.HOME ?? '');
    if (plugin.mcpUrl) {
      process.env.GLEAN_PLUGIN_MCP_URL = plugin.mcpUrl;
    }
  }
  if (config.env) {
    for (const [key, value] of Object.entries(config.env)) {
      process.env[key] = value;
    }
  }
}

function resolveMcpConfig(
  config: EvalConfig,
  override?: MCPConfig,
): MCPConfig {
  if (override) {
    return override;
  }
  const serverUrl =
    config.mcpUrl ??
    process.env.GLEAN_MCP_URL ??
    'https://scio-prod-be.glean.com/mcp/default';
  const accessToken = process.env.GLEAN_API_TOKEN;
  if (!accessToken) {
    throw new Error(
      'GLEAN_API_TOKEN is required to run evals against the MCP server',
    );
  }
  return {
    transport: 'http',
    serverUrl,
    auth: { accessToken },
  };
}

async function expandEvalsetPaths(paths: string[]): Promise<string[]> {
  const files: string[] = [];
  for (const evalsetPath of paths) {
    const stat = await fs.stat(evalsetPath);
    if (stat.isDirectory()) {
      const dirFiles = (await fs.readdir(evalsetPath))
        .filter((name) => name.endsWith('.json'))
        .sort()
        .map((name) => path.join(evalsetPath, name));
      files.push(...dirFiles);
    } else {
      files.push(evalsetPath);
    }
  }
  return files;
}

function mergeResults(
  config: EvalConfig,
  datasetResults: Array<{ name: string; result: EvalRunnerResult }>,
): ScioCompatibleResults {
  const allResults: EvalCaseResult[] = [];
  const datasetBreakdown: Record<string, number> = {};
  let durationMs = 0;
  let totalHostUsage: Partial<UsageMetrics> | undefined;

  for (const { name, result } of datasetResults) {
    allResults.push(...result.caseResults);
    datasetBreakdown[name] = result.total;
    durationMs += result.durationMs;
    if (result.totalHostUsage) {
      totalHostUsage = sumUsage(totalHostUsage, result.totalHostUsage);
    }
  }

  const passed = allResults.filter((r) => r.pass).length;
  const total = allResults.length;

  return {
    timestamp: new Date().toISOString(),
    durationMs,
    configName: config.name,
    evalMode: config.mode,
    mcpUrl: config.mcpUrl,
    evalsetFilePaths: config.evalsetFilePaths,
    metrics: {
      total,
      passed,
      failed: total - passed,
      passRate: total > 0 ? passed / total : 0,
      datasetBreakdown,
      totalHostUsage,
    },
    results: allResults,
  };
}

function sumUsage(
  a: Partial<UsageMetrics> | undefined,
  b: Partial<UsageMetrics>,
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

export async function runEvalSuite(
  options: RunEvalSuiteOptions,
): Promise<RunEvalSuiteResult> {
  const rootDir = options.rootDir ?? process.cwd();
  const config = loadEvalConfig(options.configPath, { rootDir });
  applyConfigEnv(config);

  const pluginPaths =
    options.pluginPaths ??
    config.plugins?.map((plugin) =>
      path.isAbsolute(plugin.dir)
        ? plugin.dir
        : path.resolve(rootDir, plugin.dir),
    ) ??
    [];

  if (pluginPaths.length > 0) {
    await loadPlugins(pluginPaths);
  }

  const modeConfig = resolveEvalModeConfig(config.mode);
  const evalsetPaths = await expandEvalsetPaths(
    resolveEvalsetPaths(config, rootDir),
  );

  const hostConfig = getBuiltinHostConfig(config.clientHost ?? 'claude-cli', {
    model: config.model,
    maxToolCalls: config.maxToolCalls,
    timeout: config.timeout,
    provider: config.provider,
    mcpUrl: config.mcpUrl,
    pluginDir: process.env.PLUGIN_DIR,
    pluginMcpUrl: process.env.GLEAN_PLUGIN_MCP_URL,
  });

  const outputDir =
    options.outputDir ??
    path.join(rootDir, '.mcp-test-results', config.name);

  if (options.dryRun) {
    return {
      config,
      outputDir,
      datasets: evalsetPaths.map((evalsetPath) => ({
        path: evalsetPath,
        name: path.basename(evalsetPath, '.json'),
      })),
      merged: {
        timestamp: new Date().toISOString(),
        durationMs: 0,
        configName: config.name,
        evalMode: config.mode,
        mcpUrl: config.mcpUrl,
        evalsetFilePaths: config.evalsetFilePaths,
        metrics: {
          total: 0,
          passed: 0,
          failed: 0,
          passRate: 0,
          datasetBreakdown: {},
        },
        results: [],
      },
    };
  }

  if (modeConfig.isServerComparison) {
    throw new Error(
      'sxs mode is not yet supported by runEvalSuite — use runServerComparison directly',
    );
  }

  const mcpConfig = resolveMcpConfig(config, options.mcpConfig);
  const client = await createMCPClientForConfig(mcpConfig);
  const mcp = createMCPFixture(client, undefined, { authType: 'api-token' });

  const datasetResults: Array<{ path: string; name: string; result: EvalRunnerResult }> =
    [];

  try {
    for (const evalsetPath of evalsetPaths) {
      const raw = JSON.parse(await fs.readFile(evalsetPath, 'utf8')) as unknown;
      const dataset = buildEvalDataset(
        raw,
        config.mode,
        hostConfig,
        config,
      );
      const result = await runEvalDataset(
        {
          dataset,
          filterTags:
            modeConfig.filterTags.length > 0
              ? modeConfig.filterTags
              : undefined,
          concurrency: config.concurrency ?? 1,
          defaultLlmIterations: config.iterations || undefined,
        },
        { mcp },
      );
      datasetResults.push({
        path: evalsetPath,
        name: dataset.name,
        result,
      });
    }
  } finally {
    await closeMCPClient(client);
  }

  const merged = mergeResults(
    config,
    datasetResults.map(({ name, result }) => ({ name, result })),
  );

  await fs.mkdir(outputDir, { recursive: true });
  await fs.writeFile(
    path.join(outputDir, 'results.json'),
    `${JSON.stringify(merged, null, 2)}\n`,
  );

  for (const { name, result } of datasetResults) {
    await fs.writeFile(
      path.join(outputDir, `run-${name}.json`),
      `${JSON.stringify(
        {
          timestamp: merged.timestamp,
          durationMs: result.durationMs,
          metrics: {
            total: result.total,
            passed: result.passed,
            failed: result.failed,
            passRate: result.total > 0 ? result.passed / result.total : 0,
            totalHostUsage: result.totalHostUsage,
          },
          results: result.caseResults,
        },
        null,
        2,
      )}\n`,
    );
  }

  return {
    config,
    outputDir,
    datasets: datasetResults,
    merged,
  };
}
