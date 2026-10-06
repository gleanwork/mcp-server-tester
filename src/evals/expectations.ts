/**
 * The expectation evaluator: turns an eval case's `expect` block and what the
 * case produced into expectation results.
 *
 * It owns the rules every execution path shares:
 * - whether the evidence can support tool-call assertions (decided once, here);
 * - the tool-trace view reported next to `toolsTriggered`;
 * - how judge settings resolve (case defaults, suite manifest judges).
 *
 * Validators stay pure leaves: this module decides what to grade and with
 * which settings, then calls them.
 */
import type { Expect } from '@playwright/test';
import type { ZodType } from 'zod';
import type {
  EvalCase,
  EvalAssertions,
  JudgeExpectConfig,
} from './datasetTypes.js';
import type { HostResponse } from './caseExecution.js';
import type { HostEvidence } from './evalFrameworkTypes.js';
import type { JudgeCaseSource } from '../judge/judgeContract.js';
import type {
  ExternalHostMetadata,
  TraceSource,
} from './externalHost/types.js';
import type { EvalExpectationResult } from '../types/index.js';
import type { EvalCaseResult } from '../types/reporter.js';
import { BUILTIN_RESULT_SCHEMAS } from './builtinResultSchemas.js';
import {
  validateResponse,
  validateSchema,
  validateText,
  validatePattern,
  validateError,
  validateSize,
  validateToolCalls,
  validateToolCallCount,
  validateJudge,
  type JudgeRun,
} from '../assertions/validators/index.js';
import {
  hostEvidenceProblem,
  matchesIdentity,
  matchToolCalls,
} from '../assertions/validators/toolCalls.js';
import {
  playwrightSnapshotStore,
  validateSnapshot,
} from '../assertions/validators/snapshot.js';
import { judgeOwnOptions } from '../judge/evaluateJudge.js';
import { judgeNameOf } from '../assertions/validators/judge.js';

/** What a case produced, in the form the evaluator grades. */
export interface GradedExecution {
  /** What validators grade: a direct result, or the host response with native tool names mapped. */
  response: unknown;
  /** The host response as reported; the tool trace shows its names. Absent for direct cases. */
  hostResponse?: HostResponse;
  /** Normalized host evidence. Absent for direct cases and hosts that don't report it. */
  evidence?: HostEvidence;
  /** External host metadata, whose trace source decides tool-evidence quality. */
  externalHost?: ExternalHostMetadata;
}

export interface ExpectationOptions {
  /** Named schemas for `expect.schema`, checked before the built-in schemas. */
  schemas?: Record<string, ZodType>;
  /** Playwright `expect`, required for `expect.snapshot`. */
  playwrightExpect?: Expect;
}

export interface ExpectationOutcome {
  expectations: EvalCaseResult['expectations'];
  /** Present when `toolsTriggered` was graded on sufficient evidence. */
  toolPrecision?: number;
  toolRecall?: number;
  /**
   * Expected, unexpected and missed calls, when `toolsTriggered` was graded
   * on sufficient evidence and the case ran on a host.
   */
  mcpHostTrace?: EvalCaseResult['mcpHostTrace'];
}

/** Trace sources that record tool calls as data rather than inferring them. */
const STRUCTURED_EXTERNAL_SOURCES: ReadonlySet<TraceSource> = new Set([
  'mcp-proxy',
  'mcp-server-logs',
  'host-local-transcript',
  'host-native-export',
]);

/** Where an external host's tool calls came from, when it has no per-field evidence. */
function toolCallTraceSource(externalHost: ExternalHostMetadata): TraceSource {
  return externalHost.sources?.toolCalls ?? externalHost.traceSource;
}

/** Whether an external host's trace is good enough to grade tool calls. */
function hasStructuredToolEvidence(
  externalHost: ExternalHostMetadata
): boolean {
  const evidence = externalHost.evidence?.toolCalls;
  if (evidence)
    return (
      evidence.confidence === 'high' &&
      STRUCTURED_EXTERNAL_SOURCES.has(evidence.source)
    );
  return (
    externalHost.traceConfidence === 'high' &&
    STRUCTURED_EXTERNAL_SOURCES.has(toolCallTraceSource(externalHost))
  );
}

