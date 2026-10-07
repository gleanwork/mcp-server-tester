/**
 * The judge contract.
 *
 * A judge is called as `evaluate({ case, trial }, options)`, once per rep:
 *
 * - `case` is what the dataset author wrote: the input and what is expected.
 *   It is the same for every run of the case.
 * - `trial` is one observed run: the response, its text and trace, and usage.
 * - `options` is how this judge grades, parsed by the judge's schema.
 *
 * The pass threshold belongs to the framework, not the judge. A judge returns
 * a score, and may return its own verdict, sub-scores, usage, or a skip.
 */

import type { UsageMetrics } from './judgeTypes.js';
import type { TraceEvent, TraceEvidence } from '../evals/evalFrameworkTypes.js';
import type { LLMToolCall } from '../evals/mcpHost/mcpHostTypes.js';
import { extractText } from '../mcp/response.js';

/** One conversation turn, as the host reported it. */
export interface JudgeMessage {
  role: 'user' | 'assistant' | 'tool';
  content?: string;
  toolCallId?: string;
}

/** What the case asked. */
export interface JudgeCaseInput {
  /** The case's input, given to the client as its prompt. */
  prompt?: string;
}

/**
 * What the case expects. `answer` is the reference answer; other keys are
 * open, so a judge can read its own ground truth (for example `criteria`).
 */
export interface JudgeExpected {
  answer?: unknown;
  /** Per-case rubric criteria, keyed by criterion name. */
  criteria?: Record<string, string>;
  [key: string]: unknown;
}

/** The case as written in the dataset. The same for every run. */
export interface JudgeCase {
  /** Absent outside a dataset (Playwright matchers). */
  id?: string;
  input: JudgeCaseInput;
  expected: JudgeExpected;
  tags: string[];
  metadata: Record<string, unknown>;
}

/** One observed run of the case. */
export interface JudgeTrial {
  /** What the validators grade: the client's response, or a tool result (toPassToolJudge). */
  response: unknown;
  /** The response text. */
  text: string;
  /** Tool calls and other client events, in order. Empty for a tool result. */
  events: TraceEvent[];
  /** Conversation turns, when the host reports them. */
  messages?: JudgeMessage[];
  /** How the trace was observed. Absent for a tool result. */
  evidence?: TraceEvidence;
  /** Host model usage for this run. */
  usage?: Partial<UsageMetrics>;
}

/** The argument of `evaluate`. */
export interface JudgeInput {
  case: JudgeCase;
  trial: JudgeTrial;
}

/** One named sub-score, such as one rubric criterion. */
export interface JudgeSubScore {
  /** Score from 0 to 1. */
  score: number;
  pass?: boolean;
  reasoning?: string;
}

/** What a judge returns for one rep. Only `score` is required. */
export interface JudgeVerdict {
  /** Score from 0 to 1. Ignored when `skipped` is true. */
  score: number;
  reasoning?: string;
  /**
   * The judge's own verdict. When absent, the framework compares `score`
   * with the threshold. Over several reps, the majority verdict wins.
   */
  pass?: boolean;
  /**
   * The judge cannot grade this case. A skipped judge is recorded but
   * excluded from pass/fail and judge metrics.
   */
  skipped?: boolean;
  /** Named sub-scores, such as one per rubric criterion. */
  subScores?: Record<string, JudgeSubScore>;
  /** Token usage and cost of the judge's own model calls. */
  usage?: Partial<UsageMetrics>;
  /** The LLM provider that scored, when the judge uses one. */
  provider?: string;
  /** The model that scored, when the judge uses one. */
  model?: string;
  /** Other structured output, kept in results as-is. Must be JSON-serializable. */
  metadata?: Record<string, unknown>;
}

/** A judge verdict after checks, with pass/fail resolved. */
export interface CheckedJudgeVerdict extends JudgeVerdict {
  pass: boolean;
  /** The `pass` the judge returned itself, if any. */
  judgePass?: boolean;
}

/** Case fields a `JudgeInput` is built from. */
export interface JudgeCaseSource {
  id?: string;
  /** The case's input, which the judge sees as `input.prompt`. */
  input?: string;
  expected?: Record<string, unknown>;
  tags?: string[];
  metadata?: Record<string, unknown>;
}

