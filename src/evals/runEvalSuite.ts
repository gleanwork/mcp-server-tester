import { manifestIdentity } from './manifestIdentity.js';
import { resolveManifestExtends } from './manifestExtends.js';
import { resolveCoworkSetupConfig } from './coworkSetup/options.js';
import { sumUsage } from '../utils/usageUtils.js';
import { sumJudgeUsage } from '../judge/judgeContract.js';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  createMCPClientForConfig,
  closeMCPClient,
} from '../mcp/clientFactory.js';
import { createMCPFixture } from '../mcp/fixtures/mcpFixture.js';
import type { MCPConfig } from '../config/mcpConfig.js';
import { isHttpConfig, usesHostResolvedFields } from '../config/mcpConfig.js';
import {
  loadEvalManifest,
  type DatasetConfig,
  type EvalArm,
  type EvalManifest,
  type HostConfig,
  type ModelPricing,
} from './evalManifest.js';
import type {
  EvaluationArmResult,
  EvaluationSummary,
  HostDefinition,
  HostEvidence,
  RunTelemetry,
} from './evalFrameworkTypes.js';
import {
  hostEnvironment,
  type HostEnvironment,
} from './mcpHost/hostOptions.js';
import { runEvalDataset } from './evalRunner.js';
import { passRate } from './evalRunComparison.js';
import { createSuiteCaseExecutor } from './caseExecution.js';
import { mergeSuiteJudges } from './expectations.js';
import { prepareHostBatch } from './prepareHostBatch.js';
import type { EvalRunnerResult } from './evalRunner.js';
import { EvalAssertionsSchema, type EvalDataset } from './datasetTypes.js';
import { selectEvalCases } from './buildEvalDataset.js';
import type { EvalCaseResult } from '../types/reporter.js';
import type { MCPProtocolInfo, UsageMetrics } from '../types/index.js';
import { getProtocolInfo } from '../mcp/protocol.js';
import type { Plugin } from '../plugins/plugin.js';
import { assertDatasetNamespaces, loadSuitePlugins } from './suitePlugins.js';
import { getDatasetSource } from './builtinDatasetSources.js';
import { assertHostSupports, getHost } from './builtinHosts.js';
import {
  startToolSurfaceProxy,
  type ToolSurfaceProxy,
} from './toolSurfaceProxy.js';
import { getResultStore, resolveStorePaths } from './builtinResultStores.js';
import { compareWithPrevious, findPreviousRun } from './runBaseline.js';
import { costSource, estimateCosts } from './pricing.js';
import {
  parseHostConfig,
  validateManifest,
  inheritHost,
  takesOption,
} from './manifestValidation.js';
import {
  computeMetrics,
  type MetricSpec,
  countTrialToolCalls,
  resolveMetric,
} from './metrics.js';
import {
  createStoredEvalArtifact,
  REDACT_STORED_RESPONSES_BY_DEFAULT,
  redactStoredResponses,
} from './resultStore.js';
import packageJson from '../../package.json' with { type: 'json' };

