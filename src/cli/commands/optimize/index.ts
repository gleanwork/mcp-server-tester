/**
 * `mst optimize`: a tool optimization an agent (or a person) steps through
 * (ADR 0008). `start` measures the current metadata, `evidence` shows what
 * the next candidates can learn from, `try` runs a round of them, and
 * `finish` writes the recommendation. The optimization is stored with the
 * eval's runs, so each command is its own process.
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { parseEnvOptions } from '../../../evals/environments/envOptions.js';
import {
  buildEvidence,
  renderEvidence,
} from '../../../evals/optimizationReport.js';
import {
  openToolOptimization,
  startToolOptimization,
} from '../../../evals/storedOptimization.js';
import type {
  StoredOptimizationTarget,
  StoredToolOptimization,
  TriedRound,
} from '../../../evals/storedOptimization.js';
import type {
  ToolOptimizationReason,
  VariantCandidateResult,
} from '../../../evals/toolOptimization.js';
import type { RegressionCheck } from '../../../types/reporter.js';

/** The flags every `mst optimize` command takes to find the eval. */
export interface OptimizeTargetOptions {
  config: string;
  plugins?: string[];
  rootDir?: string;
  outputDir?: string;
  secretsFile?: string;
  store?: string;
  results?: string;
  /** `--id`: the optimization, or the end of its id. Default: the latest. */
  id?: string;
}

export interface OptimizeStartOptions extends Omit<
  OptimizeTargetOptions,
  'id'
> {
  /** `--variant`: the config variant the candidates build on. */
  variant?: string;
  /** `--tool`: the tools candidates may change. */
  tool?: string[];
  metric?: string;
  better?: string;
  maxVariants?: string | number;
  regressionCheck?: string;
  allowRegressions?: boolean;
  case?: string[];
  filterTag?: string[];
  maxCases?: string | number;
  trials?: string | number;
  env?: string;
  envOption?: string[];
}

export interface OptimizeEvidenceOptions extends OptimizeTargetOptions {
  json?: boolean;
}

export interface OptimizeTryOptions extends OptimizeTargetOptions {
  /** `--retry`: run the round that didn't finish again. */
  retry?: boolean;
  /** `--proposer`: who wrote the candidates, for the record. Default: agent. */
  proposer?: string;
}

/** The variant budget `start` gives an optimization unless `--max-variants` says otherwise. */
const DEFAULT_MAX_VARIANTS = 6;

function positiveInteger(flag: string, value: string | number): number {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1)
    throw new Error(`${flag} must be a positive integer, got "${value}"`);
  return number;
}

function targetOf(
  options: OptimizeTargetOptions & {
    env?: string;
    envOption?: string[];
  }
): StoredOptimizationTarget {
  return {
    configPath: options.config,
    ...(options.rootDir ? { rootDir: options.rootDir } : {}),
    ...(options.outputDir ? { outputDir: options.outputDir } : {}),
    ...(options.plugins?.length ? { pluginPaths: options.plugins } : {}),
    ...(options.secretsFile ? { secretsFile: options.secretsFile } : {}),
    ...(options.store ? { store: options.store } : {}),
    ...(options.results ? { results: options.results } : {}),
    ...(options.env ? { env: options.env } : {}),
    ...(options.envOption?.length
      ? { envOptions: parseEnvOptions(options.envOption) }
      : {}),
  };
}

