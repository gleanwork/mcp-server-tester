/**
 * Grading: turns an eval case's `assertions` and `judges` and what the
 * client did into scores.
 *
 * It owns the rules every execution path shares:
 * - whether the evidence can support tool-call assertions (decided once, here);
 * - the tool-trace view reported next to `toolsTriggered`;
 * - how judge settings resolve (case defaults, eval config judges).
 *
 * Validators stay pure leaves: this module decides what to grade and with
 * which settings, then calls them.
 */
import type {
  CaseJudge,
  CaseJudgeConfig,
  EvalCase,
  EvalAssertions,
  JudgeExpectConfig,
} from './datasetTypes.js';
import type { ClientResponse } from './caseExecution.js';
import type { TraceEvidence } from './evalFrameworkTypes.js';
import type { JudgeCaseSource } from '../judge/judgeContract.js';
import type { ClientMetadata } from './externalClient/types.js';
import type { GraderScore } from '../types/index.js';
import type { EvalCaseResult } from '../types/reporter.js';
import {
  validateText,
  validatePattern,
  validateToolCalls,
  validateToolCallCount,
  validateJudge,
  type JudgeRun,
} from '../assertions/validators/index.js';
import {
  clientEvidenceProblem,
  matchesIdentity,
  matchToolCalls,
} from '../assertions/validators/toolCalls.js';
import { judgeOwnOptions } from '../judge/evaluateJudge.js';
import { judgeNameOf } from '../assertions/validators/judge.js';

/** What a case produced, in the form the evaluator grades. */
export interface GradedExecution {
  /** What validators grade: the client's response with native tool names mapped. */
  response: unknown;
  /** The client's response as reported; the tool trace shows its names. */
  clientResponse?: ClientResponse;
  /** Normalized client evidence. Absent for clients that don't report it. */
  evidence?: TraceEvidence;
  /** External client metadata, whose trace source decides tool-evidence quality. */
  clientMetadata?: ClientMetadata;
}

export interface GradingOutcome {
  scores: EvalCaseResult['scores'];
  /** Present when `toolsTriggered` was graded on sufficient evidence. */
  toolPrecision?: number;
  toolRecall?: number;
  /**
   * Expected, unexpected and missed calls, when `toolsTriggered` was graded
   * on sufficient evidence and the case ran on a client.
   */
  toolCallTrace?: EvalCaseResult['toolCallTrace'];
}

/**
 * Why tool-call assertions can't be graded for this execution, or undefined
 * when the evidence is sufficient.
 */
export function toolEvidenceGap(
  graded: Pick<GradedExecution, 'evidence'>
): string | undefined {
  return clientEvidenceProblem(graded.evidence);
}

/** The case's reference answer, `expected.answer`. */
function caseAnswer(evalCase: Pick<EvalCase, 'expected'>): unknown {
  return evalCase.expected?.answer;
}

/** A case judge (`"acme/judge/x"` or `{ type, ...settings }`) with its settings. */
function caseJudgeConfig(entry: CaseJudge): CaseJudgeConfig {
  return typeof entry === 'string' ? { type: entry } : entry;
}

/** The judge request a case judge means: `type` names the judge. */
function caseJudgeRequest(entry: CaseJudge): JudgeExpectConfig {
  const { type, ...settings } = caseJudgeConfig(entry);
  // The rubric judge with a flat `rubric` is the shorthand, which merges
  // its flat settings with `options`.
  if (type === 'rubric' && settings.rubric !== undefined) return settings;
  return { ...settings, judge: type };
}

/** Judge requests for the case's `judges`, with its defaults for reps and reference applied. */
export function resolveJudges(
  evalCase: Pick<EvalCase, 'judges' | 'judgeReps' | 'expected'>
): JudgeExpectConfig[] {
  return (evalCase.judges ?? []).map(caseJudgeRequest).map((judge) => ({
    ...judge,
    reference:
      judge.reference !== undefined ? judge.reference : caseAnswer(evalCase),
    reps: judge.reps ?? evalCase.judgeReps ?? 1,
  }));
}

/**
 * The case's `judges` with an eval config's (or its variant's) judges merged
 * in: the case runs both. When the case lists a judge the eval config also
 * lists (the same name in results), the case's settings win over the eval
 * config's; other case judges are kept. `rawJudges` are the eval config
 * entries before parsing, so the judge's own schema sees its inputs once.
 */
export function mergeEvalJudges(
  evalCase: Pick<EvalCase, 'judges' | 'expected'>,
  judges: Array<Record<string, unknown>>,
  rawJudges: Array<Record<string, unknown>>
): CaseJudgeConfig[] {
  const existing = (evalCase.judges ?? []).map(caseJudgeConfig);
  const nameOf = (entry: CaseJudgeConfig) =>
    judgeNameOf(caseJudgeRequest(entry));
  // `rawJudges[i]` is `judges[i]` before parsing. A case entry overrides an
  // eval config judge when results would give both the same name, so two
  // rubric judges (`correctness`, `conciseness`) stay distinct.
  const names = judges.map((judge, i) =>
    judgeNameOf({
      ...(rawJudges[i] ?? judge),
      judge: typeof judge.type === 'string' ? judge.type : undefined,
    })
  );
  return [
    ...existing.filter((item) => !names.includes(nameOf(item))),
    ...judges.map((judge, i) => {
      const caseJudge = existing.find((item) => nameOf(item) === names[i]);
      const raw = rawJudges[i] ?? judge;
      const { options: caseOptions, ...caseSettings } = caseJudge ?? {};
      return {
        ...judge,
        ...caseSettings,
        type: judge.type as string,
        // Merge raw policy inputs so the shared evaluator transforms them once.
        // Explicit case settings, including flat policy fields, win over defaults.
        options: judgeOwnOptions({ ...raw, ...caseSettings, ...caseOptions }),
        reference:
          caseJudge?.reference !== undefined
            ? caseJudge.reference
            : judge.reference !== undefined
              ? judge.reference
              : caseAnswer(evalCase),
      };
    }),
  ];
}

