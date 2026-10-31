/**
 * What each built-in yes-or-no judge asks, by its name in results, for a
 * person labeling its trials (`mst label` shows it above the trials). Only
 * built-ins are here: a plugin's judge is named `<namespace>/judge/<name>`,
 * so a bare name can't be one.
 */
import { TASK_COMPLETION_QUESTION } from './prompts/taskCompletion.js';

export const BUILT_IN_JUDGE_QUESTIONS: Readonly<Record<string, string>> = {
  'task-completion': TASK_COMPLETION_QUESTION,
};
