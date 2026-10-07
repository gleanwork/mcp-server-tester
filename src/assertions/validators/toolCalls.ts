/**
 * Tool call validators for a client case's trace.
 *
 * These validators extract the tool call trace from an MstClientSimulationResult
 * and apply assertions against expected call lists and counts.
 */
import type { ValidationResult } from './types.js';
import type {
  TraceEvent,
  TraceEvidence,
} from '../../evals/evalFrameworkTypes.js';

/** Legacy simulations omit identity metadata; explicit assertions never infer it. */
type TraceCall = Pick<TraceEvent, 'name' | 'arguments'> &
  Partial<Pick<TraceEvent, 'kind' | 'source' | 'server'>>;

interface TraceResponse {
  success: unknown;
  toolCalls: TraceCall[];
  events?: TraceEvent[];
  evidence?: TraceEvidence;
}

export interface ToolCallAssertion {
  calls: Array<{
    name: string;
    kind?: TraceEvent['kind'];
    source?: TraceEvent['source'];
    server?: string;
    arguments?: Record<string, unknown>;
    required?: boolean;
  }>;
  order?: 'strict' | 'any';
  exclusive?: boolean;
}

export interface ToolCallCountOptions {
  min?: number;
  max?: number;
  exact?: number;
}

function isSimulationResult(value: unknown): value is TraceResponse {
  return (
    typeof value === 'object' &&
    value !== null &&
    'success' in value &&
    'toolCalls' in value &&
    Array.isArray((value as TraceResponse).toolCalls)
  );
}

/**
 * Checks whether a value is a `{ $pattern: "regex" }` matcher object.
 */
function isPatternMatcher(
  v: unknown
): v is { $pattern: string; $flags?: string } {
  return (
    typeof v === 'object' &&
    v !== null &&
    '$pattern' in v &&
    typeof (v as Record<string, unknown>)['$pattern'] === 'string'
  );
}

function partialMatch(
  actual: Record<string, unknown>,
  expected: Record<string, unknown>
): boolean {
  return Object.entries(expected).every(([k, v]) => {
    const actualVal = actual[k];

    // { $pattern: "regex", $flags?: "i" } — match actual string against regex
    if (isPatternMatcher(v)) {
      if (typeof actualVal !== 'string') return false;
      const re = new RegExp(v.$pattern, v.$flags);
      return re.test(actualVal);
    }

    if (
      typeof v === 'object' &&
      v !== null &&
      typeof actualVal === 'object' &&
      actualVal !== null
    ) {
      return partialMatch(
        actualVal as Record<string, unknown>,
        v as Record<string, unknown>
      );
    }
    // Key order in nested objects is handled by recursion — this branch only
    // reaches leaf primitives (strings, numbers, booleans, null) and arrays,
    // where JSON.stringify comparison is correct.
    return JSON.stringify(actualVal) === JSON.stringify(v);
  });
}

/** Shared identity matching for assertions and reported tool traces. */
export function matchesIdentity(
  call: TraceCall,
  expected: ToolCallAssertion['calls'][number]
): boolean {
  return (
    (call.name === expected.name ||
      (call.server !== undefined &&
        `${call.server}.${call.name}` === expected.name)) &&
    (expected.kind === undefined ||
      (call.kind ?? 'tool_call') === expected.kind) &&
    (expected.source === undefined || call.source === expected.source) &&
    (expected.server === undefined || call.server === expected.server)
  );
}

/**
 * Why client evidence can't support tool-call assertions, or undefined when it
 * can. Clients that don't report evidence are treated as structured.
 */
export function clientEvidenceProblem(
  evidence: TraceEvidence | undefined
): string | undefined {
  return evidence === undefined || evidence === 'structured'
    ? undefined
    : `Client evidence is ${evidence}; structured tool evidence is required.`;
}

function unverifiedEvidence(
  response: TraceResponse
): ValidationResult | undefined {
  const problem = clientEvidenceProblem(response.evidence);
  if (problem === undefined) return undefined;
  return {
    pass: false,
    message: problem,
    details: { evidence: response.evidence },
  };
}

function findMatchingCall(
  actual: TraceCall[],
  expected: ToolCallAssertion['calls'][number],
  startIndex = 0
): number {
  for (let i = startIndex; i < actual.length; i++) {
    const call = actual[i]!;
    if (!matchesIdentity(call, expected)) continue;
    if (
      expected.arguments !== undefined &&
      !partialMatch(call.arguments ?? {}, expected.arguments)
    ) {
      continue;
    }
    return i;
  }
  return -1;
}

/**
 * How an observed trace lines up with a tool-call assertion. This is the
 * one matcher behind precision, recall and the reported trace.
 */
export interface ToolCallMatch {
  /**
   * Every observed event, in order, and whether the assertion names it
   * (identity only). The fraction marked expected is the precision.
   */
  observed: Array<{ call: TraceCall; expected: boolean }>;
  /**
   * Required calls with no observed call matching their identity and
   * arguments. Their share of the required calls is what recall misses.
   */
  missed: ToolCallAssertion['calls'];
}

