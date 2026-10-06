/**
 * Judge a saved run: the judges run on the responses a run already stored,
 * without running the cases again. Used to add or change a judge, to judge
 * where the run happened (a VM, CI) had no judge credentials, and to judge
 * with evidence (`trial.artifactsDir`) collected after the run.
 */

import { existsSync, statSync } from 'node:fs';
import path from 'node:path';
import type { EvalCaseResult } from '../types/reporter.js';
import type { EvalCase } from './datasetTypes.js';
import {
  evaluateJudges,
  mergeSuiteJudges,
  resolveJudges,
} from './expectations.js';
import {
  caseJudgeUsage,
  type JudgeCaseSource,
} from '../judge/judgeContract.js';

export interface JudgeSavedRunOptions {
  /** The saved run's case results, with their responses. */
  caseResults: readonly EvalCaseResult[];
  /**
   * Judges to run, as the manifest lists them: parsed (`judges`) and before
   * parsing (`rawJudges`), as `mst run` merges them into each case.
   */
  judges: Array<Record<string, unknown>>;
  rawJudges?: Array<Record<string, unknown>>;
  /**
   * The dataset cases, by id, for the ground truth results don't carry
   * (`expected`, `canonicalAnswer`, metadata). A result whose case is not
   * here is judged from its saved request.
   */
  cases?: ReadonlyMap<string, EvalCase>;
  /**
   * Where the run's evidence directories were copied. A result's
   * `response.artifactsName` names its directory here; judges read it as
   * `trial.artifactsDir`.
   */
  artifactsRoot?: string;
  /** Cases judged at once. @default 4 */
  concurrency?: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * The evidence directory for a saved response, or undefined. The name must
 * be one path segment, so a result can't point outside the root.
 */
export function savedArtifactsDir(
  response: unknown,
  root: string | undefined
): string | undefined {
  if (root === undefined || !isRecord(response)) return undefined;
  const name = response.artifactsName;
  if (
    typeof name !== 'string' ||
    name === '' ||
    name === '.' ||
    name === '..' ||
    name !== path.basename(name) ||
    name.includes('\\')
  )
    return undefined;
  const dir = path.join(path.resolve(root), name);
  return existsSync(dir) && statSync(dir).isDirectory() ? dir : undefined;
}

/** A saved response with its evidence directory, as judges received it live. */
export function withSavedArtifacts(
  response: unknown,
  root: string | undefined
): unknown {
  const dir = savedArtifactsDir(response, root);
  if (dir === undefined || !isRecord(response)) return response;
  const { artifactsName: _name, ...rest } = response;
  return { ...rest, artifactsDir: dir };
}

/** The case a result came from: the dataset's, else its saved request. */
function caseOf(
  result: EvalCaseResult,
  cases: ReadonlyMap<string, EvalCase> | undefined
): EvalCase {
  const known = cases?.get(result.id);
  if (known) return known;
  const request = result.request;
  return {
    id: result.id,
    ...(request?.scenario !== undefined && { scenario: request.scenario }),
    ...(request?.args !== undefined && { args: request.args }),
    ...(result.toolName && { toolName: result.toolName }),
    ...(request?.reference !== undefined && {
      canonicalAnswer: request.reference,
    }),
    tags: result.tags ?? request?.tags ?? [],
  } as EvalCase;
}

function looksLikeHostResponse(value: unknown): boolean {
  return (
    isRecord(value) &&
    (typeof value.response === 'string' ||
      Array.isArray(value.events) ||
      Array.isArray(value.toolCalls))
  );
}

async function judgeOne(
  result: EvalCaseResult,
  options: JudgeSavedRunOptions
): Promise<EvalCaseResult> {
  // A case that failed to run was never judged; judging it now would grade
  // a response it didn't give.
  if (result.error) return result;
  const evalCase = caseOf(result, options.cases);
  const passesJudge = mergeSuiteJudges(
    evalCase,
    options.judges,
    options.rawJudges ?? options.judges
  );
  const judges = resolveJudges({
    ...evalCase,
    expect: { ...evalCase.expect, passesJudge } as EvalCase['expect'],
  });
  const expectations = { ...result.expectations };
  if (result.response === undefined) {
    // Redacted results keep no response: there is nothing to judge.
    expectations.judge = {
      pass: false,
      details:
        'The saved result has no response: the run stored redacted results. ' +
        'Run with `redactStoredResponses: false` to judge saved runs.',
    };
  } else {
    const response = withSavedArtifacts(result.response, options.artifactsRoot);
    expectations.judge = await evaluateJudges(response, judges, {
      evalCase: evalCase as JudgeCaseSource,
      ...(looksLikeHostResponse(response) && { hostResponse: response }),
      ...(result.hostEvidence !== undefined && {
        evidence: result.hostEvidence,
      }),
    });
  }
  const judgeUsage = caseJudgeUsage(expectations.judge);
  const { judgeUsage: _old, ...rest } = result;
  return {
    ...rest,
    expectations,
    pass: Object.values(expectations).every(
      (expectation) => expectation === undefined || expectation.pass
    ),
    ...(judgeUsage !== undefined && { judgeUsage }),
  };
}

/**
 * Runs `judges` on each saved result and returns the results with their
 * `judge` expectation, `pass` and `judgeUsage` replaced. Other expectations
 * are kept as the run graded them. A result that errored is returned as is.
 */
export async function judgeSavedRun(
  options: JudgeSavedRunOptions
): Promise<EvalCaseResult[]> {
  const results = options.caseResults;
  const out = new Array<EvalCaseResult>(results.length);
  let next = 0;
  const limit = Math.max(1, Math.min(options.concurrency ?? 4, results.length));
  await Promise.all(
    Array.from({ length: limit }, async () => {
      while (next < results.length) {
        const i = next++;
        out[i] = await judgeOne(results[i]!, options);
      }
    })
  );
  return out;
}