async function evaluateJudges(
  response: unknown,
  judges: JudgeExpectConfig[],
  run: JudgeRun
): Promise<GraderScore> {
  const results = await Promise.all(
    judges.map(async (judge) => {
      const validation = await validateJudge(response, judge, run);
      const details = validation.details ?? {};
      return {
        pass: validation.pass,
        details: validation.message,
        score: details.score as number | undefined,
        reasoning: details.reasoning as string | undefined,
        judgeName: details.judgeName as string | undefined,
        judgeProvider: details.judgeProvider as string | undefined,
        judgeModel: details.judgeModel as string | undefined,
        ...(details.skipped === true ? { skipped: true } : {}),
        ...(details.subScores !== undefined
          ? {
              subScores: details.subScores as GraderScore['subScores'],
            }
          : {}),
        ...(details.usage !== undefined
          ? { usage: details.usage as GraderScore['usage'] }
          : {}),
        ...(details.metadata !== undefined
          ? { metadata: details.metadata as Record<string, unknown> }
          : {}),
      } satisfies GraderScore;
    })
  );
  if (results.length === 1) return results[0]!;
  // Several judges must all pass. Skipped judges neither pass nor fail.
  const graded = results.filter((result) => !result.skipped);
  const passCount = graded.filter((result) => result.pass).length;
  const skipped = results.length - graded.length;
  return {
    pass: passCount === graded.length,
    details:
      `${passCount}/${graded.length} judges passed` +
      (skipped > 0 ? ` (${skipped} skipped)` : ''),
    judgeResults: results,
  };
}

function isToolCall(entry: { kind?: string }): boolean {
  return (entry.kind ?? 'tool_call') === 'tool_call';
}

/**
 * Expected, unexpected and missed tool calls, from the same match the
 * validator grades (statuses agree with precision, `missed` with recall).
 * Calls are shown with the client's own names; skills and other events are
 * left out of the view.
 */
function toolTraceView(
  assertion: NonNullable<EvalAssertions['toolsTriggered']>,
  graded: GradedExecution & { clientResponse: ClientResponse }
): NonNullable<EvalCaseResult['toolCallTrace']> {
  // Match on the mapped response the validator graded.
  const mapped = graded.response as ClientResponse;
  const match = matchToolCalls(mapped.events ?? mapped.toolCalls, assertion);
  const matchedToolCalls = match.observed.filter((entry) =>
    isToolCall(entry.call)
  );
  const expectedToolCalls = assertion.calls.filter(isToolCall);
  return {
    calls: graded.clientResponse.toolCalls.map((call, index) => ({
      name: call.name,
      arguments: call.arguments,
      status:
        (matchedToolCalls[index]?.expected ??
        expectedToolCalls.some((item) => matchesIdentity(call, item)))
          ? 'expected'
          : 'unexpected',
    })),
    missed: match.missed.filter(isToolCall).map(({ name }) => ({ name })),
  };
}

/**
 * Grades an eval case's `assertions` and `judges` against what the case
 * produced. Tool-call assertions fail with the evidence gap when the evidence
 * can't support them; every other grader runs normally.
 */
export async function gradeTrial(
  evalCase: Pick<EvalCase, 'assertions' | 'judges' | 'judgeReps'> &
    JudgeCaseSource,
  graded: GradedExecution
): Promise<GradingOutcome> {
  const expectBlock: EvalAssertions = evalCase.assertions ?? {};
  const { response } = graded;
  const results: EvalCaseResult['scores'] = {};
  const outcome: GradingOutcome = { scores: results };

  if (expectBlock.containsText !== undefined) {
    const validation = validateText(response, expectBlock.containsText);
    results.textContains = {
      pass: validation.pass,
      details: validation.message,
    };
  }

  if (expectBlock.matchesPattern !== undefined) {
    const validation = validatePattern(response, expectBlock.matchesPattern);
    results.regex = { pass: validation.pass, details: validation.message };
  }

  const gap =
    expectBlock.toolsTriggered !== undefined ||
    expectBlock.toolCallCount !== undefined
      ? toolEvidenceGap(graded)
      : undefined;

  if (expectBlock.toolsTriggered !== undefined) {
    if (gap !== undefined) {
      results.toolsTriggered = { pass: false, details: gap };
    } else {
      const validation = validateToolCalls(
        response,
        expectBlock.toolsTriggered
      );
      results.toolsTriggered = {
        pass: validation.pass,
        details: validation.message,
      };
      outcome.toolPrecision = validation.metrics?.precision;
      outcome.toolRecall = validation.metrics?.recall;
      if (graded.clientResponse)
        outcome.toolCallTrace = toolTraceView(expectBlock.toolsTriggered, {
          ...graded,
          clientResponse: graded.clientResponse,
        });
    }
  }

  if (expectBlock.toolCallCount !== undefined) {
    if (gap !== undefined) {
      results.toolCallCount = { pass: false, details: gap };
    } else {
      const validation = validateToolCallCount(
        response,
        expectBlock.toolCallCount
      );
      results.toolCallCount = {
        pass: validation.pass,
        details: validation.message,
      };
    }
  }

  if (evalCase.judges?.length)
    results.judge = await evaluateJudges(response, resolveJudges(evalCase), {
      evalCase,
      clientResponse: graded.clientResponse,
      evidence: graded.evidence,
    });

  return outcome;
}
