/**
 * The `tool-use` judge's questions (ADR 0009): did the client choose the
 * right tools, pass valid arguments, avoid calls it didn't need, and
 * recover from errors? The judge asks each in its own model call, with the
 * shared prompt in `question.ts`, and fails when any answer is no. Any
 * change here changes the judge's version, so its calibrations go stale.
 *
 * Each question leaves the others' ground alone, so one mistake fails the
 * question it belongs to and not every one. None of them judges the final
 * answer: whether it is right or grounded is other judges' question.
 */

export const TOOL_CHOICE_QUESTION = `Did the assistant call the tools the request needed?

Answer "yes" when the calls the answer rests on are to tools that can give what the user asked for, or the request needed no tool and the assistant called none.

Answer "no" when the assistant relied on a tool that can't give what was asked, such as one that returns a different kind of information or another source for it; or when it needed a tool and called none.

Leave the calls' arguments, extra calls and errors to other questions: a call to the right tool with wrong arguments is "yes" here.`;

export const TOOL_ARGUMENTS_QUESTION = `Did the assistant pass arguments that are valid for each tool and fit the request?

Answer "yes" when each call's arguments are ones its tool accepts, and they ask for what the user asked about: the right file, item, place, operation and values.

Answer "no" when a call's arguments are invalid for its tool (an argument it doesn't take, a value it rejects, a path that doesn't exist), or valid but for something other than the request, and no later call corrects the mistake.

A mistake that a later call corrects is "yes" here: the assistant fixed it, and whether it recovered well is another question. So is a call to a tool that can't give what was asked: this question is only about arguments.`;

export const NEEDED_CALLS_QUESTION = `Did the assistant avoid calls it didn't need?

Answer "yes" when every call helped answer the request. A call that failed, and a call made to find the way after an error (such as listing a folder after a wrong path), count as needed.

Answer "no" when the assistant made a call that didn't help: the same call again with the same arguments when the first worked, a call to a tool or for information the request doesn't need, or a check of a result the trace already shows.

Leave the choice of tool to another question: a single call to the wrong tool is "yes" here.`;

export const ERROR_RECOVERY_QUESTION = `When a call failed, did the assistant recover?

Answer "yes" when no call failed. Answer "yes" when a call failed and the assistant fixed the cause with a later call (different arguments, another tool, or finding the right path first), or when the error was one it couldn't fix (an outage, a permission it lacks) and the answer tells the user so.

Answer "no" when a call failed because of the assistant's own mistake (an invalid argument, a wrong path, a wrong name) and it stopped, gave up, or answered as if the call had worked, without trying to correct it.

A call returned an error when its result is marked as an error or says the request failed.`;

/** The questions, by ID: one model call each. */
export const TOOL_USE_QUESTIONS = {
  'tool-choice': TOOL_CHOICE_QUESTION,
  arguments: TOOL_ARGUMENTS_QUESTION,
  'needed-calls': NEEDED_CALLS_QUESTION,
  'error-recovery': ERROR_RECOVERY_QUESTION,
} as const;

/**
 * What a person labeling the judge's trials answers: one label for the
 * judge's verdict, which fails when any question's answer is no. Each
 * question follows in full.
 */
export const TOOL_USE_LABEL_QUESTION = [
  'Did the assistant use its tools well? Fail the trial if the answer to any of these four questions is no.',
  ...Object.values(TOOL_USE_QUESTIONS),
].join('\n\n---\n\n');
