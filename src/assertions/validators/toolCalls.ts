/**
 * Tool call validators for mcp_host simulation results.
 *
 * These validators extract the tool call trace from an MCPHostSimulationResult
 * and apply assertions against expected call lists and counts.
 */
import type { ValidationResult } from './types.js';
import type {
  MCPHostSimulationResult,
  LLMToolCall,
} from '../../evals/mcpHost/mcpHostTypes.js';

export interface ToolCallExpectation {
  calls: Array<{
    name: string;
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

function isSimulationResult(value: unknown): value is MCPHostSimulationResult {
  return (
    typeof value === 'object' &&
    value !== null &&
    'success' in value &&
    'toolCalls' in value &&
    Array.isArray((value as MCPHostSimulationResult).toolCalls)
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

function findMatchingCall(
  actual: LLMToolCall[],
  expected: ToolCallExpectation['calls'][number],
  startIndex = 0
): number {
  for (let i = startIndex; i < actual.length; i++) {
    const call = actual[i]!;
    if (call.name !== expected.name) continue;
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
 * Validates tool calls made during an MCP host simulation.
 *
 * @param response - Must be an MCPHostSimulationResult (from mcp_host mode)
 * @param expectation - Expected tool call specification
 */
export function validateToolCalls(
  response: unknown,
  expectation: ToolCallExpectation
): ValidationResult {
  if (!isSimulationResult(response)) {
    return {
      pass: false,
      message:
        'toolsTriggered expectation requires mcp_host mode — response must be an MCPHostSimulationResult',
    };
  }

  const actual = response.toolCalls;

  // Compute recall: fraction of required calls that were made
  const requiredCalls = expectation.calls.filter((c) => c.required !== false);
  const calledRequiredCount = requiredCalls.filter(
    (expected) => findMatchingCall(actual, expected) !== -1
  ).length;
  const recall =
    requiredCalls.length > 0 ? calledRequiredCount / requiredCalls.length : 1.0;

  // Compute precision: fraction of actual calls that were expected.
  // Always computed so the metric reflects actual tool call efficiency.
  // Whether unexpected calls cause a FAILURE is controlled separately by exclusive=true (lines below).
  const allowedNames = new Set(expectation.calls.map((c) => c.name));
  const precision =
    actual.length > 0
      ? actual.filter((c) => allowedNames.has(c.name)).length / actual.length
      : 1.0;

  const metrics = { precision, recall };

  const order = expectation.order ?? 'any';

  if (order === 'strict') {
    // All calls must appear in the specified sequence
    let searchFrom = 0;
    for (const expected of expectation.calls) {
      const idx = findMatchingCall(actual, expected, searchFrom);
      if (idx === -1) {
        if (expected.required !== false) {
          return {
            pass: false,
            message: `Expected tool '${expected.name}' to be called in sequence (starting from position ${searchFrom}), but it was not found`,
            metrics,
          };
        }
      } else {
        searchFrom = idx + 1;
      }
    }
  } else {
    // Any order: each required call must appear somewhere
    const required = expectation.calls.filter((c) => c.required !== false);
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
          metrics,
        };
      }
    }
  }

  if (expectation.exclusive === true) {
    const unexpected = actual.filter((c) => !allowedNames.has(c.name));
    if (unexpected.length > 0) {
      const names = unexpected.map((c) => `'${c.name}'`).join(', ');
      return {
        pass: false,
        message: `Unexpected tool calls: ${names}. Only ${[...allowedNames].map((n) => `'${n}'`).join(', ')} are allowed`,
        metrics,
      };
    }
  }

  return { pass: true, message: 'All tool call expectations met', metrics };
}

/**
 * Validates the number of tool calls made during an MCP host simulation.
 *
 * @param response - Must be an MCPHostSimulationResult (from mcp_host mode)
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
        'toolCallCount expectation requires mcp_host mode — response must be an MCPHostSimulationResult',
    };
  }

  const count = response.toolCalls.length;
  const { min, max, exact } = options;

  if (exact !== undefined && count !== exact) {
    return {
      pass: false,
      message: `Expected exactly ${exact} tool call(s), but got ${count}`,
    };
  }

  if (min !== undefined && count < min) {
    return {
      pass: false,
      message: `Expected at least ${min} tool call(s), but got ${count}`,
    };
  }

  if (max !== undefined && count > max) {
    return {
      pass: false,
      message: `Expected at most ${max} tool call(s), but got ${count}`,
    };
  }

  return {
    pass: true,
    message: `Tool call count (${count}) is within expected range`,
  };
}
