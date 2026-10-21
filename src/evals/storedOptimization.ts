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
import { runEval } from './runEval.js';
import type { RunEvalOptions } from './runEval.js';
import { newRunId, readRunDirectory, runsDirectory } from './runFormat.js';
import type { RunRecord, StoredRun } from './runFormat.js';
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
interface StoredOptimizationTarget extends ToolOptimizationEval {
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
interface TriedRound {
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
function setupOf(variant: RunRecord['variants'][number]): string {
  const options = variant.clientOptions
    ? Object.fromEntries(
        Object.entries(variant.clientOptions).map(([key, value]) => [
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
 * How a round's run differs from the baseline's in what it measured with,
 * besides tool metadata: its datasets, and the base variant's client,
 * model, options and judges. Undefined when it doesn't.
 */
function setupChange(
  baseline: RunRecord,
  round: RunRecord
): string | undefined {
  const hashes = (run: RunRecord) =>
    JSON.stringify(run.datasets.map((d) => [d.name, d.contentHash]).sort());
  if (hashes(baseline) !== hashes(round))
    return 'its datasets changed (different cases or case content)';
  // Each judge with a hash of its options, so a changed rubric or threshold
  // shows even when the judge's type doesn't.
  const judges = (run: RunRecord) => JSON.stringify(run.judges ?? []);
  if (judges(baseline) !== judges(round))
    return "the eval config's judges or their options changed";
  const base = setupOf(baseline.variants[0]!);
  const changed = round.variants.find((variant) => setupOf(variant) !== base);
  return changed
    ? `the base variant's client, model, options or judges changed (seen on candidate "${changed.name}")`
    : undefined;
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
  const baselineResult = await runEval({
    ...runOptions,
    optimization: { id, role: 'baseline' },
    variants: (configVariants) => {
      const base = baseOf(configVariants, target.baseVariant);
      assertCandidateIds(base, options.plannedCandidates ?? []);
      baseName = base.name;
      return [base];
    },
  });
  const baselineRun = await readRun(
    evalDirectory,
    path.basename(baselineResult.outputDir)
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
  let groupingRunId: string | undefined;
  if (!state.declared) {
    const grouping = await runEval({
      ...runOptions,
      optimization: { id, role: 'grouping' },
      expectedServedTools: servedTools,
      variants: (configVariants) => [baseOf(configVariants, baseName)],
    });
    groupingRunId = path.basename(grouping.outputDir);
    const groupingRun = await readRun(evalDirectory, groupingRunId);
    groupWith(state, variantRun(groupingRun, baseName!, metric).result);
  }
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
    grouping: groupingRunId
      ? { source: 'grouping-run', runId: groupingRunId }
      : { source: 'declared' },
    rounds: [],
  };
  await writeOptimizationRecord(evalDirectory, record);
  return session(target, evalDirectory, record, state, baselineRun);
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
  if (record.grouping.source === 'grouping-run') {
    if (!record.grouping.runId)
      throw new Error(`Optimization ${id} names no grouping run.`);
    const groupingRun = await readRun(evalDirectory, record.grouping.runId);
    groupWith(
      state,
      variantRun(groupingRun, record.baseVariant, record.metric).result
    );
  }
  for (const round of record.rounds) {
    if (!round.runId) continue;
    const stored = await readRun(evalDirectory, round.runId);
    if (stored.run.phases.collect !== 'complete')
      throw new Error(
        `Round ${round.round}'s run ${round.runId} is missing trials. Complete it with mst run --resume ${round.runId} -c ${target.configPath}, then try again.`
      );
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

function session(
  target: StoredOptimizationTarget,
  evalDirectory: string,
  record: OptimizationRecord,
  state: OptimizationState,
  baselineRun: StoredRun
): StoredToolOptimization {
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
    // Rounds are scored in order, so a round after the scored ones that has
    // a run is one whose run is missing trials. Reopening refuses it too.
    const incomplete = record.rounds
      .slice(state.rounds.length)
      .find((round) => round.runId);
    if (incomplete)
      throw new Error(
        `Round ${incomplete.round}'s run ${incomplete.runId} is missing trials. Complete it with mst run --resume ${incomplete.runId} -c ${target.configPath}, then continue.`
      );
  };

  const runRound = async (
    roundRecord: OptimizationRoundRecord
  ): Promise<TriedRound> => {
    const candidates = roundRecord.candidates as ToolOverrideVariant[];
    let result;
    try {
      result = await runEval({
        ...runOptions,
        optimization: {
          id: record.id,
          role: 'round',
          round: roundRecord.round,
        },
        expectedServedTools: servedTools,
        variants: (configVariants) => {
          const base = baseOf(configVariants, record.baseVariant);
          return candidates.map((candidate) =>
            candidateVariant(base, candidate)
          );
        },
      });
    } catch (error) {
      if (error instanceof ServedToolsChangedError) {
        // Nothing ran, and nothing can be compared with the baseline again.
        record.rounds.splice(record.rounds.indexOf(roundRecord), 1);
        await save();
        throw new Error(
          `${error.message} The baseline was measured against other metadata, so this optimization can't continue: start a new one with mst optimize start.`,
          { cause: error }
        );
      }
      throw new Error(
        `Round ${roundRecord.round} didn't finish: ${error instanceof Error ? error.message : String(error)}. Run it again with mst optimize try --retry.`,
        { cause: error }
      );
    }
    const runId = path.basename(result.outputDir);
    const stored = await readRun(evalDirectory, runId);
    const change = setupChange(baselineRun.run, stored.run);
    if (change) {
      record.rounds.splice(record.rounds.indexOf(roundRecord), 1);
      await save();
      throw new Error(
        `Round ${roundRecord.round}'s run ${runId} can't be compared with the baseline: ${change} since the optimization started. Start a new optimization with mst optimize start.`
      );
    }
    if (stored.run.phases.collect !== 'complete') {
      roundRecord.runId = runId;
      await save();
      throw new Error(
        `Round ${roundRecord.round}'s run ${runId} is missing trials. Complete it with mst run --resume ${runId} -c ${target.configPath}, then continue.`
      );
    }
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
    async tryCandidates(candidates, options = {}) {
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
      const roundRecord: OptimizationRoundRecord = {
        round: record.rounds.length,
        createdAt: new Date().toISOString(),
        proposer: options.proposer ?? 'agent',
        candidates: variants as OptimizationRoundRecord['candidates'],
      };
      record.rounds.push(roundRecord);
      await save();
      return runRound(roundRecord);
    },
    async retry() {
      assertOpen();
      const stalled = pending();
      if (!stalled)
        throw new Error(`Optimization ${record.id} has no round to run again.`);
      return runRound(stalled);
    },
    standings() {
      return finishOptimizationState(
        state,
        (record.finished?.reason as ToolOptimizationReason | undefined) ??
          'finished'
      );
    },
    async finish(reason = 'finished') {
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
