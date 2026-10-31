/**
 * The built-in `tool-use` judge (ADR 0009): did the client choose the right
 * tools, pass valid arguments, avoid calls it didn't need, and recover from
 * errors? It asks four yes-or-no questions about the trace, one model call
 * each, and fails when any answer is no. It goes beside `toolsTriggered`
 * and `toolCallCount`, which check named tools and counts without a model,
 * and doesn't replace them. It doesn't send the reference answer: the
 * calls are judged against the request.
 */
import type { JudgeDefinition } from '../evals/evalFrameworkTypes.js';
import { TOOL_USE_QUESTIONS } from './prompts/toolUse.js';
import { defineQuestionJudge } from './questionJudge.js';

export const TOOL_USE_JUDGE: JudgeDefinition = defineQuestionJudge({
  description:
    "Asks whether the client chose the right tools, passed valid arguments, avoided calls it didn't need, and recovered from errors: four questions, one call each. Fails when any answer is no.",
  prompts: TOOL_USE_QUESTIONS,
  reference: false,
  questions: () =>
    Object.entries(TOOL_USE_QUESTIONS).map(([id, text]) => ({ id, text })),
});
