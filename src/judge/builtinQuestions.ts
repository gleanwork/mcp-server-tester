/**
 * What each built-in yes-or-no judge asks, by its name in results, for a
 * person labeling its trials (`mst label` shows it above the trials). Only
 * built-ins are here: a plugin's judge is named `<namespace>/judge/<name>`,
 * so a bare name can't be one.
 */
import { GROUNDED_IN_TOOLS_QUESTION } from './prompts/groundedInTools.js';
import { TASK_COMPLETION_QUESTION } from './prompts/taskCompletion.js';
import { TOOL_USE_LABEL_QUESTION } from './prompts/toolUse.js';

export const BUILT_IN_JUDGE_QUESTIONS: Readonly<Record<string, string>> = {
  'task-completion': TASK_COMPLETION_QUESTION,
  'grounded-in-tools': GROUNDED_IN_TOOLS_QUESTION,
  'tool-use': TOOL_USE_LABEL_QUESTION,
};
