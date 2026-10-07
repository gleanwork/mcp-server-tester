import { readFile } from 'fs/promises';
import {
  type EvalDataset,
  type SerializedEvalDataset,
  validateEvalDataset,
} from './datasetTypes.js';

/**
 * Options for loading an eval dataset
 */
export interface LoadDatasetOptions {
  /**
   * Whether to validate the loaded dataset
   * @default true
   */
  validate?: boolean;
}

/**
 * Loads an eval dataset from a JSON file
 *
 * @param filePath - Absolute path to the JSON file
 * @param options - Load options
 * @returns The loaded and validated dataset
 * @throws {Error} If file cannot be read or JSON is invalid
 * @throws {z.ZodError} If validation fails
 *
 * @example
 * const dataset = await loadEvalDataset('./data/my-evals.json');
 */
export async function loadEvalDataset(
  filePath: string,
  options: LoadDatasetOptions = {}
): Promise<EvalDataset> {
  try {
    const fileContents = await readFile(filePath, 'utf-8');
    return loadEvalDatasetFromObject(JSON.parse(fileContents), options);
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new Error(
        `Failed to parse JSON from ${filePath}: ${error.message}`
      );
    }
    throw error;
  }
}

/**
 * Loads an eval dataset from a plain object
 *
 * Useful for programmatically creating datasets in tests
 *
 * @param data - The dataset data
 * @param options - Load options
 * @returns The loaded and validated dataset
 * @throws {z.ZodError} If validation fails
 *
 * @example
 * const dataset = loadEvalDatasetFromObject({
 *   name: 'my-test-dataset',
 *   cases: [{ id: 'weather', input: 'What is the weather in London?' }],
 * });
 */
export function loadEvalDatasetFromObject(
  data: unknown,
  options: LoadDatasetOptions = {}
): EvalDataset {
  const { validate = true } = options;
  const serializedDataset: SerializedEvalDataset = validate
    ? validateEvalDataset(data)
    : (data as SerializedEvalDataset);
  return { ...serializedDataset };
}