/**
 * Why tool-call expectations can't be graded for this execution, or undefined
 * when the evidence is sufficient. The external host's trace source is
 * checked first because it is the more specific explanation.
 */
export function toolEvidenceGap(
  evalCase: Pick<EvalCase, 'mode'>,
  graded: Pick<GradedExecution, 'evidence' | 'externalHost'>
): string | undefined {
  const externalHost =
    evalCase.mode === 'external_host' ? graded.externalHost : undefined;
  if (externalHost && !hasStructuredToolEvidence(externalHost))
    return `External host trace source ${toolCallTraceSource(
      externalHost
    )} (${externalHost.traceConfidence} confidence) cannot support tool-call assertions. Use protocol traces or host-native structured traces for toolsTriggered/toolCallCount.`;
  return hostEvidenceProblem(graded.evidence);
}

/** The case's reference answer, `expected.answer`. */
function caseAnswer(evalCase: Pick<EvalCase, 'expected'>): unknown {
  return evalCase.expected?.answer;
}

/** Judge configurations with the case's defaults for reps and reference applied. */
export function resolveJudges(
  evalCase: Pick<EvalCase, 'assertions' | 'judgeReps' | 'expected'>
): JudgeExpectConfig[] {
  const configured = evalCase.assertions?.passesJudge;
  if (configured === undefined) return [];
  return (Array.isArray(configured) ? configured : [configured]).map(
    (judge) => ({
      ...judge,
      reference:
        judge.reference !== undefined ? judge.reference : caseAnswer(evalCase),
      reps: judge.reps ?? evalCase.judgeReps ?? 1,
    })
  );
}

/**
 * The case's `passesJudge` list with a suite manifest's judges merged in.
 * A case entry naming a manifest judge overrides that judge's settings;
 * other case entries are kept. `rawJudges` are the manifest entries before
 * parsing, so the judge's own schema sees its inputs once.
 */