export interface RunEvalSuiteOptions {
  manifestPath: string;
  rootDir?: string;
  /** Plugin specifiers from the CLI, added to the manifest's `plugins`. */
  pluginPaths?: string[];
  /** Plugin objects, added to the manifest's `plugins`. */
  plugins?: readonly Plugin[];
  outputDir?: string;
  secretsFile?: string;
  mcpConfig?: MCPConfig;
  dryRun?: boolean;
  arm?: string;
  /**
   * Arms to run instead of the manifest's, validated the same way: a list,
   * or a function of the manifest's arms (after shared configs apply). For
   * experiments that generate arms, such as runVariantExperiment's suite mode.
   */
  arms?: EvalArm[] | ((manifestArms: readonly EvalArm[]) => EvalArm[]);
  redactStoredResponses?: boolean;
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

async function loadSecretsFile(
  secretsFile: string
): Promise<Record<string, string>> {
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
  return Object.fromEntries(
    Object.entries(entries).filter(
      (entry): entry is [string, string] => typeof entry[1] === 'string'
    )
  );
}

function resolveServerSecrets(
  server: MCPConfig,
  env: Record<string, string | undefined>
): MCPConfig {
  // A host resolves these; merging process.env here would copy secrets.
  if (usesHostResolvedFields(server)) return server;
  if (server.transport === 'stdio')
    return {
      ...server,
      env: Object.fromEntries(
        Object.entries({ ...env, ...server.env }).filter(
          (entry): entry is [string, string] => typeof entry[1] === 'string'
        )
      ),
    };
  if (!isHttpConfig(server) || !server.auth?.accessTokenEnv) return server;
  const envName = server.auth.accessTokenEnv;
  const token = env[envName];
  if (!token) {
    throw new Error(
      `MCP access token environment variable "${envName}" is not set.`
    );
  }
  const { accessTokenEnv: _accessTokenEnv, ...auth } = server.auth;
  return { ...server, auth: { ...auth, accessToken: token } };
}

function assertEvalEndpoint(server: MCPConfig, manifest: EvalManifest): void {
  if (!manifest.requireEvalEndpoint) return;
  // A host-resolved stdio server declares the endpoint it targets as `url`.
  const endpoint = isHttpConfig(server) ? server.serverUrl : server.url;
  if (endpoint === undefined) return;
  const pathname = new URL(endpoint).pathname;
  if (!/\/eval(?:\/|$)/.test(pathname)) {
    throw new Error(
      `Evaluation requires an /eval MCP endpoint; received "${endpoint}".`
    );
  }
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

function resolveHost(
  manifest: EvalManifest,
  arm: EvalArm,
  servers: MCPConfig[],
  env: HostEnvironment
) {
  const declaration: HostConfig = {
    ...(arm.host ?? manifest.host ?? { type: 'claude-cli' }),
    type: arm.host?.type ?? manifest.host?.type ?? 'claude-cli',
  };
  const definition: HostDefinition = getHost(declaration.type);
  const config = definition.createConfig?.({
    ...declaration,
    servers,
    server: servers[0],
    env: hostEnvironment(
      { env: declaration.env as HostEnvironment | undefined },
      { env }
    ),
  });
  return { definition, declaration, config };
}

/**
 * Every case that names its own host, in every arm: that host can honour the
 * arm's servers, tool variants and concurrency. Checked before anything runs.
 */
function assertCaseHosts(
  manifest: EvalManifest,
  rawManifest: EvalManifest,
  arms: EvalArm[],
  datasets: EvalDataset[]
): void {
  for (const arm of arms) {
    const rawArm = rawManifest.arms?.find(
      (candidate) => candidate.name === arm.name
    );
    const declaration = inheritHost(rawManifest.host, rawArm?.host ?? {});
    for (const dataset of datasets) {
      for (const evalCase of dataset.cases) {
        const caseHost = inheritHost(declaration, evalCase.host ?? {}) as {
          type?: string;
          skills?: unknown;
          systemPrompt?: unknown;
        };
        const hostSkills = caseHost.skills;
        if (evalCase.mcpHostConfig?.systemPrompt !== undefined) {
          // A case prompt would silently replace the arm's, or be ignored by
          // a host that takes none.
          if (caseHost.systemPrompt !== undefined) {
            throw new Error(
              `Case "${evalCase.id}" in arm "${arm.name}" sets mcpHostConfig.systemPrompt, which would override the host's systemPrompt: set it on the host or the case, not both.`
            );
          }
          if (!takesOption(getHost(caseHost.type!).schema, 'systemPrompt')) {
            throw new Error(
              `Case "${evalCase.id}" in arm "${arm.name}" sets mcpHostConfig.systemPrompt, which host "${caseHost.type}" can't apply.`
            );
          }
        }
        if (
          hostSkills !== undefined &&
          evalCase.mcpHostConfig?.skills !== undefined
        ) {
          // The case setting would silently win, so arms meant to compare
          // skills modes would all run the case's mode.
          throw new Error(
            `Case "${evalCase.id}" in arm "${arm.name}" sets mcpHostConfig.skills, which would override the host's skills: set skills on the host or the case, not both.`
          );
        }
        if (!evalCase.host) continue;
        assertHostSupports(
          parseHostConfig(inheritHost(declaration, evalCase.host), rawManifest),
          {
            servers: arm.servers ?? manifest.servers ?? [],
            toolOverrides: arm.toolOverrides ?? manifest.toolOverrides,
            concurrency: manifest.concurrency,
            context: `Case "${evalCase.id}" in arm "${arm.name}"`,
          }
        );
      }
    }
  }
}

/** The arm's share of passing trials, averaged over its cases. */
function trialPassRate(arm: EvaluationArmResult): number | undefined {
  const value = arm.metrics?.trial_pass_rate;
  return typeof value === 'number' ? value : undefined;
}

const EVIDENCE_STRENGTH: HostEvidence[] = ['none', 'observed', 'structured'];

/** The weakest evidence among an arm's cases: what its trace metrics rest on. */
function armEvidence(results: EvalCaseResult[]): HostEvidence | undefined {
  const levels = results
    .map((result) => result.hostEvidence)
    .filter((level): level is HostEvidence => level !== undefined);
  return EVIDENCE_STRENGTH.find((level) => levels.includes(level));
}

/**
 * What every arm reports, whatever the manifest lists: outcomes, calls,
 * tokens, cost and time. A manifest's `metrics` add to these.
 */
const CORE_METRICS = [
  'passed',
  'trial_pass',
  'tool_count',
  'mcp_call_count',
  'host_event_count',
  'tool_search_hit',
  'input_tokens',
  'output_tokens',
  'cost_usd',
  'duration_s',
  'judge_pass',
  'judge_score',
] as const;

function isNumberRecord(value: unknown): value is Record<string, number> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Object.values(value).every((v) => typeof v === 'number')
  );
}

