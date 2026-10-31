/**
 * The one way a judge runs, for every caller (matchers, validators, eval
 * assertions and eval configs) and every judge (the built-in `rubric`
 * judge and plugin judges).
 */
import type { ValidationResult } from '../assertions/validators/types.js';
import type { TraceEvidence } from '../evals/evalFrameworkTypes.js';
import { parseExtensionOptions } from '../plugins/plugin.js';
import { settingsFor, type SettingsSections } from '../plugins/settings.js';
import { getJudge } from './builtinJudges.js';
import { judgeIdentity, judgeIsVersioned } from './judgeIdentity.js';
import {
  buildJudgeCase,
  buildJudgeTrial,
  checkJudgeScore,
  missingRequirement,
  sumJudgeUsage,
  type CheckedJudgeScore,
  type JudgeCaseSource,
  type JudgeInput,
} from './judgeContract.js';

/** The case and run a dataset judge grades. Matchers pass none. */
export interface JudgeRun {
  /** The case as written in the dataset. */
  evalCase?: JudgeCaseSource;
  /** The client response as reported, with built-in tool names. */
  clientResponse?: unknown;
  /** How the client trace was observed. */
  evidence?: TraceEvidence;
  /** The eval's plugin settings; the judge gets its plugin's (ADR 0008). */
  settings?: SettingsSections;
}

/** Minimum judge score that passes when no threshold is given. */
export const DEFAULT_JUDGE_THRESHOLD = 0.7;

/**
 * Keys that belong to the assertion or to routing, never to a judge's
 * options: what to run, against what, how often, and the pass mark.
 */
const ASSERTION_KEYS = new Set([
  'type',
  'name',
  'judge',
  'options',
  'reference',
  'threshold',
  'reps',
]);

/** An assertion's flat fields without the assertion and routing keys. */
export function judgeOwnOptions(
  entry: Record<string, unknown>
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(entry).filter(([key]) => !ASSERTION_KEYS.has(key))
  );
}

export interface JudgeRequest {
  /** A built-in judge such as `rubric`, or `<namespace>/judge/<name>` from a plugin. */
  judge: string;
  /** The judge's options, before its schema parses them. */
  options: Record<string, unknown>;
  /** What messages and results call the judge. */
  label: string;
  reference?: unknown;
  threshold: number;
  /** Times the judge scores the response; the scores are averaged. */
  reps: number;
}

/**
 * Checks, without calling a model, that the judge a request names exists,
 * accepts its options and (when it has a `preflight`) can run. Throws
 * naming the judge and what's wrong.
 */
