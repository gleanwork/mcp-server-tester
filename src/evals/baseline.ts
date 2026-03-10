import { readFile, writeFile, mkdir } from 'fs/promises';
import { dirname } from 'path';
import type { EvalRunnerResult } from './evalRunner.js';

/**
 * Options for saveBaseline
 */
export interface SaveBaselineOptions {
  /**
   * When true (default), strips the `response` field from each case result
   * before saving. Keeps baseline files small and git-friendly — the baseline
   * is a pass/fail record and the full response is not needed for comparison.
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
  const { omitResponses = true } = options;

  const toSave = omitResponses
    ? {
        ...result,
        caseResults: result.caseResults.map(
          ({ response: _response, ...rest }) => rest
        ),
      }
    : result;

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
  return JSON.parse(raw) as EvalRunnerResult;
}

/**
 * Builds a map of case ID → pass status from a baseline result.
 * Used internally by runEvalDataset to tag current results with baseline status.
 */
export function buildBaselinePassMap(
  baseline: EvalRunnerResult
): Map<string, boolean> {
  const map = new Map<string, boolean>();
  for (const result of baseline.caseResults) {
    map.set(result.id, result.pass);
  }
  return map;
}
