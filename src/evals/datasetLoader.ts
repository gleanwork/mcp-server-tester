import { readFile } from 'fs/promises';
import { type z } from 'zod';
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
   * Optional schema definitions to attach to the dataset
   *
   * Keys are the names cases refer to in `expect.schema`
   */
  schemas?: Record<string, z.ZodSchema>;

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
 * const dataset = await loadEvalDataset('./data/my-evals.json', {
 *   schemas: {
 *     'weather-response': WeatherResponseSchema,
 *   },
 * });
 */
export async function loadEvalDataset(
  filePath: string,
  options: LoadDatasetOptions = {}
): Promise<EvalDataset> {
  const { schemas, validate = true } = options;

  try {
    const fileContents = await readFile(filePath, 'utf-8');
    const rawData: unknown = JSON.parse(fileContents);

    // Validate if requested
    const serializedDataset: SerializedEvalDataset = validate
      ? validateEvalDataset(rawData)
      : (rawData as SerializedEvalDataset);

    // Create full dataset with schemas
    const dataset: EvalDataset = {
      ...serializedDataset,
      schemas: schemas ?? {},
    };

    return dataset;
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
 *   cases: [
 *     {
 *       id: 'case-1',
 *       toolName: 'get_weather',
 *       args: { city: 'London' },
 *     },
 *   ],
 * });
 */
export function loadEvalDatasetFromObject(
  data: unknown,
  options: LoadDatasetOptions = {}
): EvalDataset {
  const { schemas, validate = true } = options;

  // Validate if requested
  const serializedDataset: SerializedEvalDataset = validate
    ? validateEvalDataset(data)
    : (data as SerializedEvalDataset);

  // Create full dataset with schemas
  const dataset: EvalDataset = {
    ...serializedDataset,
    schemas: schemas ?? {},
  };

  return dataset;
}
