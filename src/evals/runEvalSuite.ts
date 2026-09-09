import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  createMCPClientForConfig,
  closeMCPClient,
} from '../mcp/clientFactory.js';
import { createMCPFixture } from '../mcp/fixtures/mcpFixture.js';
import type { MCPConfig } from '../config/mcpConfig.js';
import { isHttpConfig } from '../config/mcpConfig.js';
import {
  loadEvalManifest,
  type DatasetConfig,
  type EvalArm,
  type EvalManifest,
  type HostConfig,
} from './evalManifest.js';
import type {
  EvaluationArmResult,
  EvaluationSummary,
  HostDefinition,
  RunTelemetry,
} from './evalFrameworkTypes.js';
import { registerBuiltinDatasetSources } from './builtinDatasetSources.js';
import { registerBuiltinHosts } from './builtinHosts.js';
import { runEvalDataset } from './evalRunner.js';
import type { EvalRunnerResult } from './evalRunner.js';
import type { EvalDataset } from './datasetTypes.js';
import type { EvalCaseResult } from '../types/reporter.js';
import type { UsageMetrics } from '../types/index.js';
import { loadPlugins } from '../plugins/loadPlugins.js';
import {
  getDatasetSource,
  getHost,
  validateManifestRegistrations,
} from './frameworkRegistries.js';
import { computeMetrics, type MetricSpec } from './metrics.js';

export interface RunEvalSuiteOptions {
  manifestPath: string;
  rootDir?: string;
  pluginPaths?: string[];
  outputDir?: string;
  secretsFile?: string;
  mcpConfig?: MCPConfig;
  dryRun?: boolean;
  arm?: string;
}

export interface RunEvalSuiteResult {
  manifest: EvalManifest;
  outputDir: string;
  datasets: Array<{
    source: DatasetConfig;
    dataset?: EvalDataset;
    result?: EvalRunnerResult;
  }>;
  summary: EvaluationSummary;
}

