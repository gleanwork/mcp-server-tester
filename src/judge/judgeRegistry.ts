/**
 * Custom Judge Registry
 *
 * Allows consumers to register named judge executors that can be referenced
 * by string ID in eval fixtures and programmatic tests. This enables
 * multi-step judge pipelines (LLM call + post-processing), custom scoring
 * logic, and reusable judge configurations without duplicating rubrics.
 */

/**
 * Result returned by a custom judge executor.
 *
 * Custom judges must return a normalized score (0–1). The framework applies
 * the caller's `threshold` (default 0.7) to determine pass/fail. This keeps
 * judges reusable — the same judge can be used with different thresholds in
 * different tests.
 */
export interface CustomJudgeResult {
  /** Normalized score (0–1, where 1 is best) */
  score: number;
  /** Optional reasoning/explanation */
  reasoning?: string;
}

/**
 * A user-defined judge executor function.
 *
 * Custom executors own their entire evaluation pipeline — prompt construction,
 * LLM calls, and post-processing — but return a normalized score. The framework
 * determines pass/fail by comparing the score against the caller's threshold.
 *
 * @param candidate - The actual response to evaluate
 * @param reference - Optional reference/expected response
 * @returns Evaluation result with a normalized score and optional reasoning
 *
 * @example
 * ```typescript
 * const completenessJudge: CustomJudgeExecutor = async (candidate, reference) => {
 *   // Step 1: LLM call with your own prompt and schema
 *   const llmResult = await callLLM(COMPLETENESS_PROMPT, candidate);
 *   const { verdict, reasoning } = JSON.parse(llmResult);
 *
 *   // Step 2: Deterministic post-processing into a normalized score
 *   const score = { Complete: 1.0, Incomplete: 0.5 }[verdict] ?? 0.0;
 *
 *   return { score, reasoning };
 * };
 * ```
 */
export type CustomJudgeExecutor = (
  candidate: unknown,
  reference?: unknown
) => Promise<CustomJudgeResult>;

const registry = new Map<string, CustomJudgeExecutor>();

/**
 * Registers a named custom judge executor.
 *
 * Call this in your test setup (e.g., `playwright.config.ts` or a global setup file)
 * before tests run. The name can then be referenced in JSON eval fixtures via the
 * `judge` field on `passesJudge`.
 *
 * @param name - Unique identifier for the judge
 * @param executor - The judge executor function
 * @throws {Error} If a judge with the same name is already registered
 *
 * @example
 * ```typescript
 * import { registerJudge } from '@gleanwork/mcp-server-tester';
 *
 * registerJudge('glean-completeness', async (candidate, reference) => {
 *   // Step 1: LLM call with your own prompt and schema
 *   const llmResult = await callLLM(COMPLETENESS_PROMPT, candidate);
 *   const { verdict, reasoning } = JSON.parse(llmResult);
 *
 *   // Step 2: Deterministic post-processing into a normalized score
 *   const score = { Complete: 1.0, Incomplete: 0.5 }[verdict] ?? 0.0;
 *
 *   return { score, reasoning };
 * });
 *
 * // Then in tests — same judge, different thresholds:
 * // expect(result).toPassToolJudge({ judge: 'glean-completeness', passingThreshold: 0.8 });
 * // expect(result).toPassToolJudge({ judge: 'glean-completeness', passingThreshold: 0.5 });
 * ```
 */
export function registerJudge(
  name: string,
  executor: CustomJudgeExecutor
): void {
  const existing = registry.get(name);
  if (existing !== undefined) {
    if (existing === executor) {
      return; // same function re-registered (e.g., shared setup imported by multiple files)
    }
    throw new Error(
      `Judge "${name}" is already registered with a different executor. ` +
        `Use clearJudgeRegistry() first if you need to replace it.`
    );
  }
  registry.set(name, executor);
}

/**
 * Retrieves a registered custom judge executor by name.
 *
 * @param name - The judge name to look up
 * @returns The registered executor
 * @throws {Error} If no judge with the given name is registered
 */
export function getRegisteredJudge(name: string): CustomJudgeExecutor {
  const executor = registry.get(name);
  if (!executor) {
    const available =
      registry.size > 0
        ? ` Available judges: ${[...registry.keys()].join(', ')}`
        : ' No judges are registered.';
    throw new Error(
      `Judge "${name}" is not registered.${available} ` +
        `Register it with registerJudge() before tests run.`
    );
  }
  return executor;
}

/**
 * Clears all registered judges. Intended for test teardown.
 */
export function clearJudgeRegistry(): void {
  registry.clear();
}