export function mergeSuiteJudges(
  evalCase: Pick<EvalCase, 'assertions' | 'expected'>,
  judges: Array<Record<string, unknown>>,
  rawJudges: Array<Record<string, unknown>>
): Array<Record<string, unknown>> {
  const existing = Array.isArray(evalCase.assertions?.passesJudge)
    ? evalCase.assertions.passesJudge
    : evalCase.assertions?.passesJudge
      ? [evalCase.assertions.passesJudge]
      : [];
  // `rawJudges[i]` is `judges[i]` before parsing. A case entry overrides a
  // manifest judge when results would give both the same name, so two
  // rubric judges (`correctness`, `conciseness`) stay distinct.
  const names = judges.map((judge, i) =>
    judgeNameOf({
      ...(rawJudges[i] ?? judge),
      judge: typeof judge.type === 'string' ? judge.type : undefined,
    })
  );
  return [
    ...existing.filter((item) => !names.includes(judgeNameOf(item))),
    ...judges.map((judge, i) => {
      const caseJudge = existing.find((item) => judgeNameOf(item) === names[i]);
      const raw = rawJudges[i] ?? judge;
      const { options: caseOptions, ...caseSettings } = caseJudge ?? {};
      return {
        ...judge,
        ...caseSettings,
        judge: judge.type,
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
): Promise<EvalExpectationResult> {
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
              subScores:
                details.subScores as EvalExpectationResult['subScores'],
            }
          : {}),
        ...(details.usage !== undefined
          ? { usage: details.usage as EvalExpectationResult['usage'] }
          : {}),
        ...(details.metadata !== undefined
          ? { metadata: details.metadata as Record<string, unknown> }
          : {}),
      } satisfies EvalExpectationResult;
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

async function evaluateSnapshot(
  response: unknown,
  expectBlock: EvalAssertions & { snapshot: string },
  playwrightExpect: Expect | undefined
): Promise<EvalExpectationResult> {
  if (!playwrightExpect)
    return {
      pass: false,
      details: 'Snapshot testing requires expect in context',
    };
  try {
    const validation = await validateSnapshot(response, expectBlock.snapshot, {
      sanitizers: expectBlock.snapshotSanitizers,
      store: playwrightSnapshotStore(playwrightExpect),
    });
    return {
      pass: validation.pass,
      details: validation.pass
        ? `Matches snapshot "${expectBlock.snapshot}"`
        : validation.message,
    };
  } catch (err) {
    // An invalid sanitizer is reported on the expectation, not thrown.
    return {
      pass: false,
      details: err instanceof Error ? err.message : String(err),
    };
  }
}

function isToolCall(entry: { kind?: string }): boolean {
  return (entry.kind ?? 'tool_call') === 'tool_call';
}

/**
 * Expected, unexpected and missed tool calls, from the same match the
 * validator grades (statuses agree with precision, `missed` with recall).
 * Calls are shown with the host's own names; skills and other events are
 * left out of the view.
 */
function toolTraceView(
  expectation: NonNullable<EvalAssertions['toolsTriggered']>,
  graded: GradedExecution & { hostResponse: HostResponse }
): NonNullable<EvalCaseResult['mcpHostTrace']> {
  // Match on the mapped response the validator graded.
  const mapped = graded.response as HostResponse;
  const match = matchToolCalls(mapped.events ?? mapped.toolCalls, expectation);
  const matchedToolCalls = match.observed.filter((entry) =>
    isToolCall(entry.call)
  );
  const expectedToolCalls = expectation.calls.filter(isToolCall);
  return {
    calls: graded.hostResponse.toolCalls.map((call, index) => ({
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
 * Grades an eval case's `assertions` against what the case produced.
 * Tool-call expectations fail with the evidence gap when the evidence can't
 * support them; every other expectation is graded normally.
 */
export async function evaluateExpectations(
  evalCase: Pick<EvalCase, 'mode' | 'assertions' | 'judgeReps'> &
    JudgeCaseSource & { assertions: EvalAssertions },
  graded: GradedExecution,
  options: ExpectationOptions = {}
): Promise<ExpectationOutcome> {
  const expectBlock = evalCase.assertions;
  const { response } = graded;
  const results: EvalCaseResult['expectations'] = {};
  const outcome: ExpectationOutcome = { expectations: results };

  if (expectBlock.response !== undefined) {
    const validation = validateResponse(response, expectBlock.response);
    results.exact = { pass: validation.pass, details: validation.message };
  }

  if (expectBlock.schema !== undefined) {
    const schema =
      options.schemas?.[expectBlock.schema] ??
      BUILTIN_RESULT_SCHEMAS[expectBlock.schema];
    if (!schema) {
      results.schema = {
        pass: false,
        details: `Schema "${expectBlock.schema}" not found in schemas registry`,
      };
    } else {
      const validation = validateSchema(response, schema);
      results.schema = { pass: validation.pass, details: validation.message };
    }
  }

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

  if (expectBlock.isError !== undefined) {
    const validation = validateError(response, expectBlock.isError);
    results.error = { pass: validation.pass, details: validation.message };
  }

  if (expectBlock.responseSize !== undefined) {
    const validation = validateSize(response, expectBlock.responseSize);
    results.size = { pass: validation.pass, details: validation.message };
  }

  const gap =
    expectBlock.toolsTriggered !== undefined ||
    expectBlock.toolCallCount !== undefined
      ? toolEvidenceGap(evalCase, graded)
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
      if (graded.hostResponse)
        outcome.mcpHostTrace = toolTraceView(expectBlock.toolsTriggered, {
          ...graded,
          hostResponse: graded.hostResponse,
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

  // An empty passesJudge list still reports (as 0/0 judges passed).
  if (expectBlock.passesJudge !== undefined)
    results.judge = await evaluateJudges(response, resolveJudges(evalCase), {
      evalCase,
      hostResponse: graded.hostResponse,
      evidence: graded.evidence,
    });

  if (expectBlock.snapshot !== undefined)
    results.snapshot = await evaluateSnapshot(
      response,
      { ...expectBlock, snapshot: expectBlock.snapshot },
      options.playwrightExpect
    );

  return outcome;
}
