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
import { buildNativeMcpServers } from './nativeMcpServers.js';
import { runEvalDataset } from './evalRunner.js';
import type { EvalRunnerResult } from './evalRunner.js';
import type { EvalCaseResult } from '../types/reporter.js';
import type { UsageMetrics } from '../types/index.js';
import type { EvalDataset } from './datasetTypes.js';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type { MCPFixtureApi } from '../mcp/fixtures/mcpFixture.js';
import {
  runServerComparison,
  type ServerComparisonResult,
} from './serverComparison.js';
import { loadPlugins } from '../plugins/loadPlugins.js';
import { computeMetrics } from './metrics.js';

export interface RunEvalSuiteOptions {
  configPath: string;
  rootDir?: string;
  pluginPaths?: string[];
  outputDir?: string;
  mcpConfig?: MCPConfig;
  dryRun?: boolean;
  /** Optional command-line overrides applied after loading the JSON config. */
  configOverrides?: Partial<EvalConfig>;
}

export interface RunEvalSuiteResult {
  config: EvalConfig;
  outputDir: string;
  datasets: Array<{ path: string; name: string; result?: EvalRunnerResult }>;
  comparison?: ServerComparisonResult[];
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
  aggregatedMetrics?: Record<string, unknown>;
  results: EvalCaseResult[];
}

