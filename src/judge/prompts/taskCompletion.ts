/**
 * The `task-completion` judge's question (ADR 0009): was the user's goal
 * met? The judge sends it with the shared prompt in `question.ts`. Any
 * change here changes the judge's version, so its calibrations go stale.
 */

export const TASK_COMPLETION_QUESTION = `Did the assistant do what the user asked?

Answer "yes" when the final answer gives the user what they asked for (the information they wanted, or the action done), and the trace backs it: a tool result holds that information or shows that the action succeeded, or the request needed no tool and the answer does what was asked.

Answer "no" when the answer contradicts the trace; when it gives a result or reports a success that no tool result shows, though the calls that would show it are in the trace with their results (for example, the only call failed); when it answers a different request; or when it stops short, for example after an error the assistant could have worked around.

Answer "unknown" when whether the task was done depends on a result the trace doesn't show: one not recorded (observed="false"), cut off, or perhaps missing (complete="false").

When there is a reference answer, an answer that disagrees with it on what the user asked for is a "no", unless the trace shows that the reference is out of date: the call the task needs returned other values, and the answer gives those.

Judge only what the user asked for: an extra claim beside it, or a call the task didn't need, doesn't decide this question.`;
