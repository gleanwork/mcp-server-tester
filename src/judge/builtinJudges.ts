import type { JudgeDefinition } from '../evals/evalFrameworkTypes.js';
import { extensionLookup } from '../plugins/extensions.js';
import { CRITERIA_JUDGE } from './criteriaJudge.js';
import { GROUNDED_IN_TOOLS_JUDGE } from './groundedInToolsJudge.js';
import { RUBRIC_JUDGE } from './rubricJudge.js';
import { TASK_COMPLETION_JUDGE } from './taskCompletionJudge.js';
import { TOOL_USE_JUDGE } from './toolUseJudge.js';

/** Built-in judges by name. */
function builtinJudges(): Readonly<Record<string, JudgeDefinition>> {
  return {
    rubric: RUBRIC_JUDGE,
    'task-completion': TASK_COMPLETION_JUDGE,
    'grounded-in-tools': GROUNDED_IN_TOOLS_JUDGE,
    'tool-use': TOOL_USE_JUDGE,
    criteria: CRITERIA_JUDGE,
  };
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
