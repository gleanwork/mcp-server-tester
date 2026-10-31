/**
 * The `task-completion` judge's question (ADR 0009): was the user's goal
 * met? The judge sends it with the shared prompt in `question.ts`. Any
 * change here changes the judge's version, so its calibrations go stale.
 */

export const TASK_COMPLETION_QUESTION = `Did the assistant do what the user asked? Answer "yes" when the final answer gives the user what they asked for (the information they wanted, or the action done) and the trace backs it: a tool result holds that information, or shows that the action succeeded. Answer "no" when the answer gives something the tools didn't return or contradicts what they returned, reports a success or a result that no tool result shows, answers a different request, or stops short, for example after an error the assistant could have worked around. When there is a reference answer, an answer that disagrees with it on what the user asked for is a "no". Judge only what the user asked for: a claim beside it, or a call the task didn't need, doesn't decide this question.`;