/** The host response fields a `JudgeTrial` is built from. */
interface HostResponseLike {
  response?: string;
  toolCalls?: LLMToolCall[];
  events?: TraceEvent[];
  conversationHistory?: JudgeMessage[];
  usage?: Partial<UsageMetrics>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * The judge's view of a case. `reference` (a per-judge override) wins over
 * `expected.answer`.
 */
export function buildJudgeCase(
  source: JudgeCaseSource | undefined,
  reference?: unknown
): JudgeCase {
  const expected: JudgeExpected = { ...(source?.expected ?? {}) };
  const answer = reference !== undefined ? reference : expected.answer;
  if (answer !== undefined) expected.answer = answer;
  else delete expected.answer;
  return {
    ...(source?.id !== undefined && { id: source.id }),
    input: {
      ...(source?.input !== undefined && { prompt: source.input }),
    },
    expected,
    tags: [...(source?.tags ?? [])],
    metadata: { ...(source?.metadata ?? {}) },
  };
}

function toolCallEvents(calls: LLMToolCall[]): TraceEvent[] {
  return calls.map((call) => ({
    kind: 'tool_call',
    source: call.source ?? 'mcp',
    name: call.name,
    ...(call.server !== undefined && { server: call.server }),
    arguments: call.arguments,
    ...(call.output !== undefined && { output: call.output }),
    ...(call.isError !== undefined && { isError: call.isError }),
    ...(call.id !== undefined && { id: call.id }),
  }));
}

/** One run, built from the graded response and the host response, if any. */
export function buildJudgeTrial(
  response: unknown,
  host?: { hostResponse?: unknown; evidence?: TraceEvidence }
): JudgeTrial {
  const hostResponse = (
    isRecord(host?.hostResponse)
      ? host.hostResponse
      : isRecord(response) && Array.isArray(response.toolCalls)
        ? response
        : undefined
  ) as HostResponseLike | undefined;
  const text =
    typeof hostResponse?.response === 'string'
      ? hostResponse.response
      : extractText(response);
  const events =
    hostResponse?.events ??
    (hostResponse?.toolCalls ? toolCallEvents(hostResponse.toolCalls) : []);
  return {
    response,
    text,
    events,
    ...(hostResponse?.conversationHistory !== undefined && {
      messages: hostResponse.conversationHistory,
    }),
    ...(host?.evidence !== undefined && { evidence: host.evidence }),
    ...(hostResponse?.usage !== undefined && { usage: hostResponse.usage }),
  };
}

/** Read a dotted path such as `case.expected.criteria` from a judge input. */
function readPath(input: object, path: string): unknown {
  let value: unknown = input;
  for (const key of path.split('.')) {
    if (!isRecord(value)) return undefined;
    value = value[key];
  }
  return value;
}

function isPresent(value: unknown): boolean {
  if (value === undefined || value === null || value === '') return false;
  if (Array.isArray(value)) return value.length > 0;
  if (isRecord(value)) return Object.keys(value).length > 0;
  return true;
}

/**
 * The first `requires` path the input does not satisfy, or undefined. A path
 * is satisfied when its value is present and not empty.
 */
export function missingRequirement(
  input: object,
  requires: readonly string[] | undefined
): string | undefined {
  return requires?.find((path) => !isPresent(readPath(input, path)));
}

function checkScore(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`returned ${label} ${String(value)}, not a number`);
  }
  if (value < 0 || value > 1) {
    throw new Error(`returned ${label} ${value}, not between 0 and 1`);
  }
  return value;
}

/**
 * Checks a judge output and resolves pass/fail.
 *
 * A skipped output passes and keeps no score requirement. Otherwise `score`
 * and every sub-score must be between 0 and 1, and `pass` defaults to
 * `score >= threshold`.
 */
export function checkJudgeVerdict(
  output: unknown,
  threshold: number
): CheckedJudgeVerdict {
  if (!isRecord(output)) {
    throw new Error('returned no verdict object');
  }
  const result = output as unknown as JudgeVerdict;
  if (result.pass !== undefined && typeof result.pass !== 'boolean') {
    throw new Error('returned a `pass` that is not a boolean');
  }
  if (result.skipped !== undefined && typeof result.skipped !== 'boolean') {
    throw new Error('returned a `skipped` that is not a boolean');
  }
  if (result.skipped) {
    return { ...result, pass: true };
  }
  const score = checkScore(result.score, 'score');
  if (result.subScores !== undefined) {
    if (!isRecord(result.subScores)) {
      throw new Error('returned `subScores` that is not an object');
    }
    for (const [key, sub] of Object.entries(result.subScores)) {
      if (!isRecord(sub)) {
        throw new Error(`returned sub-score "${key}" that is not an object`);
      }
      checkScore(sub.score, `sub-score "${key}"`);
    }
  }
  return {
    ...result,
    score,
    pass: result.pass ?? score >= threshold,
    ...(result.pass !== undefined ? { judgePass: result.pass } : {}),
  };
}

const USAGE_FIELDS = [
  'inputTokens',
  'outputTokens',
  'totalCostUsd',
  'reasoningOutputTokens',
  'durationMs',
  'durationApiMs',
  'cacheReadInputTokens',
  'cacheCreationInputTokens',
] as const;

/**
 * Adds judge usage records. A field is kept only when some record reports it,
 * so a missing cost is not shown as zero.
 */
export function sumJudgeUsage(
  records: Iterable<Partial<UsageMetrics> | undefined>
): Partial<UsageMetrics> | undefined {
  let total: Partial<UsageMetrics> | undefined;
  for (const record of records) {
    if (!record) continue;
    for (const field of USAGE_FIELDS) {
      const value = record[field];
      if (typeof value !== 'number' || !Number.isFinite(value)) continue;
      total ??= {};
      total[field] = (total[field] ?? 0) + value;
    }
  }
  return total;
}

/** Usage of every judge recorded on a case's judge expectation. */
export function caseJudgeUsage(
  judge:
    | {
        usage?: Partial<UsageMetrics>;
        judgeResults?: Array<{ usage?: Partial<UsageMetrics> }>;
      }
    | undefined
): Partial<UsageMetrics> | undefined {
  if (!judge) return undefined;
  return sumJudgeUsage(
    judge.judgeResults ? judge.judgeResults.map((r) => r.usage) : [judge.usage]
  );
}
