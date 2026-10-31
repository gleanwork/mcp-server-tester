/**
 * The built-in `grounded-in-tools` judge (ADR 0009): is every claim in the
 * answer supported by a tool result in the trace? It asks one yes-or-no
 * question about the trace. It doesn't send the case's reference answer:
 * the question is where the answer's claims come from, not whether they're
 * right.
 */
import type { JudgeDefinition } from '../evals/evalFrameworkTypes.js';
import { GROUNDED_IN_TOOLS_QUESTION } from './prompts/groundedInTools.js';
import { defineQuestionJudge } from './questionJudge.js';

export const GROUNDED_IN_TOOLS_JUDGE: JudgeDefinition = defineQuestionJudge({
  description:
    'Asks whether every claim in the answer is supported by a tool result in the trace. Yes, no or unknown; the reference answer is not shown.',
  prompts: { question: GROUNDED_IN_TOOLS_QUESTION },
  reference: false,
  questions: () => [
    { id: 'grounded-in-tools', text: GROUNDED_IN_TOOLS_QUESTION },
  ],
});
