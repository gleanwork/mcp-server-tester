/**
 * The `grounded-in-tools` judge's question (ADR 0009): is every claim in
 * the answer supported by a tool result in the trace? The judge sends it
 * with the shared prompt in `question.ts`. Any change here changes the
 * judge's version, so its calibrations go stale.
 */

export const GROUNDED_IN_TOOLS_QUESTION = `Is every claim in the final answer supported by a tool result in the trace?

A claim is anything the answer states as fact: a value, a name, a date, a cause, and also what the assistant did ("I checked it twice") or what a tool returned. Wording, greetings, offers of more help, and questions back to the user aren't claims.

A claim is supported when a tool result in the trace states it, or when it follows directly from tool results (a sum of returned values, a date one result gives) or from the user's request. A claim about a call is supported when the trace shows that call and its result.

Answer "yes" when every claim is supported. An answer that makes no claims, such as one that says a call failed and stops, is "yes" when what it says about the failure matches the trace.

Answer "no" when any claim contradicts a tool result, or states something that no tool result or the request supports, though the trace has the results it would need: general knowledge counts as unsupported, and so does a result from a call that failed.

Answer "unknown" when whether a claim is supported depends on a result the trace doesn't show: one not recorded (observed="false"), cut off, or perhaps missing (complete="false").

Judge only whether the claims come from the trace. Whether the answer is correct, does what the user asked, or used the right tools are other judges' questions: an answer true to the wrong tool's result is still supported.`;
