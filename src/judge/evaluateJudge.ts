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
import {
  contentHash,
  judgeIdentity,
  judgeIsVersioned,
} from './judgeIdentity.js';
import {
  buildJudgeCase,
  buildJudgeTrial,
  checkJudgeScore,
  missingRequirement,
  sumJudgeUsage,
  type CheckedJudgeScore,
  type JudgeCaseSource,
  type JudgeCriterion,
  type JudgeInput,
  type JudgeSubScore,
} from './judgeContract.js';
import type {
  GraderCriterion,
  GraderJuryVote,
  UsageMetrics,
} from '../types/index.js';

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
  'jury',
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
  /**
   * Run the judge on several models, as a jury (ADR 0009): each member is
   * option overrides, such as `{ "model": "claude-sonnet-4-6" }`, merged
   * over `options`. The verdict is the members' majority; a tie is unknown.
   */
  jury?: ReadonlyArray<Record<string, unknown>>;
}

/** The requests a jury's members run: its options with each member's. */
function juryMembers(request: JudgeRequest): JudgeRequest[] {
  const { jury } = request;
  if (
    !Array.isArray(jury) ||
    jury.length < 2 ||
    !jury.every((m) => typeof m === 'object' && m !== null && !Array.isArray(m))
  )
    throw new Error(
      'jury must list at least two members, each an object of the options it changes, such as { "model": "claude-sonnet-4-6" }.'
    );
  return jury.map((member) => {
    for (const key of Object.keys(member))
      if (ASSERTION_KEYS.has(key))
        throw new Error(
          `A jury member sets only the judge's options, not "${key}".`
        );
    const { jury: _jury, ...single } = request;
    return { ...single, options: { ...request.options, ...member } };
  });
}

/**
 * The identity every score of `request` records (ADR 0009). A jury's is
 * the set of its members' identities, so the members' order doesn't count.
 */
export function judgeRequestIdentity(
  request: JudgeRequest
): JudgeIdentityDetails {
  if (request.jury !== undefined) {
    const members = juryMembers(request).map(judgeRequestIdentity);
    const ids = members.map((m) => m.judgeIdentity);
    if (new Set(ids).size !== ids.length)
      throw new Error('Two jury members are the same judge.');
    return {
      judgeIdentity: contentHash({ jury: [...ids].sort() }),
      ...(members.some((m) => m.judgeUnversioned)
        ? { judgeUnversioned: true as const }
        : {}),
    };
  }
  const judge = getJudge(request.judge);
  return {
    judgeIdentity: judgeIdentity(request.judge, judge, request.options, {
      threshold: request.threshold,
      reps: request.reps,
    }),
    ...(judgeIsVersioned(request.judge, judge)
      ? {}
      : { judgeUnversioned: true as const }),
  };
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
  if (request.jury !== undefined) {
    try {
      judgeRequestIdentity(request);
    } catch (error) {
      throw new Error(
        `Judge "${request.label}" can't run: ${error instanceof Error ? error.message : String(error)}`
      );
    }
    for (const member of juryMembers(request))
      await preflightJudgeRequest(member, settings);
    return;
  }
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
 * A judge whose score lists criteria has each criterion's majority over the
 * reps. When one of them is required, the criteria decide the judge in
 * place of its score, `pass`, `unknown` and the threshold.
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
  if (request.jury !== undefined) return evaluateJury(response, request, run);
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
    const identity = judgeRequestIdentity(request);
    const missing = missingRequirement(input, judge.requires);
    if (missing !== undefined)
      return judgeSkipped(label, identity, `no ${missing}`, undefined);

    const criterionIdentity = (criterion: string): string =>
      judge.criterionOptions
        ? judgeIdentity(
            request.judge,
            judge,
            judge.criterionOptions(request.options, criterion),
            { threshold, reps }
          )
        : identity.judgeIdentity;

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
      if (repScore.skipped) {
        // A skip gives no verdict, so each criterion the reps listed is
        // unknown: its labels still count, as a trial the judge couldn't
        // decide.
        const criteria = combineCriteria(repScores, criterionIdentity)?.map(
          (criterion) => ({ ...criterion, verdict: 'unknown' as const })
        );
        return judgeSkipped(
          label,
          identity,
          repScore.reasoning,
          sumJudgeUsage(repScores.map((v) => v.usage)),
          repScore.metadata,
          criteria
        );
      }
    }
    const usage = sumJudgeUsage(repScores.map((v) => v.usage));
    const final = repScores.at(-1);
    if (!final)
      return judgeError(`Judge "${label}" error: no scores collected`, label);
    const criteria = combineCriteria(repScores, criterionIdentity);
    const answered = repScores.filter((v) => v.unknown !== true);
    const last = answered.at(-1);
    // A judge with a required criterion is what its criteria are, each
    // decided by its own majority over the reps, so the two never disagree.
    const decided = criteria && criteriaOutcome(criteria);
    if (decided) {
      const shown = last ?? final;
      // A criterion's sub-score is its combined verdict's, and a criterion
      // that came out unknown has none; other sub-scores stay.
      const ids = new Set(criteria.map((c) => c.id));
      const combined = {
        ...shown,
        reasoning: decided.reasoning,
        subScores: {
          ...Object.fromEntries(
            Object.entries(shown.subScores ?? {}).filter(([id]) => !ids.has(id))
          ),
          ...decided.subScores,
        },
      };
      if (decided.verdict === 'unknown')
        return judgeUnknown(label, identity, combined, usage, criteria);
      return judgeByCriteria(
        label,
        identity,
        combined,
        decided,
        criteria,
        usage,
        reps
      );
    }
    if (!last) return judgeUnknown(label, identity, final, usage, criteria);

    const scores = answered.map((v) => v.score);
    const score = mean(scores);
    // A judge that decides pass/fail itself wins by majority over the reps;
    // otherwise the mean score meets the threshold or not.
    const judgeDecides = answered.some((v) => v.judgePass !== undefined);
    const passed = judgeDecides
      ? answered.filter((v) => v.pass).length * 2 > answered.length
      : score >= threshold;
    const shown = last;
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
        : `Judge "${label}" failed with score ${score.toFixed(2)} (threshold: ${threshold})${repNote}. ${shown.reasoning ?? ''}`,
      details: {
        judgeName: label,
        ...identity,
        score,
        reasoning: shown.reasoning,
        ...(shown.provider !== undefined
          ? { judgeProvider: shown.provider }
          : {}),
        ...(shown.model !== undefined ? { judgeModel: shown.model } : {}),
        ...(spread !== undefined
          ? {
              scores,
              scoreStdDev: spread,
              highVariance: spread > HIGH_VARIANCE,
            }
          : {}),
        ...(shown.subScores !== undefined
          ? { subScores: shown.subScores }
          : {}),
        ...(criteria !== undefined ? { criteria } : {}),
        ...(usage !== undefined ? { usage } : {}),
        ...(shown.metadata !== undefined ? { metadata: shown.metadata } : {}),
      },
    };
  } catch (err) {
    return judgeError(
      `Judge "${label}" error: ${err instanceof Error ? err.message : String(err)}`,
      label
    );
  }
}

