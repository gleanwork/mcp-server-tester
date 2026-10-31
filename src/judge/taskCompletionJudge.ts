/**
 * The built-in `task-completion` judge (ADR 0009): was the user's goal met?
 * A claim of success that no tool result supports fails. It asks one
 * yes-or-no question about the trace, with the case's reference answer
 * when it has one.
 */
import type { JudgeDefinition } from '../evals/evalFrameworkTypes.js';
import { TASK_COMPLETION_QUESTION } from './prompts/taskCompletion.js';
import { defineQuestionJudge } from './questionJudge.js';

export const TASK_COMPLETION_JUDGE: JudgeDefinition = defineQuestionJudge({
  description:
    "Asks whether the assistant did what the user asked, as the trace shows: a success no tool result supports fails. Yes, no or unknown, with the case's reference answer when it has one.",
  prompts: { question: TASK_COMPLETION_QUESTION },
  reference: true,
  questions: () => [{ id: 'task-completion', text: TASK_COMPLETION_QUESTION }],
});
