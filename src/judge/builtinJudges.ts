import type { JudgeDefinition } from '../evals/evalFrameworkTypes.js';
import { extensionLookup } from '../plugins/extensions.js';

/** Built-in judges by name. None yet; rubric judges join in a later change. */
function builtinJudges(): Readonly<Record<string, JudgeDefinition>> {
  return {};
}

const judges = extensionLookup('judges', builtinJudges);

/** The judge `reference` names: a built-in, or `namespace/name` from a plugin. */
export function getJudge(reference: string): JudgeDefinition {
  return judges.get(reference);
}