/** A member's verdict, from its result. */
function memberVerdict(result: ValidationResult): GraderJuryVote['verdict'] {
  const details = result.details ?? {};
  return details.skipped === true
    ? 'skipped'
    : details.unknown === true
      ? 'unknown'
      : result.pass
        ? 'pass'
        : 'fail';
}

/**
 * A jury (ADR 0009): the judge on each member's options, then the majority
 * of the members that passed or failed it. A tie, or no member deciding,
 * is unknown; every member skipping is a skip. A member that fails to run
 * fails the jury, so a resume runs it again. A judge's criteria each take
 * the members' majority too, and its required ones decide, as over reps.
 */
async function evaluateJury(
  response: unknown,
  request: JudgeRequest,
  run: JudgeRun
): Promise<ValidationResult> {
  const { label } = request;
  let members: JudgeRequest[];
  let identity: JudgeIdentityDetails;
  try {
    members = juryMembers(request);
    identity = judgeRequestIdentity(request);
  } catch (err) {
    return judgeError(
      `Judge "${label}" error: ${err instanceof Error ? err.message : String(err)}`,
      label
    );
  }
  const results = await Promise.all(
    members.map((member) => evaluateJudge(response, member, run))
  );
  const votes: GraderJuryVote[] = [];
  for (const [i, result] of results.entries()) {
    const details = result.details ?? {};
    // A member that answered without calling its model still names the
    // one it was given.
    const given = members[i]!.options.model;
    const model =
      typeof details.judgeModel === 'string'
        ? details.judgeModel
        : typeof given === 'string'
          ? given
          : undefined;
    if (typeof details.error === 'string')
      return judgeError(
        `Judge "${label}" error: jury member ${i + 1}${model ? ` (${model})` : ''}: ${result.message}`,
        label
      );
    votes.push({
      ...(typeof details.judgeProvider === 'string'
        ? { provider: details.judgeProvider }
        : {}),
      ...(model !== undefined ? { model } : {}),
      judgeIdentity: details.judgeIdentity as string,
      verdict: memberVerdict(result),
      ...(typeof details.score === 'number' &&
      details.skipped !== true &&
      details.unknown !== true
        ? { score: details.score }
        : {}),
      ...(typeof details.reasoning === 'string'
        ? { reasoning: details.reasoning }
        : {}),
    });
  }
  const usage = sumJudgeUsage(
    results.map((r) => r.details?.usage as Partial<UsageMetrics> | undefined)
  );
  const criteria = combineJuryCriteria(results);
  const jury = {
    jury: votes,
    judgeModel: votes.map((v) => v.model ?? '?').join(', '),
  };
  if (votes.every((v) => v.verdict === 'skipped')) {
    const skipped = judgeSkipped(
      label,
      identity,
      'Every jury member skipped.',
      usage,
      undefined,
      criteria?.map((c) => ({ ...c, verdict: 'unknown' as const }))
    );
    return { ...skipped, details: { ...skipped.details, ...jury } };
  }
  const passed = votes.filter((v) => v.verdict === 'pass').length;
  const failed = votes.filter((v) => v.verdict === 'fail').length;
  const decided = criteria && criteriaOutcome(criteria);
  const verdict = decided
    ? decided.verdict
    : passed > failed
      ? 'pass'
      : failed > passed
        ? 'fail'
        : 'unknown';
  const tally = `${passed} of ${votes.length} jury members passed it and ${failed} failed it`;
  const agreeing = votes.find((v) => v.verdict === verdict);
  const reasoning = decided
    ? decided.reasoning
    : agreeing?.reasoning !== undefined
      ? agreeing.reasoning
      : `The jury members disagreed: ${tally}.`;
  const scores = votes.flatMap((v) =>
    v.score !== undefined && v.verdict !== 'unknown' ? [v.score] : []
  );
  const score = decided
    ? decided.score
    : scores.length
      ? mean(scores)
      : undefined;
  const details = {
    judgeName: label,
    ...identity,
    ...(verdict === 'unknown' ? { unknown: true } : {}),
    ...(score !== undefined && verdict !== 'unknown' ? { score } : {}),
    reasoning,
    ...jury,
    ...(decided ? { subScores: decided.subScores } : {}),
    ...(criteria !== undefined ? { criteria } : {}),
    ...(usage !== undefined ? { usage } : {}),
  };
  return {
    pass: verdict === 'pass',
    message:
      verdict === 'unknown'
        ? `Judge "${label}" answered unknown: ${tally}.`
        : verdict === 'pass'
          ? `Judge "${label}" passed: ${tally}.`
          : `Judge "${label}" failed: ${tally}. ${reasoning}`,
    details,
  };
}

