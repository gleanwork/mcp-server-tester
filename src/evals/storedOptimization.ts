/**
 * A tool optimization kept on disk (ADR 0008): a record that names the runs
 * that measured its baseline and each round of candidates. Opening it scores
 * those runs again, so an optimization continues where it stopped, from any
 * process: `mst optimize start`, `try` and `finish`, or runToolOptimization
 * on an eval.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import packageJson from '../../package.json' with { type: 'json' };
import type { CredentialStore } from '../auth/grants/types.js';
import type { RegressionCheck } from '../types/reporter.js';
import type { EvalVariant } from './evalConfig.js';
import { loadEvalConfig } from './evalConfig.js';
import type { ToolOverrideVariant } from './evalRunner.js';
import {
  checkCandidates,
  checkEditableTools,
} from './optimizationCandidates.js';
import {
  OPTIMIZATION_FORMAT,
  findOptimization,
  optimizationDirectory,
  readOptimizationRecord,
  writeOptimizationRecord,
} from './optimizationFormat.js';
import type {
  OptimizationRecord,
  OptimizationRoundRecord,
} from './optimizationFormat.js';
import { renderRecommendation } from './optimizationReport.js';
import { withOptimizationLock } from './optimizationLock.js';
import { runEval } from './runEval.js';
import type { PlannedRun, RunEvalOptions } from './runEval.js';
import {
  RUN_ID_PATTERN,
  newRunId,
  readRunDirectory,
  runsDirectory,
} from './runFormat.js';
import type { RunOptimization, RunRecord, StoredRun } from './runFormat.js';
import { ServedToolsChangedError } from './servedTools.js';
import type { ListedServerTools } from './toolSurface.js';
import {
  addRound,
  finishOptimizationState,
  groupWith,
  judgeAgainstTried,
  proposerContextOf,
  startOptimizationState,
  variantMetric,
  variantsTriedOf,
  withinBudget,
} from './toolOptimization.js';
import type {
  EvalToolOptimizationOptions,
  OptimizationRun,
  OptimizationState,
  ProposeVariantsContext,
  ToolOptimizationEval,
  ToolOptimizationReason,
  ToolOptimizationResult,
  ToolOptimizationRound,
  VariantCandidateResult,
} from './toolOptimization.js';
import {
  DEFAULT_HELD_OUT_TAG,
  DEFAULT_REGRESSION_TAG,
} from './variantComparison.js';

/** The run-time narrowing every run of an optimization uses. */
interface OptimizationSelection {
  cases?: string[];
  filterTags?: string[];
  maxCases?: number;
  trials?: number;
}

/** Where an optimization's runs run, and with what. */
export interface StoredOptimizationTarget extends ToolOptimizationEval {
  /** The eval's directory (`mst run --output-dir`). Default: `.mcp-test-results/<eval name>`. */
  outputDir?: string;
  /** Where every run collects its trials (`--env`). Default: `local`. */
  env?: string;
  envOptions?: Readonly<Record<string, string>>;
  /** Credential store for connector servers, as `runEval`'s. */
  store?: string;
  credentialStore?: CredentialStore;
  /** A result store that also keeps every run, as `runEval`'s `results`. */
  results?: string;
}

/** Options for {@link startToolOptimization}. */
export interface StartToolOptimizationOptions {
  evalConfig: StoredOptimizationTarget;
  /**
   * The tools candidates may change: names on their servers, or
   * `server.tool`. Default: every tool the servers serve.
   */
  editableTools?: string[];
  /** As runToolOptimization's. @default 'passRate' */
  metric?: string;
  /** @default 'higher' */
  better?: 'higher' | 'lower';
  /** Most candidates to run, across every round. @default no limit */
  maxVariants?: number;
  allowRegressions?: boolean;
  regressionCheck?: RegressionCheck;
  regressionTag?: string;
  heldOutTag?: string;
  /** Narrowing for every run (`--case`, `--filter-tag`, `--max-cases`, `--trials`). */
  selection?: OptimizationSelection;
  /**
   * Candidates that will run in round 0: their ids are checked against the
   * base variant before the baseline runs, so a clash costs nothing.
   */
  plannedCandidates?: readonly ToolOverrideVariant[];
}

