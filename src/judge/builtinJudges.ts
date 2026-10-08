import type { JudgeDefinition } from '../evals/evalFrameworkTypes.js';
import { extensionLookup } from '../plugins/extensions.js';
import { RUBRIC_JUDGE } from './rubricJudge.js';

/** Built-in judges by name. */
function builtinJudges(): Readonly<Record<string, JudgeDefinition>> {
  return { rubric: RUBRIC_JUDGE };
}

const judges = extensionLookup('judges', builtinJudges);

/** The judge `reference` names: a built-in, or `<namespace>/judge/<name>` from a plugin. */
export function getJudge(reference: string): JudgeDefinition {
  return judges.get(reference);
}

/** Built-in and installed plugins' judges, by reference, sorted. */
export function listJudges(): Array<[string, JudgeDefinition]> {
  return judges.list();
}
