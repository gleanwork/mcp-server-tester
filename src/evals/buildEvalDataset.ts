import { z } from 'zod';
import {
  EvalCaseSchema,
  EvalDatasetSchema,
  type EvalDataset,
} from './datasetTypes.js';
import type { EvalManifest } from './evalManifest.js';
import type { MCPHostConfig } from './mcpHost/mcpHostTypes.js';
import { loadEvalDatasetFromObject } from './datasetLoader.js';
import { normalizeSuiteControls } from './manifestValidation.js';

// Source ingestion must not silently discard noncanonical fields. In particular,
// dropping an assertion field can turn an intended failure into a passing case.
const SourceDatasetSchema = EvalDatasetSchema.extend({
  cases: z
    .array(EvalCaseSchema.strict())
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
    const name =
      raw &&
      typeof raw === 'object' &&
      typeof (raw as { name?: unknown }).name === 'string'
        ? `Dataset "${(raw as { name: string }).name}"`
        : 'The dataset';
    throw new Error(
      `${name} isn't a canonical EvalDataset; a dataset in another format needs an explicit dataset source adapter.\n` +
        describeIssues(raw, result.error.issues)
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

/** Keys people reach for that MST spells differently. */
const KEY_HINTS: Record<string, string> = {
  regex: 'matchesPattern',
  judge: 'passesJudge',
  contains: 'containsText',
  pattern: 'matchesPattern',
};

/** One line per issue, naming the case by its id: `case "a" expect: ...`. */
function describeIssues(
  raw: unknown,
  issues: ReadonlyArray<{
    path: PropertyKey[];
    message: string;
    code: string;
    keys?: string[];
  }>
): string {
  const cases = (raw as { cases?: Array<{ id?: unknown }> } | undefined)?.cases;
  return issues
    .map((issue) => {
      const [first, index, ...rest] = issue.path;
      const id =
        first === 'cases' && typeof index === 'number'
          ? cases?.[index]?.id
          : undefined;
      const where =
        first === 'cases' && typeof index === 'number'
          ? [
              `case ${typeof id === 'string' ? `"${id}"` : index}`,
              ...rest.map(String),
            ].join(' ')
          : issue.path.map(String).join('.') || 'dataset';
      const hints =
        issue.code === 'unrecognized_keys'
          ? (issue.keys ?? [])
              .filter((key) => KEY_HINTS[key])
              .map((key) => ` (did you mean "${KEY_HINTS[key]}"?)`)
              .join('')
          : '';
      return `  ${where}: ${issue.message}${hints}`;
    })
    .join('\n');
}