async function loadSecretsFile(secretsFile: string): Promise<void> {
  const raw = await fs.readFile(secretsFile, 'utf8');
  let entries: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('Secrets JSON must contain an object.');
    }
    entries = parsed as Record<string, unknown>;
  } catch {
    entries = {};
    for (const rawLine of raw.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line || line.startsWith('#')) continue;
      const equals = line.indexOf('=');
      if (equals < 1) continue;
      const key = line.slice(0, equals).trim();
      const value = line
        .slice(equals + 1)
        .trim()
        .replace(/^['"]|['"]$/g, '');
      entries[key] = value;
    }
  }
  for (const [key, value] of Object.entries(entries)) {
    if (typeof value === 'string' && process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}

function resolveServerSecrets(server: MCPConfig): MCPConfig {
  if (!isHttpConfig(server) || !server.auth?.accessTokenEnv) return server;
  const envName = server.auth.accessTokenEnv;
  const token = process.env[envName];
  if (!token) {
    throw new Error(
      `MCP access token environment variable "${envName}" is not set.`
    );
  }
  const { accessTokenEnv: _accessTokenEnv, ...auth } = server.auth;
  return { ...server, auth: { ...auth, accessToken: token } };
}

function assertEvalEndpoint(server: MCPConfig, manifest: EvalManifest): void {
  if (!manifest.requireEvalEndpoint || !isHttpConfig(server)) return;
  const pathname = new URL(server.serverUrl).pathname;
  if (!/\/eval(?:\/|$)/.test(pathname)) {
    throw new Error(
      `Evaluation requires an /eval MCP endpoint; received "${server.serverUrl}".`
    );
  }
}

function manifestIdentity(manifest: EvalManifest): {
  manifestId: string;
  contentHash: string;
} {
  return {
    manifestId: manifest.name,
    contentHash: createHash('sha256')
      .update(JSON.stringify(manifest))
      .digest('hex'),
  };
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

function resolveHost(
  manifest: EvalManifest,
  arm: EvalArm,
  server: MCPConfig
): {
  definition: HostDefinition;
  declaration: HostConfig;
  config: ReturnType<HostDefinition['createConfig']>;
} {
  const declaration = arm.host ?? manifest.host ?? { type: 'claude-cli' };
  const definition = getHost(declaration.type);
  const config = definition.createConfig({
    ...declaration,
    model: manifest.model,
    maxToolCalls: manifest.maxToolCalls,
    timeout: manifest.timeout,
    provider: manifest.provider,
    server,
  });
  return { definition, declaration, config };
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

function countToolCalls(results: EvalCaseResult[]): number {
  return results.reduce((count, result) => {
    const response = result.response;
    if (!response || typeof response !== 'object') return count;
    const calls = (response as { toolCalls?: unknown }).toolCalls;
    return count + (Array.isArray(calls) ? calls.length : 0);
  }, 0);
}

function buildArmDeltas(
  arms: EvaluationArmResult[]
): Record<string, Record<string, unknown>> {
  const baseline = arms[0]?.result;
  if (!baseline || baseline.total === 0) return {};
  const baselineRate = baseline.passed / baseline.total;
  return Object.fromEntries(
    arms.slice(1).map((arm) => {
      const result = arm.result;
      const passRate =
        result && result.total > 0 ? result.passed / result.total : 0;
      return [
        arm.name,
        {
          passRate,
          passRateDelta: passRate - baselineRate,
          baseline: arms[0]?.name,
        },
      ];
    })
  );
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
  if (options.secretsFile) {
    await loadSecretsFile(
      path.isAbsolute(options.secretsFile)
        ? options.secretsFile
        : path.resolve(rootDir, options.secretsFile)
    );
  }
  applyManifestEnv(manifest);

  registerBuiltinDatasetSources();
  registerBuiltinHosts();
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

  validateManifestRegistrations(manifest);
  const outputDir =
    options.outputDir ?? path.join(rootDir, '.mcp-test-results', manifest.name);
  const arms = selectedArms(manifest, options.arm);
  const identity = manifestIdentity(manifest);
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
        schemaVersion: 1,
        ...identity,
        timestamp: new Date().toISOString(),
        durationMs: 0,
        manifestName: manifest.name,
        arms: [],
        metrics: {},
        armDeltas: {},
        results: [],
      },
    };
  }

  const armResults: EvaluationArmResult[] = [];
  const allDatasets: RunEvalSuiteResult['datasets'] = [];
  const allResults: EvalCaseResult[] = [];

  for (const arm of arms) {
    const server = resolveServer(manifest, arm, options.mcpConfig);
    const resolvedServer = resolveServerSecrets(server);
    assertEvalEndpoint(resolvedServer, manifest);
    const host = resolveHost(manifest, arm, resolvedServer);
    const sourceResults: Array<{
      name: string;
      result: EvalRunnerResult;
    }> = [];
    const client = host.definition.run
      ? undefined
      : await createMCPClientForConfig(resolvedServer);
    const mcp = client
      ? createMCPFixture(client, undefined, { authType: 'api-token' })
      : undefined;

    try {
      for (const source of datasets) {
        const datasetPaths =
          source.type === 'file' || source.type === 'dir'
            ? await expandDatasetPath(
                path.isAbsolute(String(source.path))
                  ? String(source.path)
                  : path.resolve(rootDir, String(source.path))
              )
            : [undefined];
        for (const filePath of datasetPaths) {
          const sourceConfig = filePath
            ? { ...source, type: 'file', path: filePath }
            : source;
          const datasetSource = getDatasetSource(sourceConfig.type);
          const dataset = await datasetSource.load(sourceConfig, {
            rootDir,
            manifest,
            hostConfig: host.config,
          });
          const result = host.definition.run
            ? await host.definition.run({
                dataset,
                cases: dataset.cases,
                servers: [resolvedServer],
                host: host.declaration,
                manifest,
                arm,
              })
            : await runEvalDataset(
                {
                  dataset,
                  concurrency: manifest.concurrency ?? 1,
                  defaultLlmIterations: manifest.iterations || undefined,
                },
                { mcp: mcp! }
              );
          allDatasets.push({ source: sourceConfig, dataset, result });
          sourceResults.push({ name: dataset.name, result });
          allResults.push(...result.caseResults);
        }
      }
    } finally {
      if (client) await closeMCPClient(client);
    }

    armResults.push(summarizeArm(arm, resolvedServer, sourceResults));
  }

  const durationMs = armResults.reduce(
    (sum, arm) => sum + (arm.result?.durationMs ?? 0),
    0
  );
  const metricSpecs = [
    ...(manifest.metrics ?? []),
    ...arms.flatMap((arm) => arm.metrics ?? []),
  ] as MetricSpec[];
  const computedMetrics = metricSpecs.length
    ? computeMetrics(metricSpecs, allResults).aggregated
    : {};
  let totalHostUsage: Partial<UsageMetrics> | undefined;
  for (const arm of armResults) {
    totalHostUsage = sumUsage(totalHostUsage, arm.result?.totalHostUsage ?? {});
  }
  const telemetry: RunTelemetry = {
    cases: allResults.length,
    toolCalls: countToolCalls(allResults),
    failedCases: allResults.filter((result) => !result.pass).length,
    totalHostUsage,
  };
  const summary: EvaluationSummary = {
    schemaVersion: 1,
    ...identity,
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
      ...computedMetrics,
    },
    telemetry,
    armDeltas: buildArmDeltas(armResults),
    results: allResults,
  };

  await fs.mkdir(outputDir, { recursive: true });
  await fs.writeFile(
    path.join(outputDir, 'results.json'),
    `${JSON.stringify(summary, null, 2)}\n`
  );
  return { manifest, outputDir, datasets: allDatasets, summary };
}
