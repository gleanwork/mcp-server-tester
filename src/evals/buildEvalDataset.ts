import { z } from 'zod';
import {
  EvalCaseSchema,
  EvalDatasetSchema,
  type EvalDataset,
} from './datasetTypes.js';
import type { EvalManifest } from './evalManifest.js';
import type { MCPHostConfig } from './mcpHost/mcpHostTypes.js';
import { loadEvalDatasetFromObject } from './datasetLoader.js';
import { normalizeSuiteControls } from './frameworkRegistries.js';

// Source ingestion must not silently discard noncanonical fields. In particular,
// dropping an assertion field can turn an intended failure into a passing case.
const SourceDatasetSchema = EvalDatasetSchema.extend({
  cases: z
    .array(
      EvalCaseSchema.strict().superRefine((case_, context) => {
        if ((case_.mode ?? 'direct') === 'direct') {
          if (!case_.toolName) {
            context.addIssue({
              code: 'custom',
              path: ['toolName'],
              message: 'Direct cases require toolName.',
            });
          }
        } else if (!case_.scenario) {
          context.addIssue({
            code: 'custom',
            path: ['scenario'],
            message: 'Host cases require scenario.',
          });
        }
      })
    )
    .min(1, 'dataset must have at least one case'),
});

/**
 * Validate a canonical EvalDataset and apply the manifest case limit.
 * The host argument is retained for API compatibility; sources never infer a
 * mode, attach a host, or manufacture assertions. Use an opt-in dataset source
 * adapter to migrate other formats before canonical validation.
 */
export function buildEvalDataset(
  raw: unknown,
  _hostConfig: MCPHostConfig | undefined,
  manifest: EvalManifest
): EvalDataset {
  const result = SourceDatasetSchema.safeParse(raw);
  if (!result.success) {
    throw new Error(
      'Expected a canonical EvalDataset. Noncanonical inputs require an explicit dataset source adapter. ' +
        result.error.message
    );
  }
  const dataset = loadEvalDatasetFromObject(result.data);
  return selectEvalCases(dataset, manifest);
}

/** Apply the same tag selection and case cap to built-in and plugin datasets. */
export function selectEvalCases(
  dataset: EvalDataset,
  manifest: EvalManifest
): EvalDataset {
  const controls = normalizeSuiteControls(manifest);
  const tags = controls.filterTags as string[] | undefined;
  const cases = tags?.length
    ? dataset.cases.filter((evalCase) =>
        evalCase.tags?.some((tag) => tags.includes(tag))
      )
    : dataset.cases;
  return {
    ...dataset,
    cases: controls.maxCases ? cases.slice(0, controls.maxCases) : cases,
  };
}