/** Matches an observed trace (all event kinds, in order) against an assertion. */
export function matchToolCalls(
  actual: TraceCall[],
  assertion: ToolCallAssertion
): ToolCallMatch {
  return {
    observed: actual.map((call) => ({
      call,
      expected: assertion.calls.some((expected) =>
        matchesIdentity(call, expected)
      ),
    })),
    missed: assertion.calls.filter(
      (expected) =>
        expected.required !== false && findMatchingCall(actual, expected) === -1
    ),
  };
}

/**
 * Validates tool calls made during a client simulation.
 *
 * @param response - Must be an MstClientSimulationResult-compatible response
 * @param assertion - Expected tool call specification
 */
export function validateToolCalls(
  response: unknown,
  assertion: ToolCallAssertion
): ValidationResult {
  if (!isSimulationResult(response)) {
    return {
      pass: false,
      message:
        'toolsTriggered assertion requires a client simulation response with structured tool calls',
    };
  }

  const unverified = unverifiedEvidence(response);
  if (unverified) return unverified;

  // Selectors constrain matching, not the observed trace. Retain every event so
  // exclusive assertions and precision also account for unexpected kinds.
  const actual = response.events ?? response.toolCalls;
  const match = matchToolCalls(actual, assertion);

  // Recall: fraction of required calls that were made.
  const requiredCount = assertion.calls.filter(
    (c) => c.required !== false
  ).length;
  const recall =
    requiredCount > 0
      ? (requiredCount - match.missed.length) / requiredCount
      : 1.0;

  // Precision: fraction of actual calls that were expected. Always computed
  // so the metric reflects tool call efficiency; whether unexpected calls
  // FAIL is controlled separately by exclusive=true (below).
  const allowedNames = new Set(assertion.calls.map((c) => c.name));
  const precision =
    actual.length > 0
      ? match.observed.filter((entry) => entry.expected).length / actual.length
      : 1.0;

  const metrics = { precision, recall };

  const order = assertion.order ?? 'any';

  if (order === 'strict') {
    // All calls must appear in the specified sequence
    let searchFrom = 0;
    for (const expected of assertion.calls) {
      const idx = findMatchingCall(actual, expected, searchFrom);
      if (idx === -1) {
        if (expected.required !== false) {
          return {
            pass: false,
            message: `Expected tool '${expected.name}' to be called in sequence (starting from position ${searchFrom}), but it was not found`,
            details: {
              actual: actual.map((c) => c.name),
              expected: expected.name,
            },
            metrics,
          };
        }
      } else {
        searchFrom = idx + 1;
      }
    }
  } else {
    // Any order: each required call must appear somewhere
    const required = assertion.calls.filter((c) => c.required !== false);
    for (const expected of required) {
      const idx = findMatchingCall(actual, expected);
      if (idx === -1) {
        const argsNote =
          expected.arguments !== undefined
            ? ` with args ${JSON.stringify(expected.arguments)}`
            : '';
        return {
          pass: false,
          message: `Expected tool '${expected.name}'${argsNote} to be called, but it was not`,
          details: {
            actual: actual.map((c) => c.name),
            expected: expected.name,
          },
          metrics,
        };
      }
    }
  }

  if (assertion.exclusive === true) {
    const unexpected = match.observed
      .filter((entry) => !entry.expected)
      .map((entry) => entry.call);
    if (unexpected.length > 0) {
      const names = unexpected.map((c) => `'${c.name}'`).join(', ');
      return {
        pass: false,
        message: `Unexpected tool calls: ${names}. Only ${[...allowedNames].map((n) => `'${n}'`).join(', ')} are allowed`,
        details: {
          actual: actual.map((c) => c.name),
          unexpected: unexpected.map((c) => c.name),
        },
        metrics,
      };
    }
  }

  return { pass: true, message: 'All tool call assertions met', metrics };
}

/**
 * Validates the number of tool calls made during a client simulation.
 *
 * @param response - Must be an MstClientSimulationResult-compatible response
 * @param options - Count constraints (min, max, exact)
 */
export function validateToolCallCount(
  response: unknown,
  options: ToolCallCountOptions
): ValidationResult {
  if (!isSimulationResult(response)) {
    return {
      pass: false,
      message:
        'toolCallCount assertion requires a client simulation response with structured tool calls',
    };
  }

  const unverified = unverifiedEvidence(response);
  if (unverified) return unverified;

  const count = (response.events ?? response.toolCalls).filter(
    (call) => (call.kind ?? 'tool_call') === 'tool_call'
  ).length;
  const { min, max, exact } = options;

  if (exact !== undefined && count !== exact) {
    return {
      pass: false,
      message: `Expected exactly ${exact} tool call(s), but got ${count}`,
      details: { actual: count, expected: exact },
    };
  }

  if (min !== undefined && count < min) {
    return {
      pass: false,
      message: `Expected at least ${min} tool call(s), but got ${count}`,
      details: { actual: count, min },
    };
  }

  if (max !== undefined && count > max) {
    return {
      pass: false,
      message: `Expected at most ${max} tool call(s), but got ${count}`,
      details: { actual: count, max },
    };
  }

  return {
    pass: true,
    message: `Tool call count (${count}) is within expected range`,
  };
}
