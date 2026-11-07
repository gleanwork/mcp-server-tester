/**
 * An eval's history (`history.json`, `mst.history/v1`): a row per run with
 * what it ran with and what each variant measured. Written and derived by
 * `src/evals/runHistory.ts`; the history page renders it.
 */
import type { RunSelection } from '../evals/evalFrameworkTypes.js';
import type { PairedChange } from './reporter.js';

/** How a run ended, as far as its history row is concerned. */
export type HistoryRunStatus =
  /** Every trial collected and graded. */
  | 'complete'
  /** Some case is short a trial or a verdict, or the run was saved before it finished. */
  | 'incomplete'
  /** Collected with `--no-grade`: no pass rates. */
  | 'ungraded'
  /** Stopped on an error. */
  | 'failed';

/** A judge's results on one variant in one run. */
export interface HistoryJudge {
  /** Trials the judge gave a verdict on (not `unknown`). */
  trials: number;
  passRate?: number;
  /** Mean score, on the judge's own scale. */
  meanScore?: number;
  /** Trials it answered `unknown`. */
  unknown?: number;
}

/**
 * A pairwise judge's results for a variant against a reference. The key in
 * `HistoryVariant.pairwise` is `<judge> vs <reference>`: today the reference
 * is always a variant of the same run (`variant:<name>`); a comparison with
 * another run's variant would be `run:<run-id>/<name>`.
 */
export interface HistoryPairwise {
  judge: string;
  /** What the variant was compared with. */
  reference: { variant: string; runId?: string };
  compared: number;
  wins: number;
  ties: number;
  losses: number;
  errors: number;
  /** (wins + ties / 2) / compared. */
  winRate?: number;
  /** A 95% Wilson interval on `winRate`, counting a tie as half a win. */
  low?: number;
  high?: number;
}

/** One variant in one run: its setup and its measurements. */
export interface HistoryVariant {
  name: string;
  baseline: boolean;
  client?: string;
  model?: string;
  /** Its servers' labels (or URLs and commands, for unlabelled ones). */
  servers: string[];
  /** The client apps its trials recorded: `Claude 2.31226.1`. */
  clientApps?: string[];
  /**
   * A hash of what the variant ran with besides the client app: client,
   * model, options, servers, tool metadata, input template and judges.
   * Option values a run records only as a keyed hash count as unknown.
   */
  setupHash: string;
  /** Complete cases: the ones pass rates count. */
  cases: number;
  /** Cases short a trial or a verdict (ADR 0010). */
  incomplete?: number;
  /** Share of complete cases that passed. */
  casePassRate?: number;
  /** Share of trials that passed, averaged over cases. */
  trialPassRate?: number;
  /**
   * The run report's headline pass rate (capability cases, or regression
   * cases when every case is tagged regression) with its likely range.
   */
  headline?: {
    group: 'capability' | 'regression';
    cases: number;
    passRate: number;
    low?: number;
    high?: number;
  };
  /** By judge name. */
  judges: Record<string, HistoryJudge>;
  /** By `<judge> vs <reference>`. */
  pairwise: Record<string, HistoryPairwise>;
  /** Mean cost of a trial, each case weighted equally (`cost_usd_mean`). */
  costUsd?: number;
  costSource?: 'client' | 'pricing' | 'mixed';
  unpricedModels?: string[];
  /** Mean tokens of a trial, each case weighted equally. */
  tokens?: {
    input?: number;
    output?: number;
    cacheRead?: number;
    cacheCreation?: number;
  };
  /** Trial wall time, over trials (not infrastructure failures). */
  durationMs?: { p50: number; p95: number; mean: number };
  /** Tool calls and MCP calls in a trial (`tool_count_mean`, `mcp_call_count_mean`). */
  toolCalls?: number;
  mcpCalls?: number;
  /** Attempts made: trials and infrastructure failures. */
  attempts: number;
  /** Attempts that were infrastructure failures (not trials). */
  infrastructureFailures: number;
  /** Trials in which the client reported an error. */
  clientErrors: number;
  /**
   * Each complete case's counted trials: `[passed, trials, case passed]`
   * (1 or 0). What a comparison between two runs pairs.
   */
  outcomes: Record<string, [number, number, 0 | 1]>;
  /** The variant's era: it starts again when its setup or the eval's measuring changes. */
  era?: number;
  /** Its change since the previous complete run of its era (`previous`). */
  sincePrevious?: HistorySincePrevious;
}

/** A variant's change since the previous comparable run: the same test `mst run` reports. */
export interface HistorySincePrevious {
  runId: string;
  passRateDelta?: number;
  trialPassRateDelta?: number;
  /** The headline pass rate's paired change, tested over cases. */
  change?: PairedChange;
  /** The change was tested and is clearly worse. */
  regressed: boolean;
  /** Cases that passed then and fail now, and the other way. */
  regressedCases: string[];
  improvedCases: string[];
}

/** Something that differs from the previous full run. */
export interface HistoryChange {
  /** What changed, in words: `judge changed: rubric`. */
  reason: string;
  /** The variant it is about; absent for the whole eval. */
  variant?: string;
  /** Whether it ends the era: runs on either side aren't compared. */
  breaks: boolean;
}

/** One run directory. */
export interface HistoryRun {
  runId: string;
  /** The run that collected the transcripts: `runId` without `.g<n>`. */
  collectedRunId: string;
  /** When its transcripts were collected: what history is ordered by. */
  collectedAt: string;
  createdAt: string;
  finishedAt: string;
  status: HistoryRunStatus;
  phases: {
    collect: 'complete' | 'partial' | 'skipped' | 'failed';
    grade: 'complete' | 'partial' | 'skipped' | 'failed';
  };
  /** Narrowed at run time (`--variant`, `--case`, …): never compared with full runs. */
  partial: boolean;
  selection?: RunSelection;
  selectionHash?: string;
  configId: string;
  contentHash: string;
  mstVersion: string;
  /** The regrade's source run, for a regrade. */
  gradedFrom?: string;
  /** The newer grading of the same transcripts that replaces this one. */
  supersededBy?: string;
  /** Other gradings of the same transcripts, on the row that shows them. */
  gradings?: string[];
  /** Where the trials were collected (`--runner`). */
  runner?: string;
  baseline: string;
  datasets: Array<{
    name: string;
    caseCount: number;
    contentHash: string;
    type?: string;
    source?: 'snapshot' | 'live';
    snapshot?: string;
  }>;
  /** Every case ID any variant ran, sorted. */
  caseIds: string[];
  caseIdsHash: string;
  /** Case IDs tagged `regression`. */
  regressionCases?: string[];
  trialsPerCase: { min: number; max: number };
  /** The eval config's judges: what each verdict means. */
  judges: Array<{
    type: string;
    level: string;
    identity?: string;
    optionsHash: string;
  }>;
  redacted: boolean;
  /** The run's dry-run proxies answered writes with a success reply (`simulateWrites`). */
  simulateWrites?: true;
  variants: HistoryVariant[];
  /** The eval-wide era; full runs only. */
  era?: number;
  /** What differs from the previous full run. */
  changes?: HistoryChange[];
  /** The version of the code that built the row. */
  builder: number;
}

/** A run directory the history leaves out, and why. */
export interface HistorySkippedRun {
  runId: string;
  reason: string;
}

/** `history.json`. */
export interface HistoryIndex {
  format: 'mst.history/v1';
  kind: 'history';
  evalName: string;
  updatedAt: string;
  /** Newest first, by `collectedAt`. */
  runs: HistoryRun[];
  skipped: HistorySkippedRun[];
}
