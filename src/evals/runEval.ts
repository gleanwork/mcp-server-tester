import { RUN_FORMAT } from './resultFormat.js';
import { writeRunReport } from './runReport.js';
import {
  assertUniqueCaseIds,
  assertUniqueVariantNames,
  datasetContentHash,
  newRunId,
  runsDirectory,
  writeLatest,
  readLatestRunId,
  writeRun,
  writeTrial,
  type RunFacts,
  findRunDirectory,
  nextRegradeId,
  readRunDirectory,
  readRunTrials,
} from './runFormat.js';
import {
  withCopiedArtifacts,
  withoutTrialArtifacts,
} from './trialArtifacts.js';
import {
  assertReplayedCases,
  assertStoredArtifacts,
  isMissingTrial,
  replayExecutor,
  replayedCases,
  replayedVariants,
  runReplay,
  type RunReplay,
} from './replay.js';
import { rejectRenamedOptions } from './renamedKeys.js';
import { configIdentity } from './configIdentity.js';
import { resolveConfigExtends } from './configExtends.js';
import { resolveCoworkSetupConfig } from './coworkSetup/options.js';
import { sumUsage } from '../utils/usageUtils.js';
import { sumJudgeUsage } from '../judge/judgeContract.js';
import { createHash, createHmac, randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  createMCPClientForConfig,
  closeMCPClient,
} from '../mcp/clientFactory.js';
import { createMCPFixture } from '../mcp/fixtures/mcpFixture.js';
import type { MCPConfig } from '../config/mcpConfig.js';
import { isHttpConfig } from '../config/mcpConfig.js';
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
import { executedTrialResult, runEvalDataset } from './evalRunner.js';
import { passRate } from './evalRunComparison.js';
import { buildVariantDeltas } from './variantDeltas.js';
import {
  batchTraceExecution,
  createEvalCaseExecutor,
} from './caseExecution.js';
import { mergeEvalJudges, preflightCaseJudges } from './grading.js';
import { batchRequests, prepareClientBatch } from './prepareClientBatch.js';
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
  usesToolSurfaceProxy,
  type ToolSurfaceProxy,
} from './toolSurfaceProxy.js';
import {
  collectInEnvironment,
  gatheredQueues,
  type GatheredResults,
  type RequestGroup,
} from './environments/shardedCollect.js';
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
  CORE_METRICS,
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
import { resolveServerSecrets } from './serverSecrets.js';
import type { CredentialStore } from '../auth/grants/types.js';
import {
  LOCAL_ENVIRONMENT,
  resolveEnvironment,
  type RunEnvironment,
} from './environments/builtinEnvironments.js';

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
  /**
   * Grade the trials: assertions, judges and pairwise judges. `false` only
   * collects (`mst run --no-grade`): the run keeps its traces, with no scores,
   * for `mst grade` to grade later.
   * @default true
   */
  grade?: boolean;
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
  /** Where to collect trials (`--env`). Default: `local`. */
  env?: string;
  /** The environment's options (`--env-option key=value`), as strings. */
  envOptions?: Readonly<Record<string, string>>;
}