/** A word as a shell reads it back: quoted when it holds more than path characters. */
function shellWord(word: string): string {
  return /^[\w@%+=:,./-]+$/.test(word)
    ? word
    : `'${word.replaceAll("'", `'\\''`)}'`;
}

/**
 * How the commands that continue an optimization are spelled for this eval:
 * every flag that finds it, or that its runs need, as this command got it.
 */
function continueFlags(options: OptimizeTargetOptions, id: string): string {
  const flag = (name: string, value: string | undefined) =>
    value ? `${name} ${shellWord(value)}` : '';
  return [
    flag('-c', options.config),
    options.plugins?.length
      ? `--plugins ${options.plugins.map(shellWord).join(' ')}`
      : '',
    flag('--output-dir', options.outputDir),
    flag('--root-dir', options.rootDir === '.' ? undefined : options.rootDir),
    flag('--secrets-file', options.secretsFile),
    flag('--store', options.store),
    flag('--results', options.results),
    `--id ${id}`,
  ]
    .filter(Boolean)
    .join(' ');
}

function formatValue(metric: string, value: number): string {
  return metric === 'passRate' || metric === 'trialPassRate'
    ? `${(value * 100).toFixed(1)}%`
    : Number.isInteger(value)
      ? String(value)
      : value.toFixed(3);
}

function formatDelta(metric: string, delta: number): string {
  const sign = delta >= 0 ? '+' : '-';
  const size = Math.abs(delta);
  return metric === 'passRate' || metric === 'trialPassRate'
    ? `${sign}${(size * 100).toFixed(1)} pts`
    : `${sign}${Number.isInteger(size) ? size : size.toFixed(3)}`;
}

function verdict(candidate: VariantCandidateResult): string {
  if (candidate.metricUnavailable) return 'no value for the metric';
  if (candidate.disqualified)
    return `disqualified: broke ${candidate.measurement.brokenCaseIds.join(', ') || 'regression cases'}`;
  return candidate.fixes ? 'clearly better' : 'not clearly better';
}

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

function describeBudget(optimization: StoredToolOptimization): string {
  const { tried, left, maxVariants } = optimization.budget;
  return maxVariants === undefined
    ? `${tried} candidates tried, no budget`
    : `${tried} of ${maxVariants} candidates tried, ${left} left`;
}

/** `mst optimize start`: run the baseline and store the optimization. */
export async function optimizeStart(
  options: OptimizeStartOptions
): Promise<void> {
  const better = options.better ?? 'higher';
  if (better !== 'higher' && better !== 'lower')
    throw new Error(`--better must be higher or lower, got "${better}"`);
  const regressionCheck = options.regressionCheck ?? 'significant';
  if (regressionCheck !== 'significant' && regressionCheck !== 'any-case')
    throw new Error(
      `--regression-check must be significant or any-case, got "${regressionCheck}"`
    );
  const maxVariants =
    options.maxVariants === undefined
      ? DEFAULT_MAX_VARIANTS
      : positiveInteger('--max-variants', options.maxVariants);
  const target = targetOf(options);
  const optimization = await startToolOptimization({
    evalConfig: {
      ...target,
      ...(options.variant ? { baseVariant: options.variant } : {}),
    },
    ...(options.tool?.length ? { editableTools: options.tool } : {}),
    ...(options.metric ? { metric: options.metric } : {}),
    better,
    maxVariants,
    regressionCheck: regressionCheck satisfies RegressionCheck,
    ...(options.allowRegressions ? { allowRegressions: true } : {}),
    selection: {
      ...(options.case?.length ? { cases: options.case } : {}),
      ...(options.filterTag?.length ? { filterTags: options.filterTag } : {}),
      ...(options.maxCases !== undefined
        ? { maxCases: positiveInteger('--max-cases', options.maxCases) }
        : {}),
      ...(options.trials !== undefined
        ? { trials: positiveInteger('--trials', options.trials) }
        : {}),
    },
  });
  const { record, state } = optimization;
  const flags = continueFlags(options, optimization.id);
  console.log(`Started tool optimization ${optimization.id}.`);
  console.log(
    `Baseline (${record.baseVariant}, run ${record.baseline.runId}): ${record.metric} ${formatValue(record.metric, state.baselineValue)}.`
  );
  console.log(
    record.grouping.source === 'declared'
      ? `Regression cases: the ones tagged ${record.rules.regressionTag}.`
      : `Regression cases: the ones the base variant passed in a second run (${record.grouping.runId}).`
  );
  const heldOut =
    state.baseline.caseResults.length - state.seenBaseline.caseResults.length;
  if (heldOut)
    console.log(
      `${plural(heldOut, `case tagged ${record.rules.heldOutTag} is`, `cases tagged ${record.rules.heldOutTag} are`)} held out: candidates are never ranked on them.`
    );
  console.log(`Budget: ${describeBudget(optimization)}.`);
  console.log(
    `Stored in ${path.relative(process.cwd(), optimization.directory) || '.'}.`
  );
  console.log('');
  console.log(`Next: mst optimize evidence ${flags}`);
}

/** `mst optimize evidence`: what the next candidates can learn from. */
export async function optimizeEvidence(
  options: OptimizeEvidenceOptions
): Promise<void> {
  const optimization = await openToolOptimization({
    evalConfig: targetOf(options),
    ...(options.id ? { id: options.id } : {}),
  });
  const evidence = buildEvidence(optimization);
  if (options.json) {
    console.log(JSON.stringify(evidence, null, 2));
    return;
  }
  process.stdout.write(renderEvidence(evidence));
  if (optimization.pendingRound)
    console.log(
      `\nRound ${optimization.pendingRound.round} didn't finish: run it again with mst optimize try --retry ${continueFlags(options, optimization.id)}.`
    );
  if (optimization.record.finished)
    console.log(
      `\nThis optimization is finished: see ${path.join(optimization.directory, 'recommendation.md')}.`
    );
}