/**
 * Each criterion's verdict over a jury's members, as `combineCriteria`
 * gives it over reps. Its identity is the set of the members' identities
 * for it. Undefined when no member listed criteria.
 */
function combineJuryCriteria(
  results: readonly ValidationResult[]
): GraderCriterion[] | undefined {
  const byId = new Map<string, GraderCriterion[]>();
  for (const result of results)
    for (const criterion of (result.details?.criteria ??
      []) as GraderCriterion[])
      byId.set(criterion.id, [...(byId.get(criterion.id) ?? []), criterion]);
  if (byId.size === 0) return undefined;
  return [...byId].map(([id, verdicts]): GraderCriterion => {
    const passed = verdicts.filter((v) => v.verdict === 'pass').length;
    const failed = verdicts.filter((v) => v.verdict === 'fail').length;
    const first = verdicts[0]!;
    const verdict =
      passed > failed ? 'pass' : failed > passed ? 'fail' : 'unknown';
    const { reasoning } = verdicts.find((v) => v.verdict === verdict) ?? {
      reasoning: `The jury members disagreed: ${passed} passed it and ${failed} failed it.`,
    };
    return {
      id,
      ...(first.text !== undefined ? { text: first.text } : {}),
      ...(first.required === false ? { required: false as const } : {}),
      verdict,
      ...(reasoning !== undefined ? { reasoning } : {}),
      judgeIdentity: contentHash({
        jury: verdicts.map((v) => v.judgeIdentity).sort(),
      }),
    };
  });
}

/**
 * Each criterion's verdict over the reps: the majority of the reps that
 * gave it pass or fail, unknown on a tie or when none did. Its text and
 * `required` are the last rep's, its reasoning the last rep's that agrees
 * with the verdict, and its identity is `identityOf` it. Undefined when no
 * rep listed criteria.
 */
