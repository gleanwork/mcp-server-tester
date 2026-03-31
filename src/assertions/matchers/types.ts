/**
 * Matcher Types
 *
 * TypeScript declarations for custom Playwright matchers.
 */

import type { ZodType } from 'zod';
import type {
  TextValidatorOptions,
  SizeValidatorOptions,
  SchemaValidatorOptions,
  PatternValidatorOptions,
  SnapshotSanitizer,
} from '../validators/types.js';
import type { ProviderKind } from '../../judge/judgeTypes.js';
import type { RubricSpec } from '../../judge/rubrics.js';
import type {
  ToolCallExpectation,
  ToolCallCountOptions,
} from '../validators/toolCalls.js';

/**
 * Options for the LLM judge matcher
 */
export interface JudgeMatcherOptions {
  /** Reference response to compare against */
  reference?: unknown;
  /** Score threshold for passing (default: 0.7) */
  passingThreshold?: number;
  /** Number of judge evaluations (scores averaged) */
  reps?: number;
  /** Override the judge provider */
  provider?: ProviderKind;
  /** Override the judge model */
  model?: string;
  /**
   * Name of a registered custom judge executor.
   * When set, the named judge handles the entire evaluation pipeline
   * and its `pass` result is authoritative.
   */
  judge?: string;
}

/**
 * Declaration merging for Playwright matchers
 */
declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace PlaywrightTest {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    interface Matchers<R, T = unknown> {
      /**
       * Validates that a response exactly matches the expected value
       *
       * @param expected - The expected response value
       *
       * @example
       * ```typescript
       * expect(result).toMatchToolResponse({ status: 'ok', count: 42 });
       * ```
       */
      toMatchToolResponse(expected: unknown): R;

      /**
       * Validates that a response matches a Zod schema
       *
       * @param schema - The Zod schema to validate against
       * @param options - Validation options
       *
       * @example
       * ```typescript
       * const WeatherSchema = z.object({
       *   temperature: z.number(),
       *   conditions: z.string(),
       * });
       * expect(result).toMatchToolSchema(WeatherSchema);
       * ```
       */
      toMatchToolSchema(schema: ZodType, options?: SchemaValidatorOptions): R;

      /**
       * Validates that a response contains expected text substrings
       *
       * @param expected - Expected substring(s) to find
       * @param options - Validation options
       *
       * @example
       * ```typescript
       * expect(result).toContainToolText('temperature');
       * expect(result).toContainToolText(['temperature', 'conditions']);
       * expect(result).toContainToolText('HELLO', { caseSensitive: false });
       * ```
       */
      toContainToolText(
        expected: string | string[],
        options?: TextValidatorOptions
      ): R;

      /**
       * Validates that a response matches regex patterns
       *
       * @param patterns - Expected pattern(s) to match
       * @param options - Validation options
       *
       * @example
       * ```typescript
       * expect(result).toMatchToolPattern(/temperature: \d+/);
       * expect(result).toMatchToolPattern(['temp: \\d+', 'humidity: \\d+%']);
       * ```
       */
      toMatchToolPattern(
        patterns: string | RegExp | (string | RegExp)[],
        options?: PatternValidatorOptions
      ): R;

      /**
       * Validates that a response matches a saved snapshot
       *
       * @param name - Snapshot name
       * @param sanitizers - Optional sanitizers for non-deterministic values
       *
       * @example
       * ```typescript
       * expect(result).toMatchToolSnapshot('weather-response');
       * expect(result).toMatchToolSnapshot('user-data', [
       *   { pattern: /\d{4}-\d{2}-\d{2}/, replacement: '[DATE]' },
       * ]);
       * ```
       */
      toMatchToolSnapshot(
        name: string,
        sanitizers?: SnapshotSanitizer[]
      ): Promise<R>;

      /**
       * Validates that a response is (or is not) an error
       *
       * @param expected - What to expect (true for error, false for success, string for specific message)
       *
       * @example
       * ```typescript
       * expect(result).toBeToolError();  // Expects any error
       * expect(result).not.toBeToolError();  // Expects success
       * expect(result).toBeToolError('File not found');  // Expects specific error
       * ```
       */
      toBeToolError(expected?: boolean | string | string[]): R;

      /**
       * Validates that a response passes LLM-as-judge evaluation.
       *
       * Two call signatures:
       * - With rubric: `toPassToolJudge(rubric, options?)` — built-in LLM judge
       * - With named judge: `toPassToolJudge({ judge: 'name' })` — custom judge executor
       *
       * @example
       * ```typescript
       * // Built-in LLM judge with rubric
       * expect(result).toPassToolJudge('Response should be helpful and accurate');
       * expect(result).toPassToolJudge('correctness', {
       *   reference: expectedOutput,
       *   passingThreshold: 0.8,
       * });
       *
       * // Named custom judge (registered via registerJudge)
       * expect(result).toPassToolJudge({ judge: 'glean-completeness' });
       * ```
       */
      toPassToolJudge(
        rubric: RubricSpec,
        options?: JudgeMatcherOptions
      ): Promise<R>;
      toPassToolJudge(options: JudgeMatcherOptions): Promise<R>;

      /**
       * Validates that a response meets size constraints
       *
       * @param options - Size constraints (maxBytes, minBytes)
       *
       * @example
       * ```typescript
       * expect(result).toHaveToolResponseSize({ maxBytes: 10000 });
       * expect(result).toHaveToolResponseSize({ minBytes: 100, maxBytes: 50000 });
       * ```
       */
      toHaveToolResponseSize(options: SizeValidatorOptions): R;

      /**
       * Validates that a response satisfies a custom predicate function
       *
       * Use this as an escape hatch when built-in matchers don't cover your use case.
       * The predicate receives both the raw response and extracted text for convenience.
       *
       * @param predicate - Function that validates the response
       * @param description - Optional description for error messages
       *
       * @example
       * ```typescript
       * // Simple boolean predicate
       * expect(result).toSatisfyToolPredicate((response) => {
       *   return response.data?.items?.length > 0;
       * });
       *
       * // Predicate with custom message
       * expect(result).toSatisfyToolPredicate(
       *   (response, text) => ({
       *     pass: text.includes('success'),
       *     message: 'Expected response to contain "success"',
       *   }),
       *   'success check'
       * );
       *
       * // Async predicate
       * expect(result).toSatisfyToolPredicate(async (response) => {
       *   return await validateWithExternalService(response);
       * });
       * ```
       */
      toSatisfyToolPredicate(
        predicate: ToolPredicate,
        description?: string
      ): Promise<R>;

      /**
       * Validates which tools the LLM called during a mcp_host simulation.
       *
       * @example
       * ```typescript
       * expect(simulationResult).toHaveToolCalls({
       *   calls: [{ name: 'search', arguments: { query: 'hello' }, required: true }],
       *   order: 'any',
       * });
       * ```
       */
      toHaveToolCalls(expectation: ToolCallExpectation): R;

      /**
       * Validates the number of tool calls made during a mcp_host simulation.
       *
       * @example
       * ```typescript
       * expect(simulationResult).toHaveToolCallCount({ min: 1, max: 3 });
       * expect(simulationResult).toHaveToolCallCount({ exact: 2 });
       * ```
       */
      toHaveToolCallCount(options: ToolCallCountOptions): R;
    }
  }
}

/**
 * Predicate result returned by the user's predicate function
 */
export interface PredicateResult {
  /** Whether the predicate passed */
  pass: boolean;
  /** Message explaining the result (shown on failure) */
  message?: string;
}

/**
 * A predicate function that validates a response
 */
export type ToolPredicate = (
  response: unknown,
  text: string
) => boolean | PredicateResult | Promise<boolean | PredicateResult>;

// Export for TypeScript module augmentation
export {};
