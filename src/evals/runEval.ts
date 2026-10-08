import { RUN_FORMAT } from './resultFormat.js';
import { writeRunReport } from './runReport.js';
import {
  assertUniqueCaseIds,
  assertUniqueVariantNames,
  datasetContentHash,
  newRunId,
  runsDirectory,
  writeLatest,
  writeRun,
} from './runFormat.js';
import { rejectRenamedOptions } from './renamedKeys.js';
import { configIdentity } from './configIdentity.js';
import { resolveConfigExtends } from './configExtends.js';
import { resolveCoworkSetupConfig } from './coworkSetup/options.js';
import { sumUsage } from '../utils/usageUtils.js';
import { sumJudgeUsage } from '../judge/judgeContract.js';
import { createHash, createHmac, randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  createMCPClientForConfig,
  closeMCPClient,
} from '../mcp/clientFactory.js';
import { createMCPFixture } from '../mcp/fixtures/mcpFixture.js';
import type { MCPConfig } from '../config/mcpConfig.js';
import { isHttpConfig, usesClientResolvedFields } from '../config/mcpConfig.js';
import {
  variantToolMetadata,
  loadEvalConfig,
  type DatasetConfig,
  type EvalVariant,
  type EvalConfig,
  type ClientConfig,
  type ModelPricing,
  transportServers,
} from './evalConfig.js';
import {
  DEFAULT_CLIENT,
  clientFieldsOf,
  clientOf,
  clientPatchOf,
} from './clientFields.js';
import type {
  EvaluationVariantResult,
  EvaluationSummary,
  ClientDefinition,
  TraceEvidence,
  RunSelection,
  RunTelemetry,
} from './evalFrameworkTypes.js';
import {
  clientEnvironment,
  type ClientEnvironment,
} from './mstClient/clientOptions.js';
import { runEvalDataset } from './evalRunner.js';
import { passRate } from './evalRunComparison.js';
import { createEvalCaseExecutor } from './caseExecution.js';
import { mergeEvalJudges } from './grading.js';
import { prepareClientBatch } from './prepareClientBatch.js';
import type { EvalRunnerResult } from './evalRunner.js';
import type { EvalCase, EvalDataset } from './datasetTypes.js';
import {
  assertNamedCases,
  narrowEvalCases,
  type CaseNarrowing,
} from './buildEvalDataset.js';
import type { EvalCaseResult } from '../types/reporter.js';
import type { UsageMetrics } from '../types/index.js';
import type { Plugin } from '../plugins/plugin.js';
import { assertDatasetNamespaces, loadEvalPlugins } from './evalPlugins.js';
import { getDatasetSource } from './builtinDatasetSources.js';
import {
  assertClientSupports,
  builtinClientDefaults,
  getClient,
} from './builtinClients.js';
import {
  startToolSurfaceProxy,
  type ToolSurfaceProxy,
} from './toolSurfaceProxy.js';
import { getResultStore, resolveStorePaths } from './builtinResultStores.js';
import { compareWithPrevious, findPreviousRun } from './runBaseline.js';
import { costSource, estimateCosts } from './pricing.js';
import {
  pairwiseJudgeSpec,
  parseClientConfig,
  validateEvalConfig,
  inheritClient,
} from './configValidation.js';
import { comparePairwise } from './pairwiseComparison.js';
import type { JudgeCaseSource } from '../judge/judgeContract.js';
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
import {
  expandConnectorServers,
  startConnectorCredentials,
  type ConnectorCredentials,
} from './connectorServers.js';
import { localCredentialStore } from '../auth/grants/localStore.js';
import type { CredentialStore } from '../auth/grants/types.js';

export interface RunEvalOptions {
  configPath: string;
  rootDir?: string;
  /** Plugin specifiers from the CLI, added to the eval config's `plugins`. */
  pluginPaths?: string[];
  /** Plugin objects, added to the eval config's `plugins`. */
  plugins?: readonly Plugin[];
  outputDir?: string;
  secretsFile?: string;
  mcpConfig?: MCPConfig;
  dryRun?: boolean;
  /** Variant names to run, instead of all of them (`--variant`). */
  variant?: string | readonly string[];
  /** Case ids to run, instead of the config's selection (`--case`). */
  cases?: CaseNarrowing['cases'];
  /** Tags to select cases by, instead of the config's `filterTags` (`--filter-tag`). */
  filterTags?: CaseNarrowing['filterTags'];
  /** Cases per dataset, instead of the config's `maxCases` (`--max-cases`). */
  maxCases?: number;
  /** Trials per case, instead of the config's or the case's (`--trials`). */
  trials?: number;
  /**
   * Variants to run instead of the eval config's, validated the same way: a
   * list, or a function of the eval config's variants (after shared configs
   * apply), baseline first. The first variant given is the baseline: the
   * config's `baseline` doesn't apply. For optimizations that generate variants,
   * such as runToolOptimization's eval mode.
   */
  variants?:
    | EvalVariant[]
    | ((configVariants: readonly EvalVariant[]) => EvalVariant[]);
  redactStoredResponses?: boolean;
  /** Skip the eval config's pairwise judges (tool optimization ranks variants itself). */
  skipPairwise?: boolean;
  /**
   * Write the run's report (`report/`, about 650 KB of reporter UI plus the
   * run's data). `mst open` writes a missing report when it opens a run.
   * @default true
   */
  report?: boolean;
  /**
   * Where connector servers' grants are (`mst auth` puts them there).
   * Default: `mst/credential-store/local`.
   */
  credentialStore?: CredentialStore;
}