/** Every numeric metric both arms report, as arm minus baseline (per judge for scores). */
function metricDeltas(
  arm: EvaluationArmResult,
  baseline: EvaluationArmResult
): Record<string, number | Record<string, number>> {
  const deltas: Record<string, number | Record<string, number>> = {};
  for (const [key, value] of Object.entries(arm.metrics ?? {})) {
    const before = baseline.metrics?.[key];
    if (typeof value === 'number' && typeof before === 'number') {
      deltas[key] = value - before;
    } else if (isNumberRecord(value) && isNumberRecord(before)) {
      // Per-judge scores: a delta for each judge both arms ran.
      const shared = Object.keys(value).filter((name) => name in before);
      if (shared.length > 0)
        deltas[key] = Object.fromEntries(
          shared.map((name) => [name, value[name]! - before[name]!])
        );
    }
  }
  return deltas;
}

function buildArmDeltas(
  arms: EvaluationArmResult[]
): Record<string, Record<string, unknown>> {
  const baseline = arms[0]?.result;
  if (!baseline || baseline.total === 0) return {};
  const baselineRate = passRate(baseline);
  const baselineTrialRate = trialPassRate(arms[0]!);
  return Object.fromEntries(
    arms.slice(1).map((arm) => {
      const rate = arm.result ? passRate(arm.result) : 0;
      const trials = trialPassRate(arm);
      return [
        arm.name,
        {
          passRate: rate,
          passRateDelta: rate - baselineRate,
          ...(trials !== undefined && baselineTrialRate !== undefined
            ? {
                trialPassRate: trials,
                trialPassRateDelta: trials - baselineTrialRate,
              }
            : {}),
          metricDeltas: metricDeltas(arm, arms[0]!),
          baseline: arms[0]?.name,
        },
      ];
    })
  );
}

function redactServerForReport(server: MCPConfig): MCPConfig {
  const label = server.label ? { label: server.label } : {};
  if (server.transport === 'stdio') {
    // Arguments and environment may both contain credentials.
    return { transport: 'stdio', command: server.command, ...label };
  }
  const url = new URL(server.serverUrl);
  url.username = '';
  url.password = '';
  url.search = '';
  url.hash = '';
  return {
    transport: 'http',
    serverUrl: url.toString(),
    ...label,
    ...(server.auth?.accessTokenEnv
      ? { auth: { accessTokenEnv: server.auth.accessTokenEnv } }
      : {}),
  };
}