function combineCriteria(
  reps: readonly CheckedJudgeScore[],
  identityOf: (criterion: string) => string
): GraderCriterion[] | undefined {
  const byId = new Map<string, JudgeCriterion[]>();
  for (const rep of reps)
    for (const criterion of rep.criteria ?? [])
      byId.set(criterion.id, [...(byId.get(criterion.id) ?? []), criterion]);
  if (byId.size === 0) return undefined;
  return [...byId].map(([id, verdicts]): GraderCriterion => {
    const passed = verdicts.filter((v) => v.verdict === 'pass').length;
    const failed = verdicts.filter((v) => v.verdict === 'fail').length;
    const last = verdicts.at(-1)!;
    const verdict =
      passed > failed ? 'pass' : failed > passed ? 'fail' : 'unknown';
    // A tie between reps that answered has no one rep's reasoning.
    const { reasoning } = [...verdicts]
      .reverse()
      .find((v) => v.verdict === verdict) ?? {
      reasoning: `The reps disagreed: ${passed} passed it and ${failed} failed it.`,
    };
    return {
      id,
      ...(last.text !== undefined ? { text: last.text } : {}),
      ...(last.required === false ? { required: false as const } : {}),
      verdict,
      ...(reasoning !== undefined ? { reasoning } : {}),
      judgeIdentity: identityOf(id),
    };
  });
}

/** What a judge's required criteria decide. */
interface CriteriaOutcome {
  verdict: GraderCriterion['verdict'];
  /** The share of required criteria that passed. */
  score: number;
  /** The deciding criteria's reasoning. */
  reasoning: string;
  subScores: Record<string, JudgeSubScore>;
  failed: string[];
}

/**
 * A judge's verdict from its criteria: fail when a required criterion
 * fails, unknown when none fails and one is unknown, else pass. Undefined
 * when no criterion is required, so the judge's own verdict decides.
 */
function criteriaOutcome(
  criteria: readonly GraderCriterion[]
): CriteriaOutcome | undefined {
  const required = criteria.filter((c) => c.required !== false);
  if (required.length === 0) return undefined;
  const failed = required.filter((c) => c.verdict === 'fail');
  const unknown = required.filter((c) => c.verdict === 'unknown');
  const deciding = failed.length ? failed : unknown.length ? unknown : criteria;
  const reasoning = deciding
    .map((c) =>
      criteria.length === 1
        ? (c.reasoning ?? '')
        : `${c.id}: ${c.reasoning ?? ''}`
    )
    .join('\n');
  const subScores: Record<string, JudgeSubScore> = {};
  for (const c of criteria)
    if (c.verdict !== 'unknown')
      subScores[c.id] = {
        score: c.verdict === 'pass' ? 1 : 0,
        pass: c.verdict === 'pass',
        ...(c.reasoning !== undefined ? { reasoning: c.reasoning } : {}),
      };
  return {
    verdict: failed.length ? 'fail' : unknown.length ? 'unknown' : 'pass',
    score:
      required.filter((c) => c.verdict === 'pass').length / required.length,
    reasoning,
    subScores,
    failed: failed.map((c) => c.id),
  };
}

/** A judge decided by its required criteria; the threshold takes no part. */
function judgeByCriteria(
  label: string,
  identity: JudgeIdentityDetails,
  shown: CheckedJudgeScore,
  decided: CriteriaOutcome,
  criteria: GraderCriterion[],
  usage: ReturnType<typeof sumJudgeUsage>,
  reps: number
): ValidationResult {
  const passed = decided.verdict === 'pass';
  const repNote =
    reps > 1 ? ` (each criterion's majority of ${reps} reps)` : '';
  return {
    pass: passed,
    message: passed
      ? `Judge "${label}" passed: every required criterion passed${repNote}`
      : `Judge "${label}" failed: ${decided.failed.join(', ')} failed${repNote}. ${decided.reasoning}`,
    details: {
      judgeName: label,
      ...identity,
      score: decided.score,
      reasoning: decided.reasoning,
      ...(shown.provider !== undefined
        ? { judgeProvider: shown.provider }
        : {}),
      ...(shown.model !== undefined ? { judgeModel: shown.model } : {}),
      subScores: shown.subScores,
      criteria,
      ...(usage !== undefined ? { usage } : {}),
      ...(shown.metadata !== undefined ? { metadata: shown.metadata } : {}),
    },
  };
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
  usage: ReturnType<typeof sumJudgeUsage>,
  criteria: GraderCriterion[] | undefined
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
      ...(criteria !== undefined ? { criteria } : {}),
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
  metadata?: Record<string, unknown>,
  criteria?: GraderCriterion[]
): ValidationResult {
  return {
    pass: true,
    message: `Judge "${label}" skipped${reason ? `: ${reason}` : ''}`,
    details: {
      judgeName: label,
      ...identity,
      skipped: true,
      ...(reason !== undefined ? { reasoning: reason } : {}),
      ...(criteria !== undefined ? { criteria } : {}),
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
