import { assertCurrentRunResult } from './resultFormat.js';
import { readFile, writeFile, mkdir } from 'fs/promises';
import { dirname } from 'path';
import type { EvalRunnerResult } from './evalRunner.js';
import {
  REDACT_STORED_RESPONSES_BY_DEFAULT,
  redactStoredResponses,
} from './resultStore.js';

/**
 * Options for saveBaseline
 */
export interface SaveBaselineOptions {
  /**
   * When true (default), strips responses before saving, under the same
   * policy as every stored result (`redactStoredResponses`). Keeps baseline
   * files small and git-friendly: the baseline is a pass/fail record and the
   * full response is not needed for comparison.
   *
   * Set to false to preserve the complete response in the saved file.
   *
   * @default true
   */
  omitResponses?: boolean;
}

/**
 * Saves eval results to a JSON file for use as a baseline in future runs.
 *
 * @param result - The eval run result to save
 * @param filePath - Path to write the JSON file (parent dirs created automatically)
 * @param options - Save options
 */
export async function saveBaseline(
  result: EvalRunnerResult,
  filePath: string,
  options: SaveBaselineOptions = {}
): Promise<void> {
  const { omitResponses = REDACT_STORED_RESPONSES_BY_DEFAULT } = options;
  const toSave = omitResponses ? redactStoredResponses(result) : result;

  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, JSON.stringify(toSave, null, 2), 'utf8');
}

/**
 * Loads a previously saved baseline from a JSON file.
 *
 * @param filePath - Path to the JSON file written by saveBaseline
 * @returns The saved EvalRunnerResult
 * @throws If the file cannot be read or parsed
 */
export async function loadBaseline(
  filePath: string
): Promise<EvalRunnerResult> {
  const raw = await readFile(filePath, 'utf8');
  const result: unknown = JSON.parse(raw);
  assertCurrentRunResult(result, `Baseline ${filePath}`);
  return result as EvalRunnerResult;
}