export interface RunEvalResult {
  evalConfig: EvalConfig;
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
  // A client resolves these; merging process.env here would copy secrets.
  if (usesClientResolvedFields(server)) return server;
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

function assertEvalEndpoint(server: MCPConfig, evalConfig: EvalConfig): void {
  if (!evalConfig.requireEvalEndpoint) return;
  // A client-resolved stdio server declares the endpoint it targets as `url`.
  const endpoint = isHttpConfig(server) ? server.serverUrl : server.url;
  if (endpoint === undefined) return;
  const pathname = new URL(endpoint).pathname;
  if (!/\/eval(?:\/|$)/.test(pathname)) {
    throw new Error(
      `Evaluation requires an /eval MCP endpoint; received "${endpoint}".`
    );
  }
}

function selectedVariants(
  evalConfig: EvalConfig,
  names?: string | readonly string[]
): EvalVariant[] {
  const variants = evalConfig.variants?.length
    ? evalConfig.variants
    : [{ name: 'default' } satisfies EvalVariant];
  const wanted = typeof names === 'string' ? [names] : (names ?? []);
  if (wanted.length === 0) return variants;
  const missing = wanted.filter(
    (name) => !variants.some((variant) => variant.name === name)
  );
  if (missing.length)
    throw new Error(
      `No variant ${missing.map((name) => `"${name}"`).join(', ')} in the eval config. Variants: ${variants.map((variant) => variant.name).join(', ')}.`
    );
  // In the config's order, so the baseline stays first when it is selected.
  return variants.filter((variant) => wanted.includes(variant.name));
}

/** What narrowed this run at run time, or undefined for a full run. */
function runSelection(options: RunEvalOptions): RunSelection | undefined {
  const variants =
    typeof options.variant === 'string'
      ? [options.variant]
      : options.variant?.length
        ? [...options.variant]
        : undefined;
  const selection: RunSelection = {
    ...(variants ? { variants: [...new Set(variants)].sort() } : {}),
    ...(options.cases?.length
      ? { cases: [...new Set(options.cases)].sort() }
      : {}),
    ...(options.filterTags?.length
      ? { filterTags: [...new Set(options.filterTags)].sort() }
      : {}),
    ...(options.maxCases !== undefined ? { maxCases: options.maxCases } : {}),
    ...(options.trials !== undefined ? { trials: options.trials } : {}),
  };
  return Object.keys(selection).length ? selection : undefined;
}

function selectionHashOf(selection: RunSelection): string {
  return createHash('sha256').update(JSON.stringify(selection)).digest('hex');
}

function resolveClient(
  evalConfig: EvalConfig,
  variant: EvalVariant,
  servers: MCPConfig[],
  env: ClientEnvironment
) {
  // Validated levels hold their resolved client, model included.
  const declaration = (clientPatchOf(variant) ??
    clientPatchOf(evalConfig) ?? { type: DEFAULT_CLIENT }) as ClientConfig;
  const definition: ClientDefinition = getClient(declaration.type);
  const config = builtinClientDefaults(declaration.type, {
    ...declaration,
    servers,
    server: servers[0],
    env: clientEnvironment(
      { env: declaration.env as ClientEnvironment | undefined },
      { env }
    ),
  });
  return { definition, declaration, config };
}

/**
 * Every case that names its own client, in every variant: that client can honour the
 * variant's servers, tool variants and concurrency. Checked before anything runs.
 */
function assertCaseClients(
  evalConfig: EvalConfig,
  rawConfig: EvalConfig,
  variants: EvalVariant[],
  datasets: EvalDataset[]
): void {
  for (const variant of variants) {
    const rawVariant = rawConfig.variants?.find(
      (candidate) => candidate.name === variant.name
    );
    const declaration = inheritClient(
      clientOf(rawConfig),
      clientPatchOf(rawVariant) ?? {}
    );
    for (const dataset of datasets) {
      for (const evalCase of dataset.cases) {
        const casePatch = clientPatchOf(evalCase);
        if (!casePatch) continue;
        assertClientSupports(
          parseClientConfig(inheritClient(declaration, casePatch), rawConfig),
          {
            servers: transportServers(variant.servers ?? evalConfig.servers),
            tools: variant.tools ?? evalConfig.tools,
            concurrency: evalConfig.concurrency,
            context: `Case "${evalCase.id}" in variant "${variant.name}"`,
          }
        );
      }
    }
  }
}

/** The variant's share of passing trials, averaged over its cases. */
function trialPassRate(variant: EvaluationVariantResult): number | undefined {
  const value = variant.metrics?.trial_pass_rate;
  return typeof value === 'number' ? value : undefined;
}

const EVIDENCE_STRENGTH: TraceEvidence[] = ['none', 'observed', 'structured'];

/** The weakest evidence among a variant's cases: what its trace metrics rest on. */
function variantEvidence(results: EvalCaseResult[]): TraceEvidence | undefined {
  const levels = results
    .map((result) => result.traceEvidence)
    .filter((level): level is TraceEvidence => level !== undefined);
  return EVIDENCE_STRENGTH.find((level) => levels.includes(level));
}

/**
 * What every variant reports, whatever the eval config lists: outcomes, calls,
 * tokens, cost and time. An eval config's `metrics` add to these.
 */
const CORE_METRICS = [
  'passed',
  'trial_pass',
  'tool_count',
  'mcp_call_count',
  'builtin_event_count',
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

/** Every numeric metric both variants report, as variant minus baseline (per judge for scores). */
function metricDeltas(
  variant: EvaluationVariantResult,
  baseline: EvaluationVariantResult
): Record<string, number | Record<string, number>> {
  const deltas: Record<string, number | Record<string, number>> = {};
  for (const [key, value] of Object.entries(variant.metrics ?? {})) {
    const before = baseline.metrics?.[key];
    if (typeof value === 'number' && typeof before === 'number') {
      deltas[key] = value - before;
    } else if (isNumberRecord(value) && isNumberRecord(before)) {
      // Per-judge scores: a delta for each judge both variants ran.
      const shared = Object.keys(value).filter((name) => name in before);
      if (shared.length > 0)
        deltas[key] = Object.fromEntries(
          shared.map((name) => [name, value[name]! - before[name]!])
        );
    }
  }
  return deltas;
}

function buildVariantDeltas(
  variants: EvaluationVariantResult[]
): Record<string, Record<string, unknown>> {
  const baseline = variants[0]?.result;
  if (!baseline || baseline.total === 0) return {};
  const baselineRate = passRate(baseline);
  const baselineTrialRate = trialPassRate(variants[0]!);
  return Object.fromEntries(
    variants.slice(1).map((variant) => {
      const rate = variant.result ? passRate(variant.result) : 0;
      const trials = trialPassRate(variant);
      return [
        variant.name,
        {
          passRate: rate,
          passRateDelta: rate - baselineRate,
          ...(trials !== undefined && baselineTrialRate !== undefined
            ? {
                trialPassRate: trials,
                trialPassRateDelta: trials - baselineTrialRate,
              }
            : {}),
          metricDeltas: metricDeltas(variant, variants[0]!),
          baseline: variants[0]?.name,
        },
      ];
    })
  );
}

/**
 * After every variant has run: compare each variant with the baseline, case
 * by case, with the eval config's `pairwiseJudges`, and record the result on
 * the variant. Skipped, with a note, when the baseline didn't run (`--variant`).
 * Returns the pairwise judges' usage.
 */
async function comparePairwiseVariants(
  evalConfig: EvalConfig,
  variantResults: EvaluationVariantResult[],
  cases: readonly EvalCase[]
): Promise<Partial<UsageMetrics> | undefined> {
  const judges = (evalConfig.pairwiseJudges ?? []).map(pairwiseJudgeSpec);
  if (judges.length === 0) return undefined;
  // Validation put the baseline first.
  const baselineName = evalConfig.variants?.[0]?.name ?? 'default';
  const baseline = variantResults.find(
    (variant) => variant.name === baselineName
  );
  if (!baseline) {
    console.warn(
      `[mst] The baseline "${baselineName}" didn't run, so no pairwise judge compared the variants with it.`
    );
    return undefined;
  }
  const candidates = variantResults.filter((variant) => variant !== baseline);
  const byId = new Map<string, JudgeCaseSource>(
    cases.map((evalCase) => [evalCase.id, evalCase])
  );
  // A case that errored on either side has nothing to compare.
  const ran = (variant: EvaluationVariantResult) =>
    (variant.result?.caseResults ?? []).filter((result) => !result.error);
  for (const candidate of candidates)
    candidate.pairwise = await comparePairwise({
      baseline: { name: baseline.name, caseResults: ran(baseline) },
      candidate: { name: candidate.name, caseResults: ran(candidate) },
      judges,
      cases: byId,
      concurrency: evalConfig.concurrency,
    });
  return sumJudgeUsage(candidates.map((variant) => variant.pairwise?.usage));
}

/**
 * What a variant runs with, for run.json and the report's "What differs":
 * its client, model and client options, tool metadata, input template and
 * judges. Client options whose names suggest credentials, and any that
 * aren't plain values, are replaced by a hash.
 */
function variantSetup(
  evalConfig: EvalConfig,
  declared: EvalVariant | undefined,
  runKey: Buffer
): Record<string, unknown> {
  const client = declared?.client ?? evalConfig.client;
  const model = declared?.model ?? evalConfig.model;
  // A variant's options add to the eval config's when it keeps the client.
  const options =
    declared?.client === undefined || declared.client === evalConfig.client
      ? { ...evalConfig.clientOptions, ...declared?.clientOptions }
      : { ...declared.clientOptions };
  const tools = declared?.tools ?? evalConfig.tools;
  const inputTemplate = declared?.inputTemplate ?? evalConfig.inputTemplate;
  const judges = (declared?.judges ?? evalConfig.judges ?? []).map((judge) =>
    typeof judge === 'string' ? judge : judge.type
  );
  return {
    ...(declared?.description ? { description: declared.description } : {}),
    ...(typeof client === 'string' ? { client } : {}),
    ...(typeof model === 'string' ? { model } : {}),
    ...(Object.keys(options).length
      ? { clientOptions: recordableOptions(options, runKey) }
      : {}),
    ...(tools ? { tools } : {}),
    ...(inputTemplate ? { inputTemplate } : {}),
    ...(judges.length ? { judges } : {}),
  };
}

/** Option names that suggest a credential, a location or a header. */
const SENSITIVE_OPTION =
  /key|token|secret|password|passwd|auth|credential|cookie|bearer|session|jwt|sig|pat$|url|uri|header|env/i;

/** Values that look like a URL, a long token, or a key=value pair. */
const SENSITIVE_VALUE = /:\/\/|=|^[A-Za-z0-9_\-.~+/]{24,}$/;

/**
 * A variant's client options as run.json records them: numbers, booleans
 * and short strings whose name and value don't suggest a credential are
 * kept; everything else is replaced by an HMAC keyed for this run, so
 * variants of one run can be compared but values can't be guessed or
 * matched across runs.
 */
export function recordableOptions(
  options: Record<string, unknown>,
  runKey: Buffer
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(options).map(([key, value]) => {
      const safe =
        !SENSITIVE_OPTION.test(key) &&
        (value === null ||
          typeof value === 'number' ||
          typeof value === 'boolean' ||
          (typeof value === 'string' &&
            value.length <= 64 &&
            !SENSITIVE_VALUE.test(value)));
      return [
        key,
        safe
          ? value
          : `hmac:${createHmac('sha256', runKey)
              .update(JSON.stringify(value) ?? '')
              .digest('hex')
              .slice(0, 16)}`,
      ];
    })
  );
}

/** The judges a run used, by name and level, each with a hash of its options. */
function judgeRecords(
  evalConfig: EvalConfig
): Array<{ type: string; level: string; optionsHash: string }> {
  const record = (level: string) => (entry: unknown) => {
    const { type, ...options } =
      typeof entry === 'string'
        ? { type: entry }
        : (entry as { type: string } & Record<string, unknown>);
    return {
      type,
      level,
      optionsHash: createHash('sha256')
        .update(JSON.stringify(options))
        .digest('hex'),
    };
  };
  const configJudges = JSON.stringify(evalConfig.judges ?? []);
  return [
    ...(evalConfig.judges ?? []).map(record('config')),
    // A variant's judges, when they replace the config's.
    ...(evalConfig.variants ?? [])
      .filter(
        (variant) =>
          variant.judges !== undefined &&
          JSON.stringify(variant.judges) !== configJudges
      )
      .flatMap((variant) =>
        variant.judges!.map(record(`variant:${variant.name}`))
      ),
    ...((evalConfig.pairwiseJudges ?? []) as unknown[]).map(record('pairwise')),
  ];
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

function summarizeVariant(
  variant: EvalVariant,
  servers: MCPConfig[],
  results: Array<{ name: string; result: EvalRunnerResult }>
): EvaluationVariantResult {
  const caseResults: EvalCaseResult[] = [];
  let totalClientUsage: UsageMetrics | undefined;
  for (const { result } of results) {
    caseResults.push(...result.caseResults);
    if (result.totalClientUsage) {
      totalClientUsage = sumUsage(totalClientUsage, result.totalClientUsage);
    }
  }
  const totalJudgeUsage = sumJudgeUsage(
    results.map(({ result }) => result.totalJudgeUsage)
  );
  return {
    name: variant.name,
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
      totalClientUsage,
      ...(totalJudgeUsage !== undefined && { totalJudgeUsage }),
    },
  };
}

export async function runEval(options: RunEvalOptions): Promise<RunEvalResult> {
  rejectRenamedOptions(
    options,
    { manifestPath: 'configPath', arm: 'variant', arms: 'variants' },
    'runEval'
  );
  const runStartTime = Date.now();
  const rootDir = options.rootDir ?? process.cwd();
  const configDir = path.dirname(path.resolve(options.configPath));
  const loadedConfig = loadEvalConfig(options.configPath, { rootDir });
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

  const namespaces = await loadEvalPlugins({
    configPath: options.configPath,
    evalConfig: loadedConfig,
    rootDir,
    pluginPaths: options.pluginPaths,
    plugins: options.plugins,
  });
  // The eval config with its shared configs applied, before parsing: what the
  // eval is identified by, and the raw settings variants and cases merge with.
  const resolvedConfig = resolveConfigExtends(loadedConfig, namespaces);
  const rawConfig: EvalConfig =
    options.variants === undefined ? resolvedConfig : replaceVariants();
  // Generated variants are listed baseline first, so the config's own
  // `baseline` (which may name none of them) gives way.
  function replaceVariants(): EvalConfig {
    const { baseline, ...rest } = resolvedConfig;
    const configVariants = resolvedConfig.variants ?? [];
    const index =
      baseline === undefined
        ? -1
        : configVariants.findIndex((variant) => variant.name === baseline);
    const ordered =
      index < 0
        ? configVariants
        : [
            configVariants[index]!,
            ...configVariants.filter((_, i) => i !== index),
          ];
    return {
      ...rest,
      variants:
        typeof options.variants === 'function'
          ? options.variants(ordered)
          : options.variants!,
    };
  }
  // Identity is the config as written: connector names, not machine paths.
  const identity = configIdentity(rawConfig);
  // Connector servers become the entries their connectors launch. Paths and
  // env names only; tokens arrive when the run starts.
  const connectors = await expandConnectorServers(rawConfig);
  let evalConfig = connectors.evalConfig;

  evalConfig = validateEvalConfig(
    {
      ...evalConfig,
      client: evalConfig.client ?? DEFAULT_CLIENT,
    },
    { namespaces }
  );

  const executionId = newRunId();
  // The eval's directory holds its runs (runs/<run-id>/) and latest.json.
  const evalDirectory =
    options.outputDir ??
    path.join(rootDir, '.mcp-test-results', evalConfig.name);
  const outputDir = path.join(runsDirectory(evalDirectory), executionId);
  const variants = selectedVariants(evalConfig, options.variant);
  const datasets = evalConfig.datasets;

  // Datasets load with the eval's selection controls removed: each variant
  // selects its own cases below.
  const sourceConfig: EvalConfig = {
    ...evalConfig,
    maxCases: undefined,
    filterTags: undefined,
    run: undefined,
  };

  if (options.dryRun) {
    // A dry run checks the datasets too, without the client (and its secrets).
    const loaded = await Promise.all(
      datasets.map((source) =>
        getDatasetSource(source.type).load(source, {
          rootDir,
          configDir,
          evalConfig: sourceConfig,
        })
      )
    );
    for (const dataset of loaded) assertDatasetNamespaces(dataset, namespaces);
    assertNamedCases(loaded, options.cases);
    assertCaseClients(evalConfig, rawConfig, variants, loaded);
    return {
      evalConfig,
      outputDir,
      datasets: datasets.map((source, index) => ({
        source,
        dataset: loaded[index],
      })),
      summary: {
        format: RUN_FORMAT,
        ...identity,
        timestamp: new Date().toISOString(),
        durationMs: 0,
        configName: evalConfig.name,
        variants: [],
        metrics: {},
        variantDeltas: {},
        results: [],
      },
    };
  }

  const variantResults: EvaluationVariantResult[] = [];
  const allDatasets: RunEvalResult['datasets'] = [];
  const allResults: EvalCaseResult[] = [];
  const sourceVariant = variants[0] ?? { name: 'default' };
  const canonicalDatasets = await Promise.all(
    datasets.map(async (source) => ({
      source,
      dataset: await getDatasetSource(source.type).load(source, {
        rootDir,
        configDir,
        evalConfig: sourceConfig,
      }),
    }))
  );
  for (const { dataset } of canonicalDatasets)
    assertDatasetNamespaces(dataset, namespaces);
  assertUniqueCaseIds(canonicalDatasets.map(({ dataset }) => dataset));
  assertUniqueVariantNames(variants.map((variant) => variant.name));
  assertNamedCases(
    canonicalDatasets.map(({ dataset }) => dataset),
    options.cases
  );
  const narrowing: CaseNarrowing = {
    cases: options.cases,
    filterTags: options.filterTags,
    maxCases: options.maxCases,
    trials: options.trials,
  };
  // Before any client starts: a fresh token for every connector server, kept
  // fresh until the run ends.
  const credentials: ConnectorCredentials = await startConnectorCredentials(
    connectors,
    options.credentialStore ?? localCredentialStore(),
    {
      configPath: options.configPath,
      variants: variants.map((variant) => variant.name),
    }
  );
  try {
    Object.assign(env, credentials.env);
    const sourceServers = (
      options.mcpConfig
        ? [options.mcpConfig]
        : transportServers(sourceVariant.servers ?? evalConfig.servers)
    ).map((server) => resolveServerSecrets(server, env));
    sourceServers.forEach((server) => assertEvalEndpoint(server, evalConfig));
    const sourceClient = resolveClient(
      evalConfig,
      sourceVariant,
      sourceServers,
      env
    );
    // Before any variant runs: a case client that can't honour its variant fails now,
    // not after earlier variants have run.
    assertCaseClients(
      evalConfig,
      rawConfig,
      variants,
      canonicalDatasets.map(({ dataset }) => dataset)
    );

    for (const variant of variants) {
      const servers = options.mcpConfig
        ? [options.mcpConfig]
        : transportServers(variant.servers ?? evalConfig.servers);
      const resolvedServers = servers.map((server) =>
        resolveServerSecrets(server, env)
      );
      resolvedServers.forEach((server) =>
        assertEvalEndpoint(server, evalConfig)
      );
      // The first variant's client was resolved before the datasets loaded (to
      // check its servers); reuse it rather than resolve it twice.
      const clientConfig =
        variant === sourceVariant
          ? sourceClient
          : resolveClient(evalConfig, variant, resolvedServers, env);
      const effectiveConfig: EvalConfig = {
        ...evalConfig,
        ...variant,
        host: clientConfig.declaration,
        coworkSetup: resolveCoworkSetupConfig(
          evalConfig.coworkSetup,
          variant.coworkSetup
        ),
        name: evalConfig.name,
        datasets: evalConfig.datasets,
      };
      const sourceResults: Array<{
        name: string;
        result: EvalRunnerResult;
      }> = [];
      const appliedPricing: Record<string, ModelPricing> = {};
      const unpricedModels = new Set<string>();
      const rawVariant = rawConfig.variants?.find(
        (candidate) => candidate.name === variant.name
      ) ?? { name: variant.name };
      const rawDeclaration = inheritClient(
        clientOf(rawConfig),
        clientPatchOf(rawVariant) ?? {}
      );
      const client =
        clientConfig.definition.run || clientConfig.definition.runBatch
          ? undefined
          : resolvedServers.length === 1
            ? await createMCPClientForConfig(resolvedServers[0]!)
            : undefined;
      const mcp = client
        ? createMCPFixture(client, undefined, { authType: 'api-token' })
        : undefined;
      // Started on first use, for hosts that connect to their servers themselves.
      const toolMetadata = variantToolMetadata(evalConfig, variant);
      let proxy: Promise<ToolSurfaceProxy> | undefined;
      const toolVariant = toolMetadata
        ? {
            id: toolMetadata.id,
            proxy: () =>
              (proxy ??= startToolSurfaceProxy(resolvedServers, toolMetadata)),
          }
        : undefined;

      try {
        for (const { source, dataset } of canonicalDatasets) {
          const executionDataset = narrowEvalCases(
            dataset,
            evalConfig,
            narrowing
          );
          if (executionDataset.cases.length === 0) continue;
          const template = variant.inputTemplate ?? evalConfig.inputTemplate;
          const effectiveDataset: EvalDataset = {
            ...executionDataset,
            cases: executionDataset.cases.map((evalCase) => ({
              ...evalCase,
              // A case's own client, resolved in full on the case itself.
              ...(clientPatchOf(evalCase)
                ? clientFieldsOf(
                    parseClientConfig(
                      inheritClient(rawDeclaration, clientPatchOf(evalCase)!),
                      rawConfig
                    )
                  )
                : {}),
              // The case's judges and the eval config's (a variant's replace
              // the config's); the case's settings win for a judge in both.
              ...(effectiveConfig.judges?.length
                ? {
                    judges: mergeEvalJudges(
                      evalCase,
                      effectiveConfig.judges,
                      (rawVariant.judges ?? rawConfig.judges ?? []) as Array<
                        Record<string, unknown>
                      >
                    ),
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
          const runClient =
            typeof clientConfig.definition.run === 'function' ||
            typeof clientConfig.definition.runBatch === 'function';
          if (!runClient && effectiveDataset.cases.length > 0)
            throw new Error(
              `Client "${clientConfig.declaration.type}" has neither run() nor runBatch(), so it can't run cases.`
            );
          // The model each case runs on prices its usage and labels its result:
          // a case client's own, or the variant client's (including its default).
          const variantModel =
            clientConfig.declaration.model ??
            (clientConfig.config as { model?: unknown } | undefined)?.model;
          const batchStartTime = Date.now();
          const batchTraces = await prepareClientBatch(
            clientConfig.definition,
            effectiveDataset.cases,
            clientConfig.declaration,
            resolvedServers,
            { evalConfig: effectiveConfig, variant, env },
            toolVariant
          );
          // Batch execution (including shared setup/cleanup) precedes the runner's
          // wall clock. Count its elapsed time once, not the sum of request times.
          const batchDurationMs = batchTraces ? Date.now() - batchStartTime : 0;
          const result = await runEvalDataset(
            {
              dataset: effectiveDataset,
              client: clientConfig.declaration.type,
              ...(typeof variantModel === 'string'
                ? { model: variantModel }
                : {}),
              // The eval writes its own run directory.
              reporting: 'none',
              concurrency: evalConfig.concurrency ?? 1,
              defaultTrials: evalConfig.trials,
              defaultPassThreshold: evalConfig.passThreshold,
              toolOverrides: toolMetadata,
              toolMap: variant.toolMap ?? evalConfig.toolMap,
              ...(runClient
                ? {
                    executeCase: createEvalCaseExecutor({
                      servers: resolvedServers,
                      client: clientConfig.declaration,
                      evalConfig: effectiveConfig,
                      variant,
                      env,
                      batchTraces,
                      toolVariant,
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
          for (const caseResult of result.caseResults)
            caseResult.variant = variant.name;
          // Price usage the client reported without a cost, at the model each
          // case ran (a case client doesn't take the variant's model).
          const caseModels = new Map(
            effectiveDataset.cases.map((evalCase) => [
              evalCase.id,
              clientPatchOf(evalCase) ? evalCase.model : variantModel,
            ])
          );
          const priced = estimateCosts(
            result.caseResults,
            (caseResult) => {
              const model = caseModels.get(caseResult.id);
              return typeof model === 'string' ? model : undefined;
            },
            evalConfig.pricing
          );
          Object.assign(appliedPricing, priced.applied);
          for (const model of priced.unpriced) unpricedModels.add(model);
          // The run's totals include the estimates.
          result.totalClientUsage = result.caseResults.reduce<
            UsageMetrics | undefined
          >(
            (sum, caseResult) => sumUsage(sum, caseResult.clientUsage),
            undefined
          );
          sourceResults.push({ name: executionDataset.name, result });
          allResults.push(...result.caseResults);
        }
      } finally {
        if (client) await closeMCPClient(client);
        if (proxy) await (await proxy.catch(() => undefined))?.close();
      }

      const summary = summarizeVariant(variant, servers, sourceResults);
      if (Object.keys(appliedPricing).length > 0)
        summary.pricing = appliedPricing;
      if (unpricedModels.size > 0)
        summary.unpricedModels = [...unpricedModels].sort();
      variantResults.push(summary);
    }
  } finally {
    await credentials.stop();
  }

  // Like the previous-run comparison, pairwise judging must never cost the
  // run its results.
  let pairwiseUsage: Partial<UsageMetrics> | undefined;
  if (!options.skipPairwise) {
    try {
      pairwiseUsage = await comparePairwiseVariants(
        evalConfig,
        variantResults,
        canonicalDatasets.flatMap(({ dataset }) => dataset.cases)
      );
    } catch (error) {
      console.warn(
        `[mst] Pairwise judges didn't run: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  const variantMetrics = variantResults.map((variant, index) => {
    const listed = (variants[index]?.metrics ??
      evalConfig.metrics ??
      []) as MetricSpec[];
    const listedNames = new Set(
      listed.map((spec) => resolveMetric(spec).outName)
    );
    const specs: MetricSpec[] = [
      ...CORE_METRICS.filter((core) => !listedNames.has(core)),
      ...listed,
    ];
    return computeMetrics(specs, variant.result?.caseResults ?? []);
  });
  variantResults.forEach((variant, index) => {
    const caseResults = variant.result?.caseResults ?? [];
    variant.metrics = variantMetrics[index]!.aggregated;
    const evidence = variantEvidence(caseResults);
    if (evidence !== undefined) variant.evidence = evidence;
    // Core metrics are reported when they apply; only listed ones are missed.
    const listed = new Set(
      (
        (variants[index]?.metrics ?? evalConfig.metrics ?? []) as MetricSpec[]
      ).map((spec) => resolveMetric(spec).outName)
    );
    const unavailable = variantMetrics[index]!.unavailable.filter((name) =>
      listed.has(name)
    );
    if (unavailable.length > 0) variant.unavailableMetrics = unavailable;
    const source = costSource(caseResults);
    if (source) variant.costSource = source;
  });
  // Top-level metrics describe the baseline variant. Comparison-variant metrics remain
  // attached to their variant, avoiding case-id collisions across variants.
  const computedMetrics = variantMetrics[0]?.aggregated ?? {};
  let totalClientUsage: UsageMetrics | undefined;
  for (const variant of variantResults) {
    totalClientUsage = sumUsage(
      totalClientUsage,
      variant.result?.totalClientUsage
    );
  }
  // Every judge's usage, pairwise included; pairwise is also reported alone.
  const totalJudgeUsage = sumJudgeUsage([
    ...variantResults.map((variant) => variant.result?.totalJudgeUsage),
    pairwiseUsage,
  ]);
  const telemetry: RunTelemetry = {
    cases: allResults.length,
    toolCalls: countTrialToolCalls(allResults),
    failedCases: allResults.filter((result) => !result.pass).length,
    totalClientUsage,
    ...(totalJudgeUsage !== undefined && { totalJudgeUsage }),
    ...(pairwiseUsage !== undefined && { pairwiseJudgeUsage: pairwiseUsage }),
  };
  const summary: EvaluationSummary = {
    format: RUN_FORMAT,
    ...identity,
    timestamp: new Date().toISOString(),
    durationMs: Date.now() - runStartTime,
    configName: evalConfig.name,
    variants: variantResults,
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
    variantDeltas: buildVariantDeltas(variantResults),
    results: allResults,
  };

  summary.runId = executionId;
  const selection = runSelection(options);
  summary.partial = selection !== undefined;
  if (selection) {
    summary.selection = selection;
    summary.selectionHash = selectionHashOf(selection);
  }
  const store = evalConfig.results?.store
    ? getResultStore(evalConfig.results.store.type).create(
        resolveStorePaths(evalConfig.results.store, { configDir, rootDir })
      )
    : undefined;
  // The comparison is a convenience: it must never cost the run its results.
  try {
    const previous = await findPreviousRun({
      configId: summary.configId,
      runId: executionId,
      variants: summary.variants.map((variant) => variant.name),
      partial: summary.partial,
      selectionHash: summary.selectionHash,
      store,
      outputRoot: runsDirectory(evalDirectory),
    });
    if (previous) summary.previousRun = compareWithPrevious(previous, summary);
  } catch (error) {
    console.warn(
      `[mst] Couldn't compare with the previous run: ${error instanceof Error ? error.message : String(error)}`
    );
  }

  const redact =
    options.redactStoredResponses ??
    (evalConfig.redactStoredResponses as boolean | undefined) ??
    REDACT_STORED_RESPONSES_BY_DEFAULT;
  const storedSummary = redact
    ? redactStoredResponses(summary)
    : structuredClone(summary);
  await fs.mkdir(outputDir, { recursive: true });
  if (store) {
    // Eval config validation already parsed defaults and transforms once.
    const metadata = {
      datasetName: evalConfig.name,
      // The MST that produced the results, next to the eval's content hash.
      packageVersion: packageJson.version,
      labels: {
        configId: summary.configId,
        contentHash: summary.contentHash,
        ...(summary.partial
          ? { partial: 'true', selectionHash: summary.selectionHash! }
          : {}),
      },
    };
    summary.caseArtifactPointers = {};
    for (const [index, variant] of storedSummary.variants.entries()) {
      const id = `${executionId}-variant-${index}`;
      await store.saveArtifact(
        createStoredEvalArtifact({
          kind: 'eval-runner-result',
          id,
          data: variant.result,
          metadata: {
            ...metadata,
            labels: { ...metadata.labels, variant: variant.name },
          },
          createdAt: summary.timestamp,
        })
      );
      summary.caseArtifactPointers[variant.name] = [id];
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
  // Keys the hashes of client options in run.json: comparable within this run only.
  const runKey = randomBytes(32);
  await writeRun(
    outputDir,
    executionId,
    {
      evalName: evalConfig.name,
      createdAt: new Date(runStartTime).toISOString(),
      finishedAt: new Date().toISOString(),
      mstVersion: packageJson.version,
      // Validation put the baseline first; a --variant run may leave it out.
      baseline: evalConfig.variants?.[0]?.name ?? 'default',
      variants: storedSummary.variants.map((variant) => {
        const declared = variants.find(
          (candidate) => candidate.name === variant.name
        );
        return {
          name: variant.name,
          servers: variant.servers,
          ...variantSetup(evalConfig, declared, runKey),
        };
      }),
      // The cases each dataset ran (the first variant's selection).
      datasets: allDatasets
        .map((item) => item.dataset)
        .filter(
          (dataset, index, all): dataset is EvalDataset =>
            dataset !== undefined &&
            all.findIndex((other) => other?.name === dataset.name) === index
        )
        .map((dataset) => ({
          name: dataset.name,
          caseCount: dataset.cases.length,
          contentHash: datasetContentHash(dataset),
        })),
      // Judges by name, with a hash of their options: options can hold
      // settings that shouldn't be stored.
      judges: judgeRecords(evalConfig),
      redactStoredResponses: redact,
    },
    storedSummary
  );
  // The report is rebuilt from the run's files, so it shows what was stored.
  // It must never cost the run its results.
  try {
    if (options.report !== false) await writeRunReport(outputDir);
  } catch (error) {
    console.warn(
      `[mst] The run's report wasn't written: ${error instanceof Error ? error.message : String(error)}`
    );
  }
  // Last, so a crash leaves latest.json at the previous run; a partial run
  // never becomes the latest.
  if (!summary.partial)
    await writeLatest(evalDirectory, executionId, summary.timestamp);
  return { evalConfig, outputDir, datasets: allDatasets, summary };
}