function applyConfigEnv(config: EvalConfig): void {
  // Match scio run-eval.ts — required for scio-prod in corp TLS environments.
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
  process.env.CLAUDE_CODE_DISABLE_AUTO_MEMORY = '1';
  process.env.CLAUDE_CODE_DISABLE_CLAUDE_MDS = '1';
  if (config.mcpUrl) {
    process.env.GLEAN_MCP_URL = config.mcpUrl;
  } else if (
    (Array.isArray(config.nativeConnectors) &&
      config.nativeConnectors.length > 0) ||
    (config.nativeConnectors !== undefined &&
      !Array.isArray(config.nativeConnectors) &&
      Object.keys(config.nativeConnectors).length > 0)
  ) {
    // An explicit native-only selection must not inherit a Glean URL from the
    // shell environment or the default production endpoint.
    process.env.GLEAN_MCP_URL = '';
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

function resolveMcpConfig(config: EvalConfig, override?: MCPConfig): MCPConfig {
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
      'GLEAN_API_TOKEN is required to run evals against the MCP server'
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
  datasetResults: Array<{ name: string; result: EvalRunnerResult }>
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

function createUnusedMcpFixture(): MCPFixtureApi {
  const unavailable = async (): Promise<never> => {
    throw new Error(
      'This eval uses a CLI/browser host and has no primary MCP server'
    );
  };
  return {
    client: undefined as unknown as Client,
    authType: 'none',
    listTools: unavailable,
    callTool: unavailable,
    getServerInfo: () => null,
  };
}

function withHostConfig(
  dataset: EvalDataset,
  hostConfig: ReturnType<typeof getBuiltinHostConfig>
): EvalDataset {
  return {
    ...dataset,
    cases: dataset.cases.map((evalCase) =>
      evalCase.mode === 'mcp_host'
        ? { ...evalCase, mcpHostConfig: hostConfig }
        : evalCase
    ),
  };
}

function filterDatasetByTools(
  dataset: EvalDataset,
  tools: string | undefined
): EvalDataset {
  if (!tools?.trim()) return dataset;
  const selected = new Set(
    tools
      .split(',')
      .map((tool) => tool.trim())
      .filter(Boolean)
  );
  const cases = dataset.cases.filter(
    (evalCase) =>
      evalCase.toolName !== undefined && selected.has(evalCase.toolName)
  );
  return { ...dataset, cases };
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

export async function runEvalSuite(
  options: RunEvalSuiteOptions
): Promise<RunEvalSuiteResult> {
  const rootDir = options.rootDir ?? process.cwd();
  const loadedConfig = loadEvalConfig(options.configPath, {
    rootDir,
    // Allow config validation without local evalset fixtures on disk.
    skipEvalsetValidation: options.dryRun,
  });
  const config: EvalConfig = {
    ...loadedConfig,
    ...options.configOverrides,
  };
  applyConfigEnv(config);

  const pluginPaths =
    options.pluginPaths ??
    config.plugins?.map((plugin) =>
      path.isAbsolute(plugin.dir)
        ? plugin.dir
        : path.resolve(rootDir, plugin.dir)
    ) ??
    [];

  if (pluginPaths.length > 0) {
    await loadPlugins(pluginPaths);
  }

  const modeConfig = resolveEvalModeConfig(config.mode);
  const resolvedEvalsetPaths = resolveEvalsetPaths(config, rootDir);
  const evalsetPaths = options.dryRun
    ? resolvedEvalsetPaths
    : await expandEvalsetPaths(resolvedEvalsetPaths);

  const nativeMcpServers = options.dryRun
    ? {}
    : await buildNativeMcpServers(
        config.nativeServers ?? [],
        config.nativeConnectors,
        { preflight: true }
      );
  const hostConfig = getBuiltinHostConfig(config.clientHost ?? 'claude-cli', {
    model: config.model,
    maxToolCalls: config.maxToolCalls,
    timeout: config.timeout,
    provider: config.provider,
    mcpUrl: config.mcpUrl,
    pluginDir: process.env.PLUGIN_DIR,
    pluginMcpUrl: process.env.GLEAN_PLUGIN_MCP_URL,
    mcpServers: nativeMcpServers,
  });

  const runTimestamp = new Date()
    .toISOString()
    .replace(/[:.]/g, '-')
    .slice(0, 19);
  const outputDir =
    options.outputDir ??
    path.join(rootDir, '.mcp-test-results', `${config.name}-${runTimestamp}`);

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

  const hasNativeSelection = Array.isArray(config.nativeConnectors)
    ? config.nativeConnectors.length > 0
    : config.nativeConnectors !== undefined &&
      Object.keys(config.nativeConnectors).length > 0;
  const nativeOnly = hasNativeSelection && !config.mcpUrl;
  const mcpConfig = nativeOnly
    ? undefined
    : resolveMcpConfig(config, options.mcpConfig);
  const client = mcpConfig
    ? await createMCPClientForConfig(mcpConfig)
    : undefined;
  const mcp = client
    ? createMCPFixture(client, undefined, { authType: 'api-token' })
    : createUnusedMcpFixture();

  const datasetResults: Array<{
    path: string;
    name: string;
    result: EvalRunnerResult;
  }> = [];
  const comparisons: Array<{ name: string; result: ServerComparisonResult }> =
    [];
  let clientB: Awaited<ReturnType<typeof createMCPClientForConfig>> | undefined;
  let hostConfigB: ReturnType<typeof getBuiltinHostConfig> | undefined;

  try {
    if (modeConfig.isServerComparison) {
      if (!config.serverB) {
        throw new Error('serverB is required when mode is sxs');
      }
      clientB = await createMCPClientForConfig({
        transport: 'http',
        serverUrl: config.serverB,
        auth: {
          accessToken:
            config.serverBToken ??
            process.env.SXS_SERVER_B_TOKEN ??
            process.env.GLEAN_API_TOKEN,
        },
      });
      hostConfigB = getBuiltinHostConfig(config.clientHost ?? 'claude-cli', {
        model: config.model,
        maxToolCalls: config.maxToolCalls,
        timeout: config.timeout,
        provider: config.provider,
        mcpUrl: config.serverB,
        pluginDir: process.env.PLUGIN_DIR,
        pluginMcpUrl: process.env.GLEAN_PLUGIN_MCP_URL,
      });
    }

    for (const evalsetPath of evalsetPaths) {
      const raw = JSON.parse(await fs.readFile(evalsetPath, 'utf8')) as unknown;
      const dataset = filterDatasetByTools(
        buildEvalDataset(raw, config.mode, hostConfig, config),
        config.tools
      );
      if (dataset.cases.length === 0) {
        throw new Error(
          `No eval cases remain for ${evalsetPath}${config.tools ? ` after filtering tools: ${config.tools}` : ''}`
        );
      }

      if (clientB) {
        const comparison = await runServerComparison(
          {
            dataset,
            datasetB: hostConfigB
              ? withHostConfig(dataset, hostConfigB)
              : undefined,
            filterTags:
              modeConfig.filterTags.length > 0
                ? modeConfig.filterTags
                : undefined,
            concurrency: config.concurrency ?? 1,
            defaultLlmIterations: config.iterations || undefined,
            mcpHostModel: config.model,
            judgeModel: process.env.JUDGE_MODEL,
          },
          { mcp },
          {
            mcp: createMCPFixture(clientB, undefined, {
              authType: 'api-token',
            }),
          }
        );
        comparisons.push({ name: dataset.name, result: comparison });
        datasetResults.push({
          path: evalsetPath,
          name: dataset.name,
          result: comparison.serverAResult,
        });
      } else {
        const result = await runEvalDataset(
          {
            dataset,
            filterTags:
              modeConfig.filterTags.length > 0
                ? modeConfig.filterTags
                : undefined,
            concurrency: config.concurrency ?? 1,
            defaultLlmIterations: config.iterations || undefined,
            mcpHostModel: config.model,
            judgeModel: process.env.JUDGE_MODEL,
          },
          { mcp }
        );
        datasetResults.push({ path: evalsetPath, name: dataset.name, result });
      }
    }
  } finally {
    if (clientB) await closeMCPClient(clientB);
    if (client) await closeMCPClient(client);
  }

  const merged = mergeResults(
    config,
    datasetResults.map(({ name, result }) => ({ name, result }))
  );
  if (comparisons.length > 0) {
    merged.aggregatedMetrics = {
      ...merged.metrics,
      aWins: comparisons.reduce((sum, item) => sum + item.result.aWins, 0),
      bWins: comparisons.reduce((sum, item) => sum + item.result.bWins, 0),
      ties: comparisons.reduce((sum, item) => sum + item.result.ties, 0),
      bothFail: comparisons.reduce(
        (sum, item) => sum + item.result.bothFail,
        0
      ),
    };
  }

  if (config.metrics?.length) {
    const { perCase, aggregated } = computeMetrics(
      config.metrics,
      merged.results
    );
    for (const c of merged.results) {
      (c as unknown as Record<string, unknown>).metrics = perCase[c.id] ?? {};
    }
    merged.aggregatedMetrics = {
      ...(merged.aggregatedMetrics ?? merged.metrics),
      ...aggregated,
    };
  }

  await fs.mkdir(outputDir, { recursive: true });
  await fs.writeFile(
    path.join(outputDir, 'results.json'),
    `${JSON.stringify(merged, null, 2)}\n`
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
        2
      )}\n`
    );
  }

  for (const comparison of comparisons) {
    await fs.writeFile(
      path.join(outputDir, `comparison-${comparison.name}.json`),
      `${JSON.stringify(comparison.result, null, 2)}\n`
    );
  }

  return {
    config,
    outputDir,
    datasets: datasetResults,
    comparison:
      comparisons.length > 0
        ? comparisons.map((comparison) => comparison.result)
        : undefined,
    merged,
  };
}