function summarizeArm(
  arm: EvalArm,
  servers: MCPConfig[],
  results: Array<{ name: string; result: EvalRunnerResult }>
): EvaluationArmResult {
  const caseResults: EvalCaseResult[] = [];
  let totalHostUsage: UsageMetrics | undefined;
  for (const { result } of results) {
    caseResults.push(...result.caseResults);
    if (result.totalHostUsage) {
      totalHostUsage = sumUsage(totalHostUsage, result.totalHostUsage);
    }
  }
  const totalJudgeUsage = sumJudgeUsage(
    results.map(({ result }) => result.totalJudgeUsage)
  );
  return {
    name: arm.name,
    servers: servers.map(redactServerForReport),
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
      ...(totalJudgeUsage !== undefined && { totalJudgeUsage }),
    },
  };
}

export async function runEvalSuite(
  options: RunEvalSuiteOptions
): Promise<RunEvalSuiteResult> {
  const suiteStartTime = Date.now();
  const rootDir = options.rootDir ?? process.cwd();
  const manifestDir = path.dirname(path.resolve(options.manifestPath));
  const loadedManifest = loadEvalManifest(options.manifestPath, { rootDir });
  const ambientEnv = Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] => typeof entry[1] === 'string'
    )
  );
  const env = {
    ...ambientEnv,
    ...(options.secretsFile
      ? await loadSecretsFile(
          path.isAbsolute(options.secretsFile)
            ? options.secretsFile
            : path.resolve(rootDir, options.secretsFile)
        )
      : {}),
  };

  const namespaces = await loadSuitePlugins({
    manifestPath: options.manifestPath,
    manifest: loadedManifest,
    rootDir,
    pluginPaths: options.pluginPaths,
    plugins: options.plugins,
  });
  // The manifest with its shared configs applied, before parsing: what the
  // suite is identified by, and the raw settings arms and cases merge with.
  const resolvedManifest = resolveManifestExtends(loadedManifest, namespaces);
  const rawManifest: EvalManifest =
    options.arms === undefined
      ? resolvedManifest
      : {
          ...resolvedManifest,
          arms:
            typeof options.arms === 'function'
              ? options.arms(resolvedManifest.arms ?? [])
              : options.arms,
        };
  const identity = manifestIdentity(rawManifest);
  let manifest = rawManifest;

  manifest = validateManifest(
    {
      ...manifest,
      host: manifest.host ?? { type: 'claude-cli' },
    },
    { namespaces }
  );
  const executionId = randomUUID();
  const outputDir = path.join(
    options.outputDir ?? path.join(rootDir, '.mcp-test-results', manifest.name),
    executionId
  );
  const arms = selectedArms(manifest, options.arm);
  const datasets = manifest.datasets;

  // Datasets load with the suite's selection controls removed: each arm
  // selects its own cases below.
  const sourceManifest: EvalManifest = {
    ...manifest,
    maxCases: undefined,
    filterTags: undefined,
    run: undefined,
  };

  if (options.dryRun) {
    // A dry run checks the datasets too, without the host (and its secrets).
    const loaded = await Promise.all(
      datasets.map((source) =>
        getDatasetSource(source.type).load(source, {
          rootDir,
          manifestDir,
          manifest: sourceManifest,
        })
      )
    );
    for (const dataset of loaded) assertDatasetNamespaces(dataset, namespaces);
    assertCaseHosts(manifest, rawManifest, arms, loaded);
    return {
      manifest,
      outputDir,
      datasets: datasets.map((source, index) => ({
        source,
        dataset: loaded[index],
      })),
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
  const sourceArm = arms[0] ?? { name: 'default' };
  const sourceServers = (
    options.mcpConfig
      ? [options.mcpConfig]
      : (sourceArm.servers ?? manifest.servers ?? [])
  ).map((server) => resolveServerSecrets(server, env));
  sourceServers.forEach((server) => assertEvalEndpoint(server, manifest));
  const sourceHost = resolveHost(manifest, sourceArm, sourceServers, env);
  const canonicalDatasets = await Promise.all(
    datasets.map(async (source) => ({
      source,
      dataset: await getDatasetSource(source.type).load(source, {
        rootDir,
        manifestDir,
        manifest: sourceManifest,
        hostConfig: sourceHost.config,
      }),
    }))
  );
  for (const { dataset } of canonicalDatasets)
    assertDatasetNamespaces(dataset, namespaces);
  // Before any arm runs: a case host that can't honour its arm fails now,
  // not after earlier arms have run.
  assertCaseHosts(
    manifest,
    rawManifest,
    arms,
    canonicalDatasets.map(({ dataset }) => dataset)
  );

  for (const arm of arms) {
    const servers = options.mcpConfig
      ? [options.mcpConfig]
      : (arm.servers ?? manifest.servers ?? []);
    const resolvedServers = servers.map((server) =>
      resolveServerSecrets(server, env)
    );
    resolvedServers.forEach((server) => assertEvalEndpoint(server, manifest));
    // The first arm's resolved host was already needed to load the shared
    // datasets. Reuse it for that arm so source loading does not invoke a
    // stateful host factory twice or create a configuration that is discarded.
    const host =
      arm === sourceArm
        ? sourceHost
        : resolveHost(manifest, arm, resolvedServers, env);
    const effectiveManifest: EvalManifest = {
      ...manifest,
      ...arm,
      host: host.declaration,
      coworkSetup: resolveCoworkSetupConfig(
        manifest.coworkSetup,
        arm.coworkSetup
      ),
      name: manifest.name,
      datasets: manifest.datasets,
    };
    const sourceResults: Array<{
      name: string;
      result: EvalRunnerResult;
    }> = [];
    const appliedPricing: Record<string, ModelPricing> = {};
    const unpricedModels = new Set<string>();
    const rawArm = rawManifest.arms?.find(
      (candidate) => candidate.name === arm.name
    ) ?? { name: arm.name };
    const rawDeclaration = inheritHost(rawManifest.host, rawArm.host ?? {});
    const client =
      host.definition.run || host.definition.runBatch
        ? undefined
        : resolvedServers.length === 1
          ? await createMCPClientForConfig(resolvedServers[0]!)
          : undefined;
    const mcp = client
      ? createMCPFixture(client, undefined, { authType: 'api-token' })
      : undefined;
    // Started on first use, for hosts that connect to their servers themselves.
    const variant = arm.toolOverrides ?? manifest.toolOverrides;
    let proxy: Promise<ToolSurfaceProxy> | undefined;
    const toolVariant = variant
      ? {
          id: variant.id,
          proxy: () =>
            (proxy ??= startToolSurfaceProxy(resolvedServers, variant)),
        }
      : undefined;

    try {
      for (const { source, dataset } of canonicalDatasets) {
        const executionDataset = selectEvalCases(dataset, manifest);
        const template = arm.inputTemplate ?? manifest.inputTemplate;
        const effectiveDataset: EvalDataset = {
          ...executionDataset,
          cases: executionDataset.cases.map((evalCase) => ({
            ...evalCase,
            ...(evalCase.host
              ? {
                  host: parseHostConfig(
                    inheritHost(rawDeclaration, evalCase.host),
                    rawManifest
                  ),
                }
              : {}),
            ...(effectiveManifest.judges?.length
              ? {
                  assertions: EvalAssertionsSchema.parse({
                    ...evalCase.assertions,
                    passesJudge: mergeSuiteJudges(
                      evalCase,
                      effectiveManifest.judges,
                      (rawArm.judges ?? rawManifest.judges ?? []) as Array<
                        Record<string, unknown>
                      >
                    ),
                  }),
                }
              : {}),
            ...(template && evalCase.input
              ? {
                  input: template.replaceAll('{{input}}', evalCase.input),
                }
              : {}),
          })),
        };
        const sourceConfig = source;
        const runHost =
          typeof host.definition.run === 'function' ||
          typeof host.definition.runBatch === 'function';
        const batchStartTime = Date.now();
        const batchTraces = await prepareHostBatch(
          host.definition,
          effectiveDataset.cases,
          host.declaration,
          resolvedServers,
          { manifest: effectiveManifest, arm, env },
          toolVariant
        );
        // Batch execution (including shared setup/cleanup) precedes the runner's
        // wall clock. Count its elapsed time once, not the sum of request times.
        const batchDurationMs = batchTraces ? Date.now() - batchStartTime : 0;
        // Direct cases connect per case; record what those connections
        // negotiated so the run's metadata carries its protocol.
        let directProtocol: MCPProtocolInfo | undefined;
        const result = await runEvalDataset(
          {
            dataset: effectiveDataset,
            // The suite reports its own results (results.json).
            reporting: 'none',
            protocol: () => directProtocol,
            concurrency: manifest.concurrency ?? 1,
            defaultTrials: manifest.trials,
            defaultPassThreshold: manifest.passThreshold,
            toolOverrides: arm.toolOverrides ?? manifest.toolOverrides,
            toolMap: arm.toolMap ?? manifest.toolMap,
            ...(runHost
              ? {
                  executeCase: createSuiteCaseExecutor({
                    servers: resolvedServers,
                    host: host.declaration,
                    manifest: effectiveManifest,
                    arm,
                    env,
                    batchTraces,
                    toolVariant,
                    onDirectConnection: (client) => {
                      directProtocol ??= getProtocolInfo(client);
                    },
                  }),
                }
              : {}),
          },
          { mcp }
        );
        result.durationMs += batchDurationMs;
        allDatasets.push({
          source: sourceConfig,
          dataset: executionDataset,
          result,
        });
        for (const caseResult of result.caseResults) caseResult.arm = arm.name;
        // Price usage the host reported without a cost, at the model each case
        // ran: its own host's (a case host doesn't take the arm's model), a
        // legacy case config's, or the arm host's (including its default).
        const armModel =
          host.declaration.model ??
          (host.config as { model?: unknown } | undefined)?.model;
        const caseModels = new Map(
          effectiveDataset.cases.map((evalCase) => [
            evalCase.id,
            evalCase.host
              ? evalCase.host.model
              : (evalCase.mcpHostConfig?.model ?? armModel),
          ])
        );
        const priced = estimateCosts(
          result.caseResults,
          (caseResult) => {
            const model = caseModels.get(caseResult.id);
            return typeof model === 'string' ? model : undefined;
          },
          manifest.pricing
        );
        Object.assign(appliedPricing, priced.applied);
        for (const model of priced.unpriced) unpricedModels.add(model);
        // The run's totals include the estimates.
        result.totalHostUsage = result.caseResults.reduce<
          UsageMetrics | undefined
        >((sum, caseResult) => sumUsage(sum, caseResult.hostUsage), undefined);
        sourceResults.push({ name: executionDataset.name, result });
        allResults.push(...result.caseResults);
      }
    } finally {
      if (client) await closeMCPClient(client);
      if (proxy) await (await proxy.catch(() => undefined))?.close();
    }

    const summary = summarizeArm(arm, servers, sourceResults);
    if (Object.keys(appliedPricing).length > 0)
      summary.pricing = appliedPricing;
    if (unpricedModels.size > 0)
      summary.unpricedModels = [...unpricedModels].sort();
    armResults.push(summary);
  }

  const armMetrics = armResults.map((arm, index) => {
    const listed = (arms[index]?.metrics ??
      manifest.metrics ??
      []) as MetricSpec[];
    const listedNames = new Set(
      listed.map((spec) => resolveMetric(spec).outName)
    );
    const specs: MetricSpec[] = [
      ...CORE_METRICS.filter((core) => !listedNames.has(core)),
      ...listed,
    ];
    return computeMetrics(specs, arm.result?.caseResults ?? []);
  });
  armResults.forEach((arm, index) => {
    const caseResults = arm.result?.caseResults ?? [];
    arm.metrics = armMetrics[index]!.aggregated;
    const evidence = armEvidence(caseResults);
    if (evidence !== undefined) arm.evidence = evidence;
    // Core metrics are reported when they apply; only listed ones are missed.
    const listed = new Set(
      ((arms[index]?.metrics ?? manifest.metrics ?? []) as MetricSpec[]).map(
        (spec) => resolveMetric(spec).outName
      )
    );
    const unavailable = armMetrics[index]!.unavailable.filter((name) =>
      listed.has(name)
    );
    if (unavailable.length > 0) arm.unavailableMetrics = unavailable;
    const source = costSource(caseResults);
    if (source) arm.costSource = source;
  });
  // Top-level metrics describe the baseline arm. Comparison-arm metrics remain
  // attached to their arm, avoiding case-id collisions across arms.
  const computedMetrics = armMetrics[0]?.aggregated ?? {};
  let totalHostUsage: UsageMetrics | undefined;
  for (const arm of armResults) {
    totalHostUsage = sumUsage(totalHostUsage, arm.result?.totalHostUsage);
  }
  const totalJudgeUsage = sumJudgeUsage(
    armResults.map((arm) => arm.result?.totalJudgeUsage)
  );
  const telemetry: RunTelemetry = {
    cases: allResults.length,
    toolCalls: countTrialToolCalls(allResults),
    failedCases: allResults.filter((result) => !result.pass).length,
    totalHostUsage,
    ...(totalJudgeUsage !== undefined && { totalJudgeUsage }),
  };
  const summary: EvaluationSummary = {
    schemaVersion: 1,
    ...identity,
    timestamp: new Date().toISOString(),
    durationMs: Date.now() - suiteStartTime,
    manifestName: manifest.name,
    arms: armResults,
    metrics: {
      total: allResults.length,
      passed: allResults.filter((result) => result.pass).length,
      failed: allResults.filter((result) => !result.pass).length,
      passRate: passRate({
        passed: allResults.filter((result) => result.pass).length,
        total: allResults.length,
      }),
      ...computedMetrics,
    },
    telemetry,
    armDeltas: buildArmDeltas(armResults),
    results: allResults,
  };

  summary.runId = executionId;
  const store = manifest.results?.store
    ? getResultStore(manifest.results.store.type).create(
        resolveStorePaths(manifest.results.store, { manifestDir, rootDir })
      )
    : undefined;
  // The comparison is a convenience: it must never cost the run its results.
  try {
    const previous = await findPreviousRun({
      manifestId: summary.manifestId,
      runId: executionId,
      arms: summary.arms.map((arm) => arm.name),
      store,
      outputRoot: path.dirname(outputDir),
    });
    if (previous) summary.previousRun = compareWithPrevious(previous, summary);
  } catch (error) {
    console.warn(
      `[mst] Couldn't compare with the previous run: ${error instanceof Error ? error.message : String(error)}`
    );
  }

  const redact =
    options.redactStoredResponses ??
    (manifest.redactStoredResponses as boolean | undefined) ??
    REDACT_STORED_RESPONSES_BY_DEFAULT;
  const storedSummary = redact
    ? redactStoredResponses(summary)
    : structuredClone(summary);
  await fs.mkdir(outputDir, { recursive: true });
  if (store) {
    // Manifest validation already parsed defaults and transforms once.
    const metadata = {
      datasetName: manifest.name,
      // The MST that produced the results, next to the suite's content hash.
      packageVersion: packageJson.version,
      labels: {
        manifestId: summary.manifestId,
        contentHash: summary.contentHash,
      },
    };
    summary.caseArtifactPointers = {};
    for (const [index, arm] of storedSummary.arms.entries()) {
      const id = `${executionId}-arm-${index}`;
      await store.saveArtifact(
        createStoredEvalArtifact({
          kind: 'eval-runner-result',
          id,
          data: arm.result,
          metadata: {
            ...metadata,
            labels: { ...metadata.labels, arm: arm.name },
          },
          createdAt: summary.timestamp,
        })
      );
      summary.caseArtifactPointers[arm.name] = [id];
    }
    // Pointers are populated after redaction/cloning; retain them in both copies.
    storedSummary.caseArtifactPointers = summary.caseArtifactPointers;
    await store.saveArtifact(
      createStoredEvalArtifact({
        kind: 'eval-run-summary',
        id: executionId,
        data: storedSummary,
        metadata,
        createdAt: summary.timestamp,
      })
    );
  }
  await fs.writeFile(
    path.join(outputDir, 'results.json'),
    `${JSON.stringify(storedSummary, null, 2)}\n`
  );
  return { manifest, outputDir, datasets: allDatasets, summary };
}