/** Options for {@link openToolOptimization}. */
export interface OpenToolOptimizationOptions {
  evalConfig: StoredOptimizationTarget;
  /** The optimization's id, or the end of it. Default: the latest. */
  id?: string;
}

/** A round's candidates were refused before they ran. */
export class CandidateError extends Error {
  override name = 'CandidateError';
  constructor(readonly problems: readonly string[]) {
    super(
      `The candidates can't run:\n${problems.map((problem) => `- ${problem}`).join('\n')}`
    );
  }
}

/** The optimization's variant budget, and what is left of it. */
interface OptimizationBudget {
  maxVariants?: number;
  tried: number;
  /** Infinity when there is no limit. */
  left: number;
}

/** What one `try` ran: the scored round, and how much it improved on the best before it. */
export interface TriedRound {
  round: ToolOptimizationRound;
  runId: string;
  improvement: number;
  best?: VariantCandidateResult;
}

/** A stored tool optimization, opened. */
export interface StoredToolOptimization {
  readonly id: string;
  /** `<eval dir>/optimizations/<id>/`. */
  readonly directory: string;
  /** The eval's directory: the optimization's runs are in its `runs/`. */
  readonly evalDirectory: string;
  readonly record: OptimizationRecord;
  readonly state: OptimizationState;
  /** The tools the servers served when the baseline ran. */
  readonly servedTools: readonly ListedServerTools[];
  readonly budget: OptimizationBudget;
  /** A round whose run didn't finish: `retry` runs it again. */
  readonly pendingRound?: OptimizationRoundRecord;
  /** What a proposer may see before the next round: no held-out cases. */
  proposerContext(): ProposeVariantsContext;
  /**
   * Checks candidates and runs them as the next round. Throws a
   * {@link CandidateError} before anything runs when one can't run or the
   * budget hasn't room for them all.
   */
  tryCandidates(
    candidates: unknown,
    options?: { proposer?: string }
  ): Promise<TriedRound>;
  /** Runs the pending round's candidates again. */
  retry(): Promise<TriedRound>;
  /**
   * The optimization scored so far: improvement judged against every
   * variant tried, as finishing would.
   */
  standings(): ToolOptimizationResult;
  /** Ends the optimization and writes its recommendation (recommendation.md). */
  finish(reason?: ToolOptimizationReason): Promise<ToolOptimizationResult>;
}

/** The eval directory runEval writes an eval config's runs to. */
function evalDirectoryOf(target: StoredOptimizationTarget): string {
  // As runEval resolves it: --output-dir from the working directory.
  if (target.outputDir) return path.resolve(target.outputDir);
  const rootDir = target.rootDir ?? process.cwd();
  const { name } = loadEvalConfig(target.configPath, {
    rootDir,
    skipDatasetValidation: true,
  });
  return path.resolve(rootDir, '.mcp-test-results', name);
}

/** The variant `baseVariant` names, or the config's baseline. */
function baseOf(
  configVariants: readonly EvalVariant[],
  baseVariant: string | undefined
): EvalVariant {
  const base =
    baseVariant === undefined ||
    (configVariants.length === 0 && baseVariant === 'default')
      ? (configVariants[0] ?? { name: 'default' })
      : configVariants.find((candidate) => candidate.name === baseVariant);
  if (!base)
    throw new Error(`The eval config has no variant named "${baseVariant}".`);
  return base;
}

/** A candidate as a variant: the base variant with the candidate's tool metadata. */
function candidateVariant(
  base: EvalVariant,
  candidate: ToolOverrideVariant
): EvalVariant {
  return {
    ...base,
    name: candidate.id,
    ...(candidate.description !== undefined
      ? { description: candidate.description }
      : {}),
    tools: candidate.tools,
  };
}