export async function preflightJudgeRequest(
  request: JudgeRequest,
  settings?: SettingsSections
): Promise<void> {
  try {
    const judge = getJudge(request.judge);
    const options = parseExtensionOptions(
      judge.schema,
      request.options,
      `judge options "${request.judge}"`
    );
    await judge.preflight?.(options, {
      settings: settingsFor(settings, request.judge),
    });
  } catch (error) {
    throw new Error(
      `Judge "${request.label}" can't run: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

/** Score spread above which the rubric is probably ambiguous. */
const HIGH_VARIANCE = 0.2;

/**
 * Runs a judge `reps` times and checks the result against the threshold.
 *
 * The judge gets `{ case, trial }` built from `run` and the response. When a
 * path in its `requires` is missing, it is not called and the result is
 * skipped. A rep that skips ends the run as skipped. A rep that answers
 * `unknown` is left out; when every rep does, the result is unknown: not a
 * pass, and not a score. Otherwise the mean score of the reps that answered
 * is reported; pass is that mean against the threshold, or the majority of
 * their pass/fail when the judge returns its own `pass`.
 *
 * A judge that can't score (unknown judge, bad options, a throw, an invalid
 * score) is an error, marked with `details.error`, not a score.
 */
export async function evaluateJudge(
  response: unknown,
  request: JudgeRequest,
  run: JudgeRun = {}
): Promise<ValidationResult> {
  const { label, threshold, reps } = request;
  try {
    const judge = getJudge(request.judge);
    const options = parseExtensionOptions(
      judge.schema,
      request.options,
      `judge options "${request.judge}"`
    );
    const input: JudgeInput = {
      case: buildJudgeCase(run.evalCase, request.reference),
      trial: buildJudgeTrial(response, run),
    };
    const context = { settings: settingsFor(run.settings, request.judge) };
    // What every score records about the judge that gave it (ADR 0009).
    const identity: JudgeIdentityDetails = {
      judgeIdentity: judgeIdentity(request.judge, judge, request.options, {
        threshold,
        reps,
      }),
      ...(judgeIsVersioned(request.judge, judge)
        ? {}
        : { judgeUnversioned: true as const }),
    };
    const missing = missingRequirement(input, judge.requires);
    if (missing !== undefined)
      return judgeSkipped(label, identity, `no ${missing}`, undefined);

    const repScores: CheckedJudgeScore[] = [];
    for (let i = 0; i < reps; i++) {
      let repScore: CheckedJudgeScore;
      try {
        repScore = checkJudgeScore(
          await judge.evaluate(input, options, context),
          threshold
        );
      } catch (err) {
        return judgeError(
          `Judge "${label}" error: ${err instanceof Error ? err.message : String(err)}`,
          label
        );
      }
      repScores.push(repScore);
      if (repScore.skipped)
        return judgeSkipped(
          label,
          identity,
          repScore.reasoning,
          sumJudgeUsage(repScores.map((v) => v.usage)),
          repScore.metadata
        );
    }
    const usage = sumJudgeUsage(repScores.map((v) => v.usage));
    const answered = repScores.filter((v) => v.unknown !== true);
    const last = answered.at(-1);
    if (!last) {
      const final = repScores.at(-1);
      if (!final)
        return judgeError(`Judge "${label}" error: no scores collected`, label);
      return judgeUnknown(label, identity, final, usage);
    }

    const scores = answered.map((v) => v.score);
    const score = mean(scores);
    // A judge that decides pass/fail itself wins by majority over the reps;
    // otherwise the mean score meets the threshold or not.
    const judgeDecides = answered.some((v) => v.judgePass !== undefined);
    const passed = judgeDecides
      ? answered.filter((v) => v.pass).length * 2 > answered.length
      : score >= threshold;
    const spread = answered.length > 1 ? scoreSpread(scores, score) : undefined;
    const unknownReps = repScores.length - answered.length;
    const repNote =
      reps > 1
        ? ` (mean of ${answered.length} reps: [${scores.map((s) => s.toFixed(2)).join(', ')}]${unknownReps > 0 ? `; ${unknownReps} unknown` : ''})`
        : '';
    if (spread !== undefined && spread > HIGH_VARIANCE)
      console.warn(
        `[mcp-server-tester] Judge "${label}" scores have high variance ` +
          `(stdDev=${spread.toFixed(2)}, scores=[${scores.map((s) => s.toFixed(2)).join(', ')}]). ` +
          `The rubric may be ambiguous.`
      );

    return {
      pass: passed,
      message: passed
        ? `Judge "${label}" passed with score ${score.toFixed(2)}${repNote}`
        : `Judge "${label}" failed with score ${score.toFixed(2)} (threshold: ${threshold})${repNote}. ${last.reasoning ?? ''}`,
      details: {
        judgeName: label,
        ...identity,
        score,
        reasoning: last.reasoning,
        ...(last.provider !== undefined
          ? { judgeProvider: last.provider }
          : {}),
        ...(last.model !== undefined ? { judgeModel: last.model } : {}),
        ...(spread !== undefined
          ? {
              scores,
              scoreStdDev: spread,
              highVariance: spread > HIGH_VARIANCE,
            }
          : {}),
        ...(last.subScores !== undefined ? { subScores: last.subScores } : {}),
        ...(usage !== undefined ? { usage } : {}),
        ...(last.metadata !== undefined ? { metadata: last.metadata } : {}),
      },
    };
  } catch (err) {
    return judgeError(
      `Judge "${label}" error: ${err instanceof Error ? err.message : String(err)}`,
      label
    );
  }
}

/** A judge's identity, and whether MST can see its version change. */
interface JudgeIdentityDetails {
  judgeIdentity: string;
  judgeUnversioned?: true;
}

/**
 * A judge that read the trial and can't tell: not a pass, and no score.
 * `details.unknown` keeps it out of the judge's pass rate.
 */
function judgeUnknown(
  label: string,
  identity: JudgeIdentityDetails,
  final: CheckedJudgeScore,
  usage: ReturnType<typeof sumJudgeUsage>
): ValidationResult {
  return {
    pass: false,
    message: `Judge "${label}" answered unknown${final.reasoning ? `: ${final.reasoning}` : ''}`,
    details: {
      judgeName: label,
      ...identity,
      unknown: true,
      ...(final.reasoning !== undefined ? { reasoning: final.reasoning } : {}),
      ...(final.provider !== undefined
        ? { judgeProvider: final.provider }
        : {}),
      ...(final.model !== undefined ? { judgeModel: final.model } : {}),
      ...(final.subScores !== undefined ? { subScores: final.subScores } : {}),
      ...(usage !== undefined ? { usage } : {}),
      ...(final.metadata !== undefined ? { metadata: final.metadata } : {}),
    },
  };
}

/**
 * A judge that could not grade this case: recorded, passed, not scored. Its
 * metadata is kept, so a judge can say why it skipped in a form a script can
 * read (for example `{ noLinks: true }`); its score never is.
 */
function judgeSkipped(
  label: string,
  identity: JudgeIdentityDetails,
  reason: string | undefined,
  usage: ReturnType<typeof sumJudgeUsage>,
  metadata?: Record<string, unknown>
): ValidationResult {
  return {
    pass: true,
    message: `Judge "${label}" skipped${reason ? `: ${reason}` : ''}`,
    details: {
      judgeName: label,
      ...identity,
      skipped: true,
      ...(reason !== undefined ? { reasoning: reason } : {}),
      ...(usage !== undefined ? { usage } : {}),
      ...(metadata !== undefined ? { metadata } : {}),
    },
  };
}

/**
 * The mean score, rounded so that repeated identical scores average to
 * themselves (three 0.2s are 0.2, not 0.20000000000000004).
 */
function mean(scores: number[]): number {
  const raw = scores.reduce((a, b) => a + b, 0) / scores.length;
  // Float noise is around 1e-16; twelve places keep every real digit.
  return Math.round(raw * 1e12) / 1e12;
}

/** Population standard deviation of the scores around their mean. */
function scoreSpread(scores: number[], mean: number): number {
  const variance =
    scores.reduce((sum, s) => sum + (s - mean) ** 2, 0) / scores.length;
  return Math.sqrt(variance);
}

/**
 * A failure that is not a score: the judge couldn't score the response.
 * `details.error` lets matchers fail it with or without `.not`.
 */
export function judgeError(
  message: string,
  judgeName?: string
): ValidationResult {
  return {
    pass: false,
    message,
    details: {
      error: message,
      ...(judgeName !== undefined ? { judgeName } : {}),
    },
  };
}