/** The candidates a `try` file holds: an array, or `{ candidates: [...] }`. */
async function readCandidates(file: string): Promise<unknown> {
  const text =
    file === '-'
      ? await new Promise<string>((resolve, reject) => {
          let data = '';
          process.stdin.setEncoding('utf8');
          process.stdin.on('data', (chunk: string) => (data += chunk));
          process.stdin.on('end', () => resolve(data));
          process.stdin.on('error', reject);
        })
      : await readFile(path.resolve(file), 'utf8');
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error(
      `${file === '-' ? 'stdin' : file} isn't JSON: ${error instanceof Error ? error.message : String(error)}`
    );
  }
  if (
    parsed &&
    typeof parsed === 'object' &&
    !Array.isArray(parsed) &&
    'candidates' in parsed
  )
    return (parsed as { candidates: unknown }).candidates;
  return parsed;
}

function printRound(
  optimization: StoredToolOptimization,
  tried: TriedRound,
  options: OptimizeTargetOptions
): void {
  const { metric } = optimization.record;
  console.log(`Round ${tried.round.round} (run ${tried.runId}):`);
  const width = Math.max(
    ...tried.round.candidates.map((candidate) => candidate.variant.id.length)
  );
  for (const candidate of tried.round.candidates)
    console.log(
      `  ${candidate.variant.id.padEnd(width)}  ${formatValue(metric, candidate.metricValue).padStart(7)}  ${formatDelta(metric, candidate.metricDelta).padStart(11)}  ${verdict(candidate)}`
    );
  const best = optimization.state.bestSoFar;
  console.log(
    best
      ? `Best so far: ${best.variant.id}, ${formatValue(metric, best.metricValue)} (${formatDelta(metric, best.metricDelta)} vs baseline).`
      : 'No candidate beats the baseline yet.'
  );
  console.log(
    `"Clearly better" allows for the ${plural(optimization.budget.tried, 'candidate', 'candidates')} tried so far; each candidate tried makes it stricter.`
  );
  console.log(`Budget: ${describeBudget(optimization)}.`);
  const flags = continueFlags(options, optimization.id);
  console.log('');
  console.log(
    optimization.budget.left > 0
      ? `Next: mst optimize evidence ${flags}, then try another round, or mst optimize finish ${flags}`
      : `The budget is spent. Next: mst optimize finish ${flags}`
  );
}

/** `mst optimize try <file>`: run a round of candidates. */
export async function optimizeTry(
  file: string | undefined,
  options: OptimizeTryOptions
): Promise<void> {
  if (options.retry && file)
    throw new Error('Give a candidates file or --retry, not both.');
  if (!options.retry && !file)
    throw new Error(
      'Give a candidates file (JSON: [{ "id", "description", "tools" }], or - for stdin), or --retry.'
    );
  const optimization = await openToolOptimization({
    evalConfig: targetOf(options),
    ...(options.id ? { id: options.id } : {}),
  });
  const tried = options.retry
    ? await optimization.retry()
    : await optimization.tryCandidates(await readCandidates(file!), {
        ...(options.proposer ? { proposer: options.proposer } : {}),
      });
  printRound(optimization, tried, options);
}

/** `mst optimize finish`: end the optimization and write its recommendation. */
export async function optimizeFinish(
  options: OptimizeTargetOptions
): Promise<void> {
  const optimization = await openToolOptimization({
    evalConfig: targetOf(options),
    ...(options.id ? { id: options.id } : {}),
  });
  const reason: ToolOptimizationReason =
    optimization.budget.left <= 0 ? 'max-variants' : 'finished';
  const result = await optimization.finish(reason);
  const proposal = result.proposal;
  const file = path.join(optimization.directory, 'recommendation.md');
  if (!proposal)
    console.log('No candidates ran, so there is nothing to recommend.');
  else if (proposal.recommendation === 'apply')
    console.log(
      `Apply ${proposal.variantId}: ${formatDelta(result.metric, proposal.delta)} on ${result.metric}, clearly better than the current metadata.`
    );
  else if (proposal.recommendation === 'reject')
    console.log(
      `Reject: the best candidate, ${proposal.variantId}, breaks cases that work today.`
    );
  else
    console.log(
      `Inconclusive: the best candidate, ${proposal.variantId} (${formatDelta(result.metric, proposal.delta)}), is not clearly better than the current metadata.`
    );
  console.log(`Recommendation: ${path.relative(process.cwd(), file) || file}`);
}