/** Throws unless the ids are unique and none is the base variant's name. */
function assertCandidateIds(
  base: EvalVariant,
  candidates: readonly ToolOverrideVariant[]
): void {
  const names = new Set<string>([base.name]);
  for (const candidate of candidates) {
    if (names.has(candidate.id))
      throw new Error(
        `Candidate ids must be unique and differ from the base variant's name; "${candidate.id}" repeats.`
      );
    names.add(candidate.id);
  }
}

/** runEval's options for every run of an optimization, without its variants. */
function runOptionsOf(
  target: StoredOptimizationTarget,
  selection: OptimizationSelection | undefined,
  environment: OptimizationRecord['environment']
): Omit<RunEvalOptions, 'variants'> {
  return {
    configPath: target.configPath,
    ...(target.rootDir ? { rootDir: target.rootDir } : {}),
    ...(target.outputDir ? { outputDir: target.outputDir } : {}),
    ...(target.pluginPaths ? { pluginPaths: target.pluginPaths } : {}),
    ...(target.plugins ? { plugins: target.plugins } : {}),
    ...(target.secretsFile ? { secretsFile: target.secretsFile } : {}),
    ...(target.store ? { store: target.store } : {}),
    ...(target.credentialStore
      ? { credentialStore: target.credentialStore }
      : {}),
    ...(target.results ? { results: target.results } : {}),
    ...(environment ? { env: environment.name } : {}),
    ...(environment?.options ? { envOptions: environment.options } : {}),
    ...(selection?.cases?.length ? { cases: selection.cases } : {}),
    ...(selection?.filterTags?.length
      ? { filterTags: selection.filterTags }
      : {}),
    ...(selection?.maxCases !== undefined
      ? { maxCases: selection.maxCases }
      : {}),
    ...(selection?.trials !== undefined ? { trials: selection.trials } : {}),
    // Rounds rank candidates by the metric; pairwise judges would only cost.
    skipPairwise: true,
    // Each run is opened on its own with mst open, which writes its report.
    report: false,
    recordServedTools: true,
  };
}

async function readRun(
  evalDirectory: string,
  runId: string
): Promise<StoredRun> {
  return readRunDirectory(path.join(runsDirectory(evalDirectory), runId));
}

/** A stored run's variant, with its value for the metric. */
function variantRun(
  stored: StoredRun,
  name: string,
  metric: string
): OptimizationRun {
  const variant = stored.summary.variants.find((v) => v.name === name);
  if (!variant?.result)
    throw new Error(
      `Run ${stored.run.runId} has no results for variant "${name}".`
    );
  return { result: variant.result, value: variantMetric(variant, metric) };
}

/**
 * The setup of a variant record a candidate must share with the base
 * variant. run.json keeps sensitive client options as an HMAC keyed for
 * that run, so across runs those are compared by name only.
 */
function setupOf(variant: Record<string, unknown>): string {
  const clientOptions = variant.clientOptions as
    | Record<string, unknown>
    | undefined;
  const options = clientOptions
    ? Object.fromEntries(
        Object.entries(clientOptions).map(([key, value]) => [
          key,
          typeof value === 'string' && value.startsWith('hmac:')
            ? 'hmac'
            : value,
        ])
      )
    : null;
  return JSON.stringify({
    client: variant.client ?? null,
    model: variant.model ?? null,
    clientOptions: options,
    inputTemplate: variant.inputTemplate ?? null,
    judges: variant.judges ?? null,
  });
}

/**
 * How a run about to start differs from the baseline in what it measures
 * with, besides tool metadata: its datasets, the eval config's judges, and
 * the base variant's client, model and options. Undefined when it doesn't.
 */
function setupChange(
  baseline: RunRecord,
  planned: PlannedRun
): string | undefined {
  const hashes = (datasets: PlannedRun['datasets']) =>
    JSON.stringify(datasets.map((d) => [d.name, d.contentHash]).sort());
  if (hashes(baseline.datasets) !== hashes(planned.datasets))
    return 'its datasets changed (different cases or case content)';
  // Each judge with a hash of its options, so a changed rubric or threshold
  // shows even when the judge's type doesn't.
  if (JSON.stringify(baseline.judges ?? []) !== JSON.stringify(planned.judges))
    return "the eval config's judges or their options changed";
  const base = setupOf(baseline.variants[0]!);
  const changed = planned.variants.find((variant) => setupOf(variant) !== base);
  return changed
    ? `the base variant's client, model, options or judges changed (seen on "${changed.name}")`
    : undefined;
}