export interface RunEvalResult {
  evalConfig: EvalConfig;
  outputDir: string;
  /** Where the trials were (or, in a dry run, would be) collected. */
  environment: RunEnvironment;
  datasets: Array<{
    source: DatasetConfig;
    dataset?: EvalDataset;
    result?: EvalRunnerResult;
  }>;
  summary: EvaluationSummary;
  /** A regrade's source: the run whose traces it graded. */
  gradedFrom?: string;
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

/** Whether a shard ended before one of the case's trials came back. */
function hasMissingTrial(result: EvalCaseResult): boolean {
  return (
    result.clientDiagnostics?.failureKind === 'missing' ||
    (result.trialResults ?? []).some(
      (trial) => trial.clientDiagnostics?.failureKind === 'missing'
    )
  );
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

const EVIDENCE_STRENGTH: TraceEvidence[] = ['none', 'observed', 'structured'];

/** The weakest evidence among a variant's cases: what its trace metrics rest on. */
function variantEvidence(results: EvalCaseResult[]): TraceEvidence | undefined {
  const levels = results
    .map((result) => result.traceEvidence)
    .filter((level): level is TraceEvidence => level !== undefined);
  return EVIDENCE_STRENGTH.find((level) => levels.includes(level));
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
  // A case whose client errored on either side has nothing to compare; one
  // a grader couldn't score still has the client's answer.
  const ran = (variant: EvaluationVariantResult) =>
    (variant.result?.caseResults ?? []).filter(
      (result) => !result.error || result.gradingError !== undefined
    );
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
  return evaluate(options);
}

/** What `mst grade` grades, and with which eval config. */
export interface GradeRunOptions extends Pick<
  RunEvalOptions,
  | 'configPath'
  | 'rootDir'
  | 'pluginPaths'
  | 'plugins'
  | 'outputDir'
  | 'secretsFile'
  | 'report'
> {
  /**
   * The run to grade: its directory, its run ID, or the ID's short form (the
   * 6 hex characters) among the eval's runs.
   */
  run: string;
}

/**
 * Grade a stored run again (`mst grade`): the eval config's current
 * assertions, judges and pairwise judges score the traces the run stored,
 * and the scores are a new run (`<run-id>.g<n>`) next to it, whose
 * `gradedFrom` names the run. No client runs, so it needs no tokens. The
 * datasets are loaded again: a case's `expected` and judges are today's.
 */
export async function gradeRun(
  options: GradeRunOptions
): Promise<RunEvalResult> {
  const rootDir = options.rootDir ?? process.cwd();
  const { name } = loadEvalConfig(options.configPath, { rootDir });
  const evalDirectory =
    options.outputDir ?? path.join(rootDir, '.mcp-test-results', name);
  const directory = await findRunDirectory(
    runsDirectory(evalDirectory),
    options.run,
    rootDir
  );
  const { run, summary: stored } = await readRunDirectory(directory);
  if (run.evalName !== name)
    throw new Error(
      `Run ${run.runId} is a run of eval "${run.evalName}", not of "${name}" (${options.configPath}).`
    );
  const replay = runReplay(
    run,
    directory,
    await readRunTrials(directory),
    await nextRegradeId(path.dirname(directory), run.runId),
    stored.collectedAt ?? stored.timestamp
  );
  await assertStoredArtifacts(replay);
  const { run: _run, ...evalOptions } = options;
  return evaluate(
    {
      ...evalOptions,
      rootDir,
      // The regrade goes next to the run it grades.
      outputDir: path.dirname(path.dirname(directory)),
      redactStoredResponses: run.redactStoredResponses,
    },
    replay
  );
}

/** What `mst run --resume` completes, and where. */
export interface ResumeRunOptions extends GradeRunOptions {
  /** The environment to collect in. Default: the one the run used. */
  env?: string;
  /** Its options. Default: the run's (`shards`, `keep` and its own). */
  envOptions?: Readonly<Record<string, string>>;
  credentialStore?: CredentialStore;
}

/**
 * Complete a run whose shards ended early (`mst run --resume`, ADR 0004):
 * collect only its missing trials, in its environment, and grade the run
 * again into its own directory, with every other trial graded from its
 * stored trace. Needs traces stored unredacted, as `mst grade` does.
 */
export async function resumeRun(
  options: ResumeRunOptions
): Promise<RunEvalResult> {
  const rootDir = options.rootDir ?? process.cwd();
  const { name } = loadEvalConfig(options.configPath, { rootDir });
  const evalDirectory =
    options.outputDir ?? path.join(rootDir, '.mcp-test-results', name);
  const directory = await findRunDirectory(
    runsDirectory(evalDirectory),
    options.run,
    rootDir
  );
  const { run, summary: stored } = await readRunDirectory(directory);
  if (run.evalName !== name)
    throw new Error(
      `Run ${run.runId} is a run of eval "${run.evalName}", not of "${name}" (${options.configPath}).`
    );
  if (run.gradedFrom)
    throw new Error(
      `Run ${run.runId} is a regrade of ${run.gradedFrom}: resume ${run.gradedFrom} instead.`
    );
  const trials = await readRunTrials(directory);
  const missing = trials.filter(isMissingTrial).length;
  if (missing === 0)
    throw new Error(
      `Run ${run.runId} has no missing trials: there is nothing to resume.`
    );
  const recorded = run.environment as {
    name?: string;
    shards?: number;
    keep?: string;
    options?: Record<string, unknown>;
  };
  const env = options.env ?? recorded.name ?? LOCAL_ENVIRONMENT;
  const envOptions =
    options.envOptions ??
    Object.fromEntries(
      Object.entries({
        ...recorded.options,
        shards: recorded.shards,
        keep: recorded.keep,
      }).flatMap(([key, value]) =>
        value === undefined ? [] : [[key, String(value)]]
      )
    );
  const { run: _run, env: _env, envOptions: _envOptions, ...rest } = options;
  const replay = runReplay(
    run,
    directory,
    trials,
    run.runId,
    stored.collectedAt ?? stored.timestamp
  );
  await assertStoredArtifacts(replay);
  return evaluate(
    {
      ...rest,
      rootDir,
      outputDir: evalDirectory,
      redactStoredResponses: run.redactStoredResponses,
      env,
      envOptions,
    },
    { ...replay, resume: true }
  );
}

/**
 * Whether a regrade becomes the eval's latest run: only a regrade of a run
 * that collected every trial, and only when the latest run collected its
 * traces no later. A regrade of an older run leaves a newer run the latest.
 */
async function regradeTakesLatest(
  evalDirectory: string,
  replay: RunReplay
): Promise<boolean> {
  if (replay.run.phases.collect !== 'complete') return false;
  const latest = await readLatestRunId(evalDirectory);
  // Missing, or already a grading of these traces.
  if (
    latest === undefined ||
    latest.replace(/\.g\d+$/, '') === replay.gradedFrom
  )
    return true;
  let latestCollectedAt: string;
  try {
    const summary = JSON.parse(
      await fs.readFile(
        path.join(runsDirectory(evalDirectory), latest, 'summary.json'),
        'utf8'
      )
    ) as EvaluationSummary;
    latestCollectedAt = summary.collectedAt ?? summary.timestamp;
  } catch {
    // latest.json names a run that's gone: nothing newer to keep.
    return true;
  }
  return latestCollectedAt <= replay.collectedAt;
}

/**
 * Run an eval, or (with `replay`) grade the trials a run stored: the same
 * pipeline from datasets to report, with each trial's stored trace in place
 * of a client run.
 */
async function evaluate(
  options: RunEvalOptions,
  replay?: RunReplay
): Promise<RunEvalResult> {
  rejectRenamedOptions(
    options,
    { manifestPath: 'configPath', arm: 'variant', arms: 'variants' },
    'runEval'
  );
  // A regrade grades stored traces into a new run; a resume completes its run.
  const regrade = replay?.resume ? undefined : replay;
  const runStartTime = Date.now();
  const rootDir = options.rootDir ?? process.cwd();
  const configDir = path.dirname(path.resolve(options.configPath));
  const loadedConfig = loadEvalConfig(options.configPath, { rootDir });
  const ambientEnv = Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] => typeof entry[1] === 'string'
    )
  );
  // The secrets file's values: all a worker in an environment is sent.
  const fileSecrets = options.secretsFile
    ? await loadSecretsFile(
        path.isAbsolute(options.secretsFile)
          ? options.secretsFile
          : path.resolve(rootDir, options.secretsFile)
      )
    : {};
  const env = { ...ambientEnv, ...fileSecrets };

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
  // With the plugins loaded, so a plugin environment resolves too.
  const resolvedEnvironment = resolveEnvironment(
    options.env ?? LOCAL_ENVIRONMENT,
    options.envOptions ?? {}
  );
  const { definition: _definition, ...environment } = resolvedEnvironment;
  const inEnvironment = environment.name !== LOCAL_ENVIRONMENT;

  const executionId = replay?.runId ?? newRunId();
  // The eval's directory holds its runs (runs/<run-id>/) and latest.json.
  const evalDirectory =
    options.outputDir ??
    path.join(rootDir, '.mcp-test-results', evalConfig.name);
  const outputDir = path.join(runsDirectory(evalDirectory), executionId);
  const variants = replay
    ? replayedVariants(evalConfig, replay)
    : selectedVariants(evalConfig, options.variant);
  const datasets = evalConfig.datasets;
  const redact =
    options.redactStoredResponses ??
    (evalConfig.redactStoredResponses as boolean | undefined) ??
    REDACT_STORED_RESPONSES_BY_DEFAULT;
  /** The summary as the run stores it: redacted or not, never with local paths. */
  const storedSummaryOf = (summary: EvaluationSummary): EvaluationSummary =>
    withoutTrialArtifacts(
      redact ? redactStoredResponses(summary) : structuredClone(summary)
    );
  // Trials' client artifacts are copied before grading: into the run when it
  // keeps full traces, else into a directory removed once graders are done.
  let temporaryArtifacts: string | undefined;
  const artifactsRoot = async (): Promise<string> =>
    redact
      ? (temporaryArtifacts ??= await fs.mkdtemp(
          path.join(os.tmpdir(), 'mst-artifacts-')
        ))
      : outputDir;
  const removeArtifacts = async (): Promise<void> => {
    if (temporaryArtifacts)
      await fs.rm(temporaryArtifacts, { recursive: true, force: true });
    temporaryArtifacts = undefined;
  };
  // Before any client starts: an ungraded run is only worth its traces.
  if (options.grade === false && redact)
    throw new Error(
      'mst run --no-grade keeps the traces for mst grade, but this eval redacts stored responses, which leaves the answers and tool outputs out of them. Set "redactStoredResponses": false in the eval config.'
    );

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
      environment,
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

  // Keys the hashes of client options in run.json: comparable within this run only.
  const runKey = randomBytes(32);
  const variantResults: EvaluationVariantResult[] = [];
  // Judge settings whose preflight passed, across variants.
  const checkedJudges = new Set<string>();
  const allDatasets: RunEvalResult['datasets'] = [];
  const allResults: EvalCaseResult[] = [];
  // Saved with the first trial: from then on, run.json says how far the run got.
  let started: Promise<void> | undefined;
  // Trials an environment's shards didn't bring back: the run is partial.
  let missingTrials = 0;
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
  if (replay)
    assertReplayedCases(
      replay,
      canonicalDatasets.map(({ dataset }) => dataset)
    );
  const narrowing: CaseNarrowing = {
    cases: options.cases,
    filterTags: options.filterTags,
    maxCases: options.maxCases,
    trials: options.trials,
  };
  // Before any client starts: a fresh token for every connector server, kept
  // fresh until the run ends.
  // Grading stored traces starts no client, so it needs no tokens.
  const credentials: ConnectorCredentials = replay
    ? { env: {}, secrets: () => [], stop: async () => {} }
    : await startConnectorCredentials(
        connectors,
        options.credentialStore ?? localCredentialStore(),
        {
          configPath: options.configPath,
          variants: variants.map((variant) => variant.name),
        }
      );
  // A replay's servers only name the trace's tools: no secrets, no endpoint.
  const serverFor = (server: MCPConfig): MCPConfig =>
    replay ? server : resolveServerSecrets(server, env);
  try {
    Object.assign(env, credentials.env);
    const sourceServers = (
      options.mcpConfig
        ? [options.mcpConfig]
        : transportServers(sourceVariant.servers ?? evalConfig.servers)
    ).map(serverFor);
    if (!replay)
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

    // A variant's servers, client and settings, worked out once.
    const setups = new Map<string, ReturnType<typeof variantSetupOf>>();
    const variantSetupOf = (variant: EvalVariant) => {
      const servers = options.mcpConfig
        ? [options.mcpConfig]
        : transportServers(variant.servers ?? evalConfig.servers);
      const resolvedServers = servers.map(serverFor);
      if (!replay)
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
        coworkSetup: resolveCoworkSetupConfig(
          evalConfig.coworkSetup,
          variant.coworkSetup
        ),
        name: evalConfig.name,
        datasets: evalConfig.datasets,
      };
      const rawVariant = rawConfig.variants?.find(
        (candidate) => candidate.name === variant.name
      ) ?? { name: variant.name };
      const rawDeclaration = inheritClient(
        clientOf(rawConfig),
        clientPatchOf(rawVariant) ?? {}
      );
      return {
        servers,
        resolvedServers,
        clientConfig,
        effectiveConfig,
        rawVariant,
        rawDeclaration,
      };
    };
    const setupVariant = (variant: EvalVariant) => {
      let setup = setups.get(variant.name);
      if (!setup) setups.set(variant.name, (setup = variantSetupOf(variant)));
      return setup;
    };
    /** A dataset's cases as `variant` runs them; undefined when it runs none. */
    const variantDataset = (
      variant: EvalVariant,
      setup: ReturnType<typeof variantSetupOf>,
      dataset: EvalDataset
    ) => {
      const { effectiveConfig, rawVariant, rawDeclaration } = setup;
      // A regrade runs the stored run's cases; a run, the narrowed ones.
      const executionDataset = replay
        ? replayedCases(dataset, replay, variant.name)
        : narrowEvalCases(dataset, evalConfig, narrowing);
      if (executionDataset.cases.length === 0) return undefined;
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
            ? { input: template.replaceAll('{{input}}', evalCase.input) }
            : {}),
        })),
      };
      return { executionDataset, effectiveDataset };
    };

    /**
     * Collects every variant's trials in the environment, `shards` machines
     * at a time, saving each trial as it comes back. Ctrl-C stops the shards
     * and keeps what came back; a second Ctrl-C quits.
     */
    const collectEnvironmentTrials = async (): Promise<GatheredResults> => {
      if (connectors.uses.length > 0)
        throw new Error(
          `Connector servers can't run in "${environment.name}" yet: their tokens are kept on this machine.`
        );
      const groups: RequestGroup[] = [];
      const trialCases = new Map<
        string,
        { evalCase: EvalCase; datasetName: string; variant: EvalVariant }
      >();
      for (const variant of variants) {
        const setup = setupVariant(variant);
        if (
          variantToolMetadata(evalConfig, variant) &&
          usesToolSurfaceProxy(setup.clientConfig.definition)
        )
          throw new Error(
            `Variant "${variant.name}" sets tool metadata, which MST serves through a proxy on this machine, so it can't run in "${environment.name}" yet.`
          );
        for (const { dataset } of canonicalDatasets) {
          const prepared = variantDataset(variant, setup, dataset);
          if (!prepared) continue;
          // Before any shard starts: a judge that can't run fails the run
          // now, not after the shards have collected every trial.
          if (options.grade !== false)
            await preflightCaseJudges(
              prepared.effectiveDataset.cases,
              checkedJudges
            );
          for (const evalCase of prepared.effectiveDataset.cases)
            trialCases.set(`${variant.name}\u0000${evalCase.id}`, {
              evalCase,
              datasetName: prepared.effectiveDataset.name,
              variant,
            });
          // Servers as declared: a worker resolves their secrets itself. A
          // resume collects only the trials its run is missing.
          const requests = batchRequests(
            prepared.effectiveDataset.cases,
            setup.clientConfig.declaration,
            setup.servers,
            { evalConfig: setup.effectiveConfig }
          ).filter(
            (request) =>
              !replay ||
              isMissingTrial(
                replay.trials.get(variant.name)?.get(request.caseId)?.[
                  request.trial
                ]
              )
          );
          for (const type of new Set(requests.map((r) => r.config.type)))
            groups.push({
              variant,
              requests: requests.filter((r) => r.config.type === type),
            });
        }
      }
      const workerPlugins = [
        ...(loadedConfig.plugins ?? []).map((specifier) =>
          specifier.startsWith('.')
            ? path.resolve(configDir, specifier)
            : specifier
        ),
        ...(options.pluginPaths ?? []).map((specifier) =>
          specifier.startsWith('.')
            ? path.resolve(rootDir, specifier)
            : specifier
        ),
      ];
      const controller = new AbortController();
      let interrupts = 0;
      const onInterrupt = () => {
        if (++interrupts > 1) process.exit(130);
        console.error(
          '[mst] Stopping the shards; the trials that came back are kept (Ctrl-C again to quit now).'
        );
        controller.abort();
      };
      process.on('SIGINT', onInterrupt);
      const workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mst-shards-'));
      try {
        const result = await collectInEnvironment({
          environment: resolvedEnvironment,
          runId: executionId,
          evalConfig,
          plugins: workerPlugins,
          groups,
          secrets: fileSecrets,
          workDir,
          ...(evalConfig.limits ? { limits: evalConfig.limits } : {}),
          signal: controller.signal,
          log: (line) => console.error(`[mst] ${line}`),
          onResult: async (key, trace) => {
            const entry = trialCases.get(`${key.variant}\u0000${key.caseId}`);
            if (!entry) return;
            const { clientConfig, resolvedServers } = setupVariant(
              entry.variant
            );
            await saveTrial(
              {
                ...executedTrialResult(
                  entry.evalCase,
                  batchTraceExecution(
                    trace,
                    clientConfig.definition,
                    resolvedServers
                  ),
                  { datasetName: entry.datasetName },
                  0
                ),
                variant: key.variant,
              },
              key.trial
            );
          },
        });
        if (result.missing.length)
          console.error(
            `[mst] ${result.missing.length} trials are missing: the run is partial.`
          );
        return result;
      } finally {
        process.off('SIGINT', onInterrupt);
        await fs.rm(workDir, { recursive: true, force: true });
      }
    };

    // In an environment, every variant's trials are collected first, on
    // shards that each hold whole cases (ADR 0004); the loop below grades them.
    const gathered =
      inEnvironment && !regrade ? await collectEnvironmentTrials() : undefined;
    missingTrials = gathered?.missing.length ?? 0;

    // Where the running variant's results start, to drop them if it fails.
    let variantStart = { results: 0, datasets: 0 };
    try {
      for (const variant of variants) {
        variantStart = {
          results: allResults.length,
          datasets: allDatasets.length,
        };
        const setup = setupVariant(variant);
        const { servers, resolvedServers, clientConfig, effectiveConfig } =
          setup;
        const sourceResults: Array<{
          name: string;
          result: EvalRunnerResult;
        }> = [];
        const appliedPricing: Record<string, ModelPricing> = {};
        const unpricedModels = new Set<string>();
        const client =
          replay ||
          clientConfig.definition.run ||
          clientConfig.definition.runBatch
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
        const toolVariant =
          toolMetadata && !replay
            ? {
                id: toolMetadata.id,
                proxy: () =>
                  (proxy ??= startToolSurfaceProxy(
                    resolvedServers,
                    toolMetadata
                  )),
              }
            : undefined;

        try {
          for (const { source, dataset } of canonicalDatasets) {
            const prepared = variantDataset(variant, setup, dataset);
            if (!prepared) continue;
            const { executionDataset, effectiveDataset } = prepared;
            // Before this variant's client starts: a judge that can't run
            // (no SDK, no credential) fails the run, not every trial.
            if (options.grade !== false)
              await preflightCaseJudges(effectiveDataset.cases, checkedJudges);
            const sourceConfig = source;
            const runClient =
              typeof clientConfig.definition.run === 'function' ||
              typeof clientConfig.definition.runBatch === 'function';
            if (!replay && !runClient && effectiveDataset.cases.length > 0)
              throw new Error(
                `Client "${clientConfig.declaration.type}" has neither run() nor runBatch(), so it can't run cases.`
              );
            // The model each case runs on prices its usage and labels its result:
            // a case client's own, or the variant client's (including its default).
            const variantModel =
              clientConfig.declaration.model ??
              (clientConfig.config as { model?: unknown } | undefined)?.model;
            const batchStartTime = Date.now();
            const casesById = new Map(
              effectiveDataset.cases.map((evalCase) => [evalCase.id, evalCase])
            );
            const caseOptions = {
              datasetName: effectiveDataset.name,
              toolVariantId: toolMetadata?.id,
            };
            const batchTraces = replay
              ? undefined
              : gathered
                ? gatheredQueues(
                    gathered,
                    variant.name,
                    batchRequests(
                      effectiveDataset.cases,
                      clientConfig.declaration,
                      servers,
                      { evalConfig: effectiveConfig }
                    )
                  )
                : await prepareClientBatch(
                    clientConfig.definition,
                    effectiveDataset.cases,
                    clientConfig.declaration,
                    resolvedServers,
                    { evalConfig: effectiveConfig, variant, env },
                    toolVariant,
                    {
                      // A trace the client reports before its batch ends is saved
                      // as the trial it will be graded as.
                      onTrace: async (request, trace) => {
                        const evalCase = casesById.get(request.caseId);
                        if (!evalCase) return;
                        const execution = batchTraceExecution(
                          trace,
                          clientConfig.definition,
                          resolvedServers
                        );
                        await saveTrial(
                          {
                            ...executedTrialResult(
                              evalCase,
                              execution,
                              caseOptions,
                              0
                            ),
                            variant: variant.name,
                          },
                          request.trial
                        );
                      },
                    }
                  );
            // Batch execution (including shared setup/cleanup) precedes the runner's
            // wall clock. Count its elapsed time once, not the sum of request times.
            const batchDurationMs = batchTraces
              ? Date.now() - batchStartTime
              : 0;
            const result = await runEvalDataset(
              {
                dataset: effectiveDataset,
                client: clientConfig.declaration.type,
                ...(typeof variantModel === 'string'
                  ? { model: variantModel }
                  : {}),
                // The eval writes its own run directory, each trial as it
                // finishes.
                reporting: 'none',
                onTrialComplete: (caseResult, trial) =>
                  saveTrial({ ...caseResult, variant: variant.name }, trial),
                concurrency: evalConfig.concurrency ?? 1,
                defaultTrials: evalConfig.trials,
                defaultPassThreshold: evalConfig.passThreshold,
                toolOverrides: toolMetadata,
                toolMap: variant.toolMap ?? evalConfig.toolMap,
                ...(options.grade === false ? { grade: false } : {}),
                ...(replay || runClient
                  ? {
                      // Graders read a copy of the trial's client artifacts.
                      executeCase: withCopiedArtifacts(
                        replay
                          ? replayExecutor(
                              replay,
                              variant.name,
                              resolvedServers,
                              clientConfig.definition.evidence ?? 'none',
                              // A resume's missing trials, as collected again.
                              gathered
                                ? (caseId, trial) =>
                                    batchTraceExecution(
                                      gathered.result({
                                        variant: variant.name,
                                        caseId,
                                        trial,
                                      }),
                                      clientConfig.definition,
                                      resolvedServers
                                    )
                                : undefined
                            )
                          : createEvalCaseExecutor({
                              servers: resolvedServers,
                              client: clientConfig.declaration,
                              evalConfig: effectiveConfig,
                              variant,
                              env,
                              batchTraces,
                              toolVariant,
                            }),
                        await artifactsRoot(),
                        variant.name
                      ),
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
        // A long run (a desktop client takes hours) keeps what it has so far:
        // a crash or a kill later loses at most the variant that was running.
        if (variantResults.length < variants.length)
          await checkpoint('partial');
      }
    } catch (error) {
      // Keep the variants that finished, then report the failure. The
      // variant that failed is left out: run.json wouldn't list it.
      allResults.length = variantStart.results;
      allDatasets.length = variantStart.datasets;
      // Its trials that finished are already saved, and stay.
      if (variantResults.length > 0 || started) await checkpoint('failed');
      throw error;
    }
  } catch (error) {
    await removeArtifacts();
    throw error;
  } finally {
    await credentials.stop();
  }

  /**
   * Writes the run as it stands, before pairwise judging and the run's
   * comparisons: `collect: partial` while variants remain, `failed` when the
   * run stopped. The final write replaces it. Never costs the run its error.
   */
  async function checkpoint(phase: 'partial' | 'failed'): Promise<void> {
    try {
      const summary = buildSummary(undefined);
      const stored = storedSummaryOf(summary);
      await fs.mkdir(outputDir, { recursive: true });
      await writeRun(
        outputDir,
        executionId,
        runFacts(
          stored,
          // A regrade collected nothing: its traces are the source run's.
          regrade
            ? {
                collect: regrade.run.phases.collect,
                grade: phase === 'failed' ? 'failed' : 'partial',
              }
            : { collect: phase, grade: 'partial' }
        ),
        stored
      );
      if (options.report !== false) await writeRunReport(outputDir);
    } catch (error) {
      console.warn(
        `[mst] Couldn't save the run so far: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  /**
   * Saves one trial's trace when it finishes, as the run stores it. The
   * first also saves the run as it stands (`collect: partial`), so a run
   * that is killed says it didn't finish. Never costs the run its results.
   */
  async function saveTrial(
    result: EvalCaseResult,
    trial: number
  ): Promise<void> {
    try {
      await (started ??= checkpoint('partial'));
      await writeTrial(
        outputDir,
        executionId,
        redact ? redactStoredResponses(result) : result,
        trial
      );
    } catch (error) {
      console.warn(
        `[mst] Couldn't save trial ${trial} of ${result.id}: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  // Like the previous-run comparison, pairwise judging must never cost the
  // run its results.
  let pairwiseUsage: Partial<UsageMetrics> | undefined;
  if (!options.skipPairwise && options.grade !== false) {
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

  // Graders are done with the artifacts' copies; a run that redacts its
  // traces doesn't keep them.
  await removeArtifacts();

  const summary = buildSummary(pairwiseUsage);

  /** The run's summary from the variants that have run so far. */
  function buildSummary(
    pairwiseUsage: Partial<UsageMetrics> | undefined
  ): EvaluationSummary {
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
    const complete = allResults.filter((result) => !hasMissingTrial(result));
    const incomplete = allResults.length - complete.length;
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
        // A case with a missing trial is incomplete: neither passed nor failed.
        total: complete.length,
        passed: complete.filter((result) => result.pass).length,
        failed: complete.filter((result) => !result.pass).length,
        passRate: passRate({
          passed: complete.filter((result) => result.pass).length,
          total: complete.length,
        }),
        ...(incomplete > 0 ? { incomplete } : {}),
        ...computedMetrics,
      },
      telemetry,
      variantDeltas: buildVariantDeltas(variantResults),
      results: allResults,
    };

    summary.runId = executionId;
    // A regrade is as partial as the run whose traces it graded.
    const selection = replay
      ? (replay.run.selection as RunSelection | undefined)
      : runSelection(options);
    summary.partial = replay ? replay.run.partial : selection !== undefined;
    if (regrade) summary.collectedAt = regrade.collectedAt;
    if (options.grade === false) {
      summary.graded = false;
      // Nothing judged the answers, so there is no pass rate: only how many
      // cases collected every trial.
      const failedToCollect = allResults.filter((result) =>
        result.trialResults?.length
          ? result.trialResults.some((trial) => trial.error !== undefined)
          : result.error !== undefined
      ).length;
      summary.metrics = {
        total: allResults.length,
        collected: allResults.length - failedToCollect,
        failedToCollect,
      };
    }
    if (selection) {
      summary.selection = selection;
      summary.selectionHash = selectionHashOf(selection);
    }
    return summary;
  }

  /** What run.json records beyond the summary. */
  function runFacts(
    storedSummary: EvaluationSummary,
    phases: NonNullable<RunFacts['phases']>
  ): RunFacts {
    return {
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
      environment,
      // A collect-only run is never graded; the run's grading says so.
      phases:
        options.grade === false ? { ...phases, grade: 'skipped' } : phases,
      ...(regrade ? { gradedFrom: regrade.gradedFrom } : {}),
    };
  }
  const store = evalConfig.results?.store
    ? getResultStore(evalConfig.results.store.type).create(
        resolveStorePaths(evalConfig.results.store, { configDir, rootDir })
      )
    : undefined;
  // The comparison is a convenience: it must never cost the run its results.
  // An ungraded run has no results to compare.
  if (options.grade !== false)
    try {
      const previous = await findPreviousRun({
        configId: summary.configId,
        runId: executionId,
        // A regrade compares with the same traces' last grading.
        ...(regrade
          ? {
              regradeOf: {
                runId: regrade.gradedFrom,
                collectedAt: regrade.collectedAt,
              },
            }
          : {}),
        variants: summary.variants.map((variant) => variant.name),
        partial: summary.partial,
        selectionHash: summary.selectionHash,
        store,
        outputRoot: runsDirectory(evalDirectory),
      });
      if (previous)
        summary.previousRun = compareWithPrevious(previous, summary);
    } catch (error) {
      console.warn(
        `[mst] Couldn't compare with the previous run: ${error instanceof Error ? error.message : String(error)}`
      );
    }

  const storedSummary = storedSummaryOf(summary);
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
  await writeRun(
    outputDir,
    executionId,
    runFacts(storedSummary, {
      collect: regrade
        ? regrade.run.phases.collect
        : missingTrials > 0
          ? 'partial'
          : 'complete',
      // Trials a grader couldn't score are what a regrade would finish.
      grade: allResults.some(
        (result) =>
          result.gradingError !== undefined ||
          result.trialResults?.some((trial) => trial.gradingError !== undefined)
      )
        ? 'partial'
        : 'complete',
    }),
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
  // Last, so a crash leaves latest.json at the previous run; a partial or
  // ungraded run never becomes the latest, nor does a regrade of an older
  // run, nor a run with missing trials.
  if (
    !summary.partial &&
    missingTrials === 0 &&
    options.grade !== false &&
    (!regrade || (await regradeTakesLatest(evalDirectory, regrade)))
  )
    await writeLatest(evalDirectory, executionId, summary.timestamp);
  return {
    evalConfig,
    outputDir,
    environment,
    datasets: allDatasets,
    summary,
    ...(regrade ? { gradedFrom: regrade.gradedFrom } : {}),
  };
}
