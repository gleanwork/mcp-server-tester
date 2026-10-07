import { z } from 'zod';
import {
  EvalCaseSchema,
  EvalDatasetSchema,
  type EvalDataset,
} from './datasetTypes.js';
import type { EvalConfig } from './evalConfig.js';
import { loadEvalDatasetFromObject } from './datasetLoader.js';
import { normalizeSuiteControls } from './configValidation.js';

// Source ingestion must not silently discard noncanonical fields. In particular,
// dropping an assertion field can turn an intended failure into a passing case.
const SourceDatasetSchema = EvalDatasetSchema.extend({
  cases: z
    .array(EvalCaseSchema.strict())
    .min(1, 'dataset must have at least one case'),
});

/**
 * Validate a canonical EvalDataset and apply the eval config case limit.
 * Sources never attach a client or manufacture assertions. Use an opt-in
 * dataset source adapter to migrate other formats before canonical validation.
 */
export function buildEvalDataset(
  raw: unknown,
  evalConfig: EvalConfig
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
  return selectEvalCases(dataset, evalConfig);
}

/** Apply the same tag selection and case cap to built-in and plugin datasets. */
function selectEvalCases(
  dataset: EvalDataset,
  evalConfig: EvalConfig
): EvalDataset {
  const controls = normalizeSuiteControls(evalConfig);
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

/**
 * A run narrowed from the command line (`mst run --case <id>... --trials <n>`).
 * Named cases replace the config's tag selection and case cap.
 */
export interface CaseNarrowing {
  cases?: readonly string[];
  trials?: number;
}

/** The config's selection, or the named cases, with `trials` on every case. */
export function narrowEvalCases(
  dataset: EvalDataset,
  evalConfig: EvalConfig,
  narrowing: CaseNarrowing = {}
): EvalDataset {
  const ids = narrowing.cases?.length ? new Set(narrowing.cases) : undefined;
  const selected = ids
    ? dataset.cases.filter((evalCase) => ids.has(evalCase.id))
    : selectEvalCases(dataset, evalConfig).cases;
  return {
    ...dataset,
    cases:
      narrowing.trials === undefined
        ? selected
        : selected.map((evalCase) => ({
            ...evalCase,
            trials: narrowing.trials,
          })),
  };
}

/** Fail before anything runs when a named case is in no dataset. */
export function assertNamedCases(
  datasets: readonly EvalDataset[],
  cases: readonly string[] | undefined
): void {
  if (!cases?.length) return;
  const known = new Set(
    datasets.flatMap((dataset) => dataset.cases.map((evalCase) => evalCase.id))
  );
  const missing = cases.filter((id) => !known.has(id));
  if (missing.length)
    throw new Error(
      `No case ${missing.map((id) => `"${id}"`).join(', ')} in the config's datasets. Cases: ${[...known].join(', ')}`
    );
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