/** A run's setup differs from the baseline's; nothing ran. */
class SetupChangedError extends Error {
  override name = 'SetupChangedError';
}

/** runEval's `beforeCollect` for a run that must match the baseline's setup. */
function sameSetupAs(baseline: RunRecord): (planned: PlannedRun) => void {
  return (planned) => {
    const change = setupChange(baseline, planned);
    if (change) throw new SetupChangedError(change);
  };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * The newest complete run of this optimization in this role (and round)
 * that started no earlier than `since` (a run id's time stamp).
 */
async function completeRunOf(
  evalDirectory: string,
  marker: RunOptimization,
  since: string
): Promise<StoredRun | undefined> {
  const ids = await fs
    .readdir(runsDirectory(evalDirectory))
    .catch(() => [] as string[]);
  const candidates = ids
    .filter((id) => RUN_ID_PATTERN.test(id) && !id.includes('.g'))
    .filter((id) => id.slice(0, since.length) >= since)
    .sort()
    .reverse();
  for (const id of candidates) {
    const run = (await readRun(evalDirectory, id).catch(() => undefined))?.run;
    if (
      run?.optimization?.id === marker.id &&
      run.optimization.role === marker.role &&
      run.optimization.round === marker.round &&
      run.phases.collect === 'complete' &&
      run.phases.grade === 'complete'
    )
      return readRun(evalDirectory, id);
  }
  return undefined;
}

/**
 * One run of the optimization. When runEval throws after it stored the run
 * complete (a result store that couldn't take it, say), that run is kept
 * rather than collected again. A refused setup or changed tools throw.
 */
async function measure(
  evalDirectory: string,
  options: RunEvalOptions & { optimization: RunOptimization }
): Promise<StoredRun> {
  // The start time to the second, as run ids begin.
  const since = newRunId().slice(0, 'YYYYMMDDTHHMMSSZ'.length);
  try {
    const result = await runEval(options);
    return await readRun(evalDirectory, path.basename(result.outputDir));
  } catch (error) {
    if (
      error instanceof ServedToolsChangedError ||
      error instanceof SetupChangedError
    )
      throw error;
    const kept = await completeRunOf(
      evalDirectory,
      options.optimization,
      since
    );
    if (!kept) throw error;
    console.warn(
      `[mst] The optimization keeps run ${kept.run.runId}, which is complete, though the step then failed: ${messageOf(error)}`
    );
    return kept;
  }
}

function servedToolsOf(stored: StoredRun): ListedServerTools[] {
  const served = stored.run.variants[0]?.servedTools;
  if (!served)
    throw new Error(
      `Run ${stored.run.runId} didn't record its servers' tools, so it can't be an optimization's baseline.`
    );
  return served as unknown as ListedServerTools[];
}

/**
 * Starts a tool optimization on an eval: runs the base variant (the
 * baseline), and a second time to group the cases when none is tagged
 * `regression`, reads the tools the servers serve, and writes the record.
 */
export async function startToolOptimization(
  options: StartToolOptimizationOptions
): Promise<StoredToolOptimization> {
  const target = options.evalConfig;
  const evalDirectory = evalDirectoryOf(target);
  const id = newRunId();
  const metric = options.metric ?? 'passRate';
  const better = options.better ?? 'higher';
  if (
    options.maxVariants !== undefined &&
    (!Number.isInteger(options.maxVariants) || options.maxVariants < 1)
  )
    throw new Error(
      `maxVariants must be a positive integer, got ${options.maxVariants}.`
    );
  const environment = target.env
    ? {
        name: target.env,
        ...(target.envOptions && Object.keys(target.envOptions).length
          ? { options: { ...target.envOptions } }
          : {}),
      }
    : undefined;
  const runOptions = runOptionsOf(target, options.selection, environment);
  let baseName: string | undefined;
  const baselineRun = await measure(evalDirectory, {
    ...runOptions,
    optimization: { id, role: 'baseline' },
    variants: (configVariants) => {
      const base = baseOf(configVariants, target.baseVariant);
      assertCandidateIds(base, options.plannedCandidates ?? []);
      baseName = base.name;
      return [base];
    },
  });
  baseName ??= baselineRun.run.variants[0]?.name;
  // Candidates compared with missing baseline trials would be compared with
  // fewer cases than they ran, and the run isn't resumed (its tools would
  // go unchecked).
  if (baselineRun.run.phases.collect !== 'complete')
    throw new Error(
      `The baseline run ${baselineRun.run.runId} is missing trials, so an optimization can't start from it. Run mst optimize start again.`
    );
  const servedTools = servedToolsOf(baselineRun);
  if (options.editableTools?.length)
    checkEditableTools(options.editableTools, servedTools);
  const rules = {
    regressionCheck: options.regressionCheck ?? 'significant',
    regressionTag: options.regressionTag ?? DEFAULT_REGRESSION_TAG,
    heldOutTag: options.heldOutTag ?? DEFAULT_HELD_OUT_TAG,
    allowRegressions: options.allowRegressions ?? false,
  } satisfies OptimizationRecord['rules'];
  // Throws now when the base variant reports no value for the metric.
  const state = startOptimizationState(
    variantRun(baselineRun, baseName!, metric),
    metric,
    better,
    rules
  );
  const now = new Date().toISOString();
  const record: OptimizationRecord = {
    format: OPTIMIZATION_FORMAT,
    kind: 'optimization',
    id,
    evalName: baselineRun.run.evalName,
    createdAt: now,
    updatedAt: now,
    mst: { version: packageJson.version },
    baseVariant: baseName!,
    ...(options.editableTools?.length
      ? { editableTools: [...options.editableTools] }
      : {}),
    metric,
    better,
    ...(options.maxVariants !== undefined
      ? { maxVariants: options.maxVariants }
      : {}),
    rules,
    ...(options.selection && Object.keys(options.selection).length
      ? { selection: { ...options.selection } }
      : {}),
    ...(environment ? { environment } : {}),
    baseline: { runId: baselineRun.run.runId },
    // A grouping run without a run id is still to run.
    grouping: { source: state.declared ? 'declared' : 'grouping-run' },
    rounds: [],
  };
  // Stored before the grouping run, so a stop there doesn't cost the baseline.
  await writeOptimizationRecord(evalDirectory, record);
  const optimization = session(
    target,
    evalDirectory,
    record,
    state,
    baselineRun
  );
  if (!state.declared)
    try {
      await optimization.groupCases();
    } catch (error) {
      if (error instanceof OptimizationEndedError) throw error;
      throw new Error(
        `Optimization ${id} is stored, but its grouping run didn't finish: ${messageOf(error)} The next mst optimize try runs it again.`,
        { cause: error }
      );
    }
  return optimization;
}

/**
 * Opens a stored tool optimization and scores its runs again. Throws when a
 * round's run is incomplete, with how to complete it.
 */
export async function openToolOptimization(
  options: OpenToolOptimizationOptions
): Promise<StoredToolOptimization> {
  const target = options.evalConfig;
  const evalDirectory = evalDirectoryOf(target);
  const id = await findOptimization(evalDirectory, options.id);
  const record = await readOptimizationRecord(
    optimizationDirectory(evalDirectory, id)
  );
  const baselineRun = await readRun(evalDirectory, record.baseline.runId);
  const state = startOptimizationState(
    variantRun(baselineRun, record.baseVariant, record.metric),
    record.metric,
    record.better,
    record.rules
  );
  // Without a run id, the grouping run is still to run: the next round runs it.
  if (record.grouping.source === 'grouping-run' && record.grouping.runId) {
    const groupingRun = await readRun(evalDirectory, record.grouping.runId);
    groupWith(
      state,
      variantRun(groupingRun, record.baseVariant, record.metric).result
    );
  }
  for (const round of record.rounds) {
    if (!round.runId) continue;
    const stored = await readRun(evalDirectory, round.runId);
    if (stored.run.phases.collect !== 'complete') {
      // Not resumed: the round runs again, with its tools checked again.
      delete round.runId;
      break;
    }
    addRound(
      state,
      round.candidates as ToolOverrideVariant[],
      round.candidates.map((candidate) =>
        variantRun(stored, candidate.id, record.metric)
      )
    );
  }
  judgeAgainstTried(state);
  return session(target, evalDirectory, record, state, baselineRun);
}

/** A session, with the grouping step startToolOptimization runs itself. */
interface OptimizationSession extends StoredToolOptimization {
  /** Runs the grouping run, when it is still to run. */
  groupCases(): Promise<void>;
}

/** The optimization can't continue: the next step is a new optimization. */
class OptimizationEndedError extends Error {
  override name = 'OptimizationEndedError';
}

/**
 * The error for a run the optimization can't use, ever: the servers' tools
 * or the run's setup changed since the baseline. Undefined for others.
 */
function cantContinue(
  error: unknown,
  what: string
): OptimizationEndedError | undefined {
  if (error instanceof ServedToolsChangedError)
    return new OptimizationEndedError(
      `${error.message} The baseline was measured against other metadata, so this optimization can't continue: start a new one with mst optimize start.`,
      { cause: error }
    );
  if (error instanceof SetupChangedError)
    return new OptimizationEndedError(
      `${what} can't be compared with the baseline: ${error.message} since the optimization started. Nothing ran. Start a new optimization with mst optimize start.`,
      { cause: error }
    );
  return undefined;
}

function session(
  target: StoredOptimizationTarget,
  evalDirectory: string,
  record: OptimizationRecord,
  state: OptimizationState,
  baselineRun: StoredRun
): OptimizationSession {
  const servedTools = servedToolsOf(baselineRun);
  const directory = optimizationDirectory(evalDirectory, record.id);
  const runOptions = runOptionsOf(target, record.selection, record.environment);
  const pending = () => record.rounds.find((round) => !round.runId);
  const budget = (): OptimizationBudget => {
    const tried = variantsTriedOf(state);
    return {
      ...(record.maxVariants !== undefined
        ? { maxVariants: record.maxVariants }
        : {}),
      tried,
      left:
        record.maxVariants === undefined
          ? Number.POSITIVE_INFINITY
          : Math.max(0, record.maxVariants - tried),
    };
  };
  const save = async () => {
    record.updatedAt = new Date().toISOString();
    await writeOptimizationRecord(evalDirectory, record);
  };
  const assertOpen = () => {
    if (record.finished)
      throw new Error(
        `Optimization ${record.id} is finished. Start a new one with mst optimize start.`
      );
  };
  /**
   * Runs one step holding the optimization's lock, refusing a record that
   * another process changed since this one read it.
   */
  const locked = <T>(step: string, fn: () => Promise<T>): Promise<T> =>
    withOptimizationLock(directory, record.id, step, async () => {
      const onDisk = await readOptimizationRecord(directory);
      if (onDisk.updatedAt !== record.updatedAt)
        throw new Error(
          `Optimization ${record.id} changed since this process read it (another process stepped it). Open it again.`
        );
      return fn();
    });

  const groupCases = async () => {
    if (record.grouping.source !== 'grouping-run' || record.grouping.runId)
      return;
    let grouping: StoredRun;
    try {
      grouping = await measure(evalDirectory, {
        ...runOptions,
        optimization: { id: record.id, role: 'grouping' },
        expectedServedTools: servedTools,
        beforeCollect: sameSetupAs(baselineRun.run),
        variants: (configVariants) => [
          baseOf(configVariants, record.baseVariant),
        ],
      });
    } catch (error) {
      throw cantContinue(error, 'The grouping run') ?? error;
    }
    if (grouping.run.phases.collect !== 'complete')
      throw new Error(
        `The grouping run ${grouping.run.runId} is missing trials, so it can't group the cases.`
      );
    groupWith(
      state,
      variantRun(grouping, record.baseVariant, record.metric).result
    );
    record.grouping = { source: 'grouping-run', runId: grouping.run.runId };
    await save();
  };

  /** The grouping, when it is still to run, before any round. */
  const groupBeforeRound = async () => {
    try {
      await groupCases();
    } catch (error) {
      if (error instanceof OptimizationEndedError) throw error;
      throw new Error(
        `The grouping run didn't finish: ${messageOf(error)} Run the same mst optimize try again.`,
        { cause: error }
      );
    }
  };

  const runRound = async (
    roundRecord: OptimizationRoundRecord
  ): Promise<TriedRound> => {
    const candidates = roundRecord.candidates as ToolOverrideVariant[];
    let stored: StoredRun;
    try {
      stored = await measure(evalDirectory, {
        ...runOptions,
        optimization: {
          id: record.id,
          role: 'round',
          round: roundRecord.round,
        },
        expectedServedTools: servedTools,
        beforeCollect: sameSetupAs(baselineRun.run),
        variants: (configVariants) => {
          const base = baseOf(configVariants, record.baseVariant);
          return candidates.map((candidate) =>
            candidateVariant(base, candidate)
          );
        },
      });
    } catch (error) {
      const ended = cantContinue(error, `Round ${roundRecord.round}`);
      if (ended) {
        // Nothing ran, and nothing can be compared with the baseline again.
        record.rounds.splice(record.rounds.indexOf(roundRecord), 1);
        await save();
        throw ended;
      }
      throw new Error(
        `Round ${roundRecord.round} didn't finish: ${messageOf(error)}. Run it again with mst optimize try --retry.`,
        { cause: error }
      );
    }
    const runId = stored.run.runId;
    // Not resumed (its tools would go unchecked): the round stays to run again.
    if (stored.run.phases.collect !== 'complete')
      throw new Error(
        `Round ${roundRecord.round}'s run ${runId} is missing trials, so it isn't scored. Run the round again with mst optimize try --retry.`
      );
    roundRecord.runId = runId;
    const { improvement, best } = addRound(
      state,
      candidates,
      candidates.map((candidate) =>
        variantRun(stored, candidate.id, record.metric)
      )
    );
    // Each candidate's verdict, corrected for every variant tried so far.
    judgeAgainstTried(state);
    await save();
    return {
      round: state.rounds.at(-1)!,
      runId,
      improvement,
      ...(best ? { best } : {}),
    };
  };

  return {
    id: record.id,
    directory,
    evalDirectory,
    record,
    state,
    servedTools,
    get budget() {
      return budget();
    },
    get pendingRound() {
      return pending();
    },
    proposerContext() {
      return proposerContextOf(state, state.rounds.length);
    },
    groupCases() {
      return locked('run the grouping run', groupCases);
    },
    tryCandidates(candidates, options = {}) {
      return locked('run a round', async () => {
        assertOpen();
        const stalled = pending();
        if (stalled)
          throw new Error(
            `Round ${stalled.round} didn't finish. Run it again with mst optimize try --retry, or finish the optimization.`
          );
        const { variants, problems } = checkCandidates(candidates, {
          servedTools,
          ...(record.editableTools
            ? { editableTools: record.editableTools }
            : {}),
          takenIds: new Set([
            record.baseVariant,
            ...record.rounds.flatMap((round) =>
              round.candidates.map((c) => c.id)
            ),
          ]),
        });
        if (problems.length) throw new CandidateError(problems);
        if (variants.length === 0)
          throw new CandidateError(['There are no candidates to run.']);
        const { left, maxVariants } = budget();
        if (variants.length > left)
          throw new CandidateError([
            `The budget is ${maxVariants} variants and ${maxVariants! - left} ran, so ${left} more can run, not ${variants.length}.`,
          ]);
        await groupBeforeRound();
        const roundRecord: OptimizationRoundRecord = {
          round: record.rounds.length,
          createdAt: new Date().toISOString(),
          proposer: options.proposer ?? 'agent',
          candidates: variants as OptimizationRoundRecord['candidates'],
        };
        record.rounds.push(roundRecord);
        await save();
        return runRound(roundRecord);
      });
    },
    retry() {
      return locked('run a round again', async () => {
        assertOpen();
        const stalled = pending();
        if (!stalled)
          throw new Error(
            `Optimization ${record.id} has no round to run again.`
          );
        await groupBeforeRound();
        return runRound(stalled);
      });
    },
    standings() {
      return finishOptimizationState(
        state,
        (record.finished?.reason as ToolOptimizationReason | undefined) ??
          'finished'
      );
    },
    finish(reason = 'finished') {
      return locked('finish', async () => {
        assertOpen();
        // A round that never ran measured nothing.
        record.rounds = record.rounds.filter((round) => round.runId);
        const result = finishOptimizationState(state, reason);
        record.finished = {
          at: new Date().toISOString(),
          reason,
          ...(result.proposal
            ? {
                recommendation: result.proposal.recommendation,
                variantId: result.proposal.variantId,
              }
            : {}),
        };
        await save();
        await fs.writeFile(
          path.join(directory, 'recommendation.md'),
          renderRecommendation({
            record,
            result,
            servedTools,
          })
        );
        return result;
      });
    },
  };
}

/**
 * runToolOptimization on an eval: a stored optimization stepped by the
 * caller's static variants and proposer, then finished.
 */
export async function runStoredToolOptimization(
  options: EvalToolOptimizationOptions & StoredOptimizationOptions
): Promise<ToolOptimizationResult> {
  const optimization = await startToolOptimization({
    evalConfig: options.evalConfig,
    ...(options.metric !== undefined ? { metric: options.metric } : {}),
    ...(options.better !== undefined ? { better: options.better } : {}),
    ...(options.maxVariants !== undefined
      ? { maxVariants: options.maxVariants }
      : {}),
    ...(options.allowRegressions !== undefined
      ? { allowRegressions: options.allowRegressions }
      : {}),
    ...(options.regressionCheck !== undefined
      ? { regressionCheck: options.regressionCheck }
      : {}),
    ...(options.regressionTag !== undefined
      ? { regressionTag: options.regressionTag }
      : {}),
    ...(options.heldOutTag !== undefined
      ? { heldOutTag: options.heldOutTag }
      : {}),
    ...(options.editableTools ? { editableTools: options.editableTools } : {}),
    ...(options.selection ? { selection: options.selection } : {}),
    ...(options.variants ? { plannedCandidates: options.variants } : {}),
  });
  const maxRounds = options.maxRounds ?? 1;
  const minImprovement = options.minImprovement ?? 0;
  let reason: ToolOptimizationReason = 'max-rounds';
  for (let round = 0; round < maxRounds; round++) {
    const { left, tried } = optimization.budget;
    if (left <= 0) {
      reason = 'max-variants';
      break;
    }
    const proposed =
      round === 0 && options.variants?.length
        ? options.variants
        : options.proposeVariants
          ? await options.proposeVariants(optimization.proposerContext())
          : [];
    const variants = withinBudget(
      proposed,
      options.maxVariants ?? Number.POSITIVE_INFINITY,
      tried
    );
    if (variants.length === 0) {
      reason = round === 0 ? 'no-variants' : 'no-improvement';
      break;
    }
    const { improvement, best } = await optimization.tryCandidates(variants, {
      proposer: round === 0 && options.variants?.length ? 'given' : 'callback',
    });
    if (best && improvement < minImprovement) {
      reason = 'no-improvement';
      break;
    }
    if (optimization.budget.left <= 0) {
      reason = 'max-variants';
      break;
    }
  }
  return optimization.finish(reason);
}

/** What an eval optimization takes beyond runToolOptimization's options. */
export interface StoredOptimizationOptions {
  editableTools?: string[];
  selection?: OptimizationSelection;
}
