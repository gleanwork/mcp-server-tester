import { runEvalDataset } from './evalRunner.js';
import type {
  EvalRunnerOptions,
  EvalContext,
  EvalRunnerResult,
} from './evalRunner.js';
import type { EvalCaseResult } from '../types/reporter.js';

/** Outcome of comparing two servers on a single eval case. */
export type ComparisonOutcome = 'A_WINS' | 'B_WINS' | 'TIE' | 'BOTH_FAIL';

/** Result of comparing a single eval case across two servers. */
export interface CaseComparisonResult {
  /** Case ID */
  id: string;
  /** Comparison outcome */
  outcome: ComparisonOutcome;
  /** Result from server A */
  serverA: EvalCaseResult;
  /** Result from server B */
  serverB: EvalCaseResult;
}

/** Aggregated result of running a dataset against two servers. */
export interface ServerComparisonResult {
  /** Dataset name */
  dataset: string;
  /** Total cases compared (cases present in both runs) */
  total: number;
  /** Cases where server A passed and server B failed */
  aWins: number;
  /** Cases where server B passed and server A failed */
  bWins: number;
  /** Cases where both passed */
  ties: number;
  /** Cases where both failed */
  bothFail: number;
  /** Raw count of cases where both servers failed (same as bothFail) */
  bothFailCount: number;
  /** Cases with a decisive outcome (aWins + bWins + ties, excludes BOTH_FAIL) */
  decidedCases: number;
  /** Fraction of total cases where both servers failed (bothFail / total) */
  failureAlignment: number;
  /** A win rate (aWins / decidedCases, excludes BOTH_FAIL) */
  aWinRate: number;
  /** B win rate (bWins / decidedCases, excludes BOTH_FAIL) */
  bWinRate: number;
  /** Tie rate (ties / decidedCases, excludes BOTH_FAIL) */
  tieRate: number;
  /** Per-case comparison results */
  cases: CaseComparisonResult[];
  /** Full result from server A */
  serverAResult: EvalRunnerResult;
  /** Full result from server B */
  serverBResult: EvalRunnerResult;
  /** Total duration in milliseconds */
  durationMs: number;
}

/**
 * Options for `runServerComparison`.
 * Same as `EvalRunnerOptions` without baseline-specific fields.
 */
export type ServerComparisonOptions = Omit<
  EvalRunnerOptions,
  'saveResultsTo' | 'baselineResultsFrom'
>;

/**
 * Runs the same eval dataset against two MCP servers in parallel and
 * returns a detailed per-case comparison of results.
 *
 * Both servers receive identical cases and options. The comparison uses
 * simple pass/fail per case: A_WINS means A passed and B failed, etc.
 *
 * @param options - Eval dataset and runner options (shared between both servers)
 * @param contextA - MCP context for server A (e.g., Glean MCP)
 * @param contextB - MCP context for server B (e.g., native MCP)
 * @returns Comparison result with per-case outcomes and aggregate win rates
 *
 * @example
 * ```typescript
 * const comparison = await runServerComparison(
 *   { dataset },
 *   { mcp: gleanMcpFixture },
 *   { mcp: nativeMcpFixture }
 * );
 * console.log(`Glean MCP wins: ${(comparison.aWinRate * 100).toFixed(1)}%`);
 * console.log(`Native MCP wins: ${(comparison.bWinRate * 100).toFixed(1)}%`);
 * ```
 */
export async function runServerComparison(
  options: ServerComparisonOptions,
  contextA: EvalContext,
  contextB: EvalContext
): Promise<ServerComparisonResult> {
  const startTime = Date.now();

  // Run both servers concurrently
  const [resultA, resultB] = await Promise.all([
    runEvalDataset(options, contextA),
    runEvalDataset(options, contextB),
  ]);

  // Index results by case ID for O(1) lookup
  const mapA = new Map<string, EvalCaseResult>(
    resultA.caseResults.map((r) => [r.id, r])
  );
  const mapB = new Map<string, EvalCaseResult>(
    resultB.caseResults.map((r) => [r.id, r])
  );

  // Compare only cases present in both results
  const sharedIds = [...mapA.keys()].filter((id) => mapB.has(id));

  let aWins = 0;
  let bWins = 0;
  let ties = 0;
  let bothFail = 0;
  const cases: CaseComparisonResult[] = [];

  for (const id of sharedIds) {
    const a = mapA.get(id)!;
    const b = mapB.get(id)!;

    let outcome: ComparisonOutcome;
    if (a.pass && b.pass) {
      outcome = 'TIE';
      ties++;
    } else if (a.pass && !b.pass) {
      outcome = 'A_WINS';
      aWins++;
    } else if (!a.pass && b.pass) {
      outcome = 'B_WINS';
      bWins++;
    } else {
      outcome = 'BOTH_FAIL';
      bothFail++;
    }

    cases.push({ id, outcome, serverA: a, serverB: b });
  }

  const total = cases.length;
  const decidedCases = aWins + bWins + ties; // BOTH_FAIL excluded from win rate denominator

  return {
    dataset: options.dataset.name,
    total,
    aWins,
    bWins,
    ties,
    bothFail,
    bothFailCount: bothFail,
    decidedCases,
    failureAlignment: total > 0 ? bothFail / total : 0,
    aWinRate: decidedCases > 0 ? aWins / decidedCases : 0,
    bWinRate: decidedCases > 0 ? bWins / decidedCases : 0,
    tieRate: decidedCases > 0 ? ties / decidedCases : 0,
    cases,
    serverAResult: resultA,
    serverBResult: resultB,
    durationMs: Date.now() - startTime,
  };
}
