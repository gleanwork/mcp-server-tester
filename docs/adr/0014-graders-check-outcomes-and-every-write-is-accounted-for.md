---
status: proposed
---

# Graders check outcomes, and every write is accounted for

An eval case that asks for a write ("post the summary in #team") passes today when the client's transcript shows the right tool call and a judge accepts the answer. Neither shows that the write happened, and for most write cases it can't have happened:

- **Graders read only the transcript and the answer.** `toolsTriggered` checks the calls in the client's own record. Judges read the same record and the final answer. No grader reads the environment after a trial, so MST never checks an outcome ([ADR 0013](0013-mst-uses-anthropics-eval-vocabulary.md)).
- **The dry-run proxy stops writes and keeps little of what it saw.** With planned writes, the default, it records nothing outside the client's transcript. With `simulateWrites`, it records each write in a file, but MST uses the file only to mark matching transcript events. A recorded write that matches no event is dropped, and no grader reads the file.
- **A simulated write tells the client that it succeeded.** The client then says it is done, whatever it sent. A judge that reads "sent" in the answer has learned nothing about the write.
- **MST never sees some servers' writes.** A connector with `forwardWrites: true` sends every call to a server that is trusted to stop writes itself. A server without a connector gets the client's calls directly. MST records nothing about these writes and can't tell whether one was stopped, simulated or applied.
- **A dispatcher hides its target.** A server that runs many tools through one tool that takes a tool name, such as a `run_tool`, can't annotate the dispatcher as read-only, because its target may write. Annotations can't classify these calls, so the proxy can only stop all of them or forward all of them.
- **Variants can get different replies to the same write.** A connector that doesn't pass `simulateWrites` to its proxy gets planned-write results, and MST only prints a warning. A server that stops writes itself answers in its own format. Two variants in one comparison can then see different replies to the same request, and the comparison measures that difference as if it came from the variants.
- **Reports say "passed" either way.** A score doesn't say whether it rests on the client's word, on a request MST saw, or on a state MST read back.

A user who reads a pass rate for write cases expects it to mean that the writes were right. Today it means that the client says it made the right calls.

## Decision

- **Write evidence has four levels, and every score of a write records its level.** The levels, from weakest to strongest:
  1. **claimed:** the answer says the write happened.
  2. **called:** the client's transcript has the call.
  3. **requested:** a boundary MST owns recorded the request, with its server, tool, arguments, and the reply the client got.
  4. **applied:** an outcome check read the environment after the trial and found the expected state.

  A **write case** is a case whose `expected` lists writes, or whose trials made one. The report shows the level beside every pass or fail of a write case. A metric over write cases names the lowest level it includes, so a pass rate built on `called` scores can't be read as one built on `applied` scores.

- **The proxy records every write it stops.** Planned writes and simulated writes both go to the trial's **write record**: one entry per write with its server, tool, arguments, the reply the client got, and the write mode. MST stores the record with the trial, beside its transcript, and gives it to graders and judges.
- **The write record and the transcript must agree.** After each trial, MST matches the two. A recorded write with no matching call in the transcript is an **unreported write**. A write call in the transcript, to a server behind the proxy, with no record is an **unrecorded write**: the client's record shows a call that never reached the server. Either one fails the trial's `writes` grader, and the report lists it.
- **A new code grader, `writes`, checks the write record.** A case lists the writes it expects in `expected.writes`: server, tool, arguments as a partial match, `required` and `exclusive`, with the same matching rules as `toolsTriggered`. The `writes` grader checks them against the write record, never against the transcript, and its scores are at the `requested` level. `toolsTriggered` stays for reads and the client's own tools, at the `called` level.
- **Every server has a known write mode, or the run doesn't start.** The write modes:
  - **planned** and **simulated:** the dry-run proxy stops each write. The record is MST's.
  - **server-planned:** the server stops writes itself and marks each stopped write with a key that the connector names (`plannedWriteKey`). The proxy stays in front for the token, forwards every call, and adds each marked result to the write record, noting that the server stopped it. MST saw the request and the server's answer. It can't see whether the server applied the write anyway.
  - **live:** writes reach the service. This needs `--allow-live-writes` on the command line and an outcome check on every write case.

  At load, MST lists each server's tools. A server with a tool that isn't read-only (by the proxy's rule: `readOnlyHint: true` and not `destructiveHint: true`) and no established write mode is a setup failure. A connector with `forwardWrites` and no `plannedWriteKey`, or a server without a connector, establishes no write mode. The eval config can accept that for one server with `"writes": "unguarded"`, and the report then marks every write case on that variant as unguarded.

- **A dispatcher's calls are recorded, and classified only by the server's mark.** A connector names its dispatcher tools and the arguments that hold the target (`dispatchers`). MST records each dispatched call with its target. A dispatched call whose result carries the server's mark is a write in the record. A dispatched call without the mark is **unclassified**: MST can't tell a read from a write that went through. The report counts unclassified dispatches per variant, and those calls give at most `called` evidence.
- **Variants that are compared get the same kind of reply to a write.** All planned, or all simulated. MST refuses to compare variants whose servers give different kinds, and it names the servers. A connector that ignores `simulateWrites` is an error, not a warning.
- **An outcome check reads the environment through MST's own connection.** A new code grader, `outcome`, runs after the trial. It calls tools through MST's MCP connection, never through the client, and checks the results with the matchers that tests use. It needs the `live` write mode in a test environment, a setup step that seeds the environment, a cleanup step after each trial, and a per-trial marker in the input (`{{trial.id}}`) so that concurrent trials don't read each other's writes. Its scores are at the `applied` level.
- **Judges grade a write from its record.** The judge input includes the write record, with each write's mode and level. The built-in judges' instructions say that a planned or simulated write is the action the client requested, not one that happened, and that they grade its tool, target and arguments. What the answer says about a write is never evidence that it happened. A judge question about a write that has no record answers unknown.

## Consequences

- **2.0 ships the record, the levels, the `writes` grader, the write modes and the load check.** These change the eval config, the stored run and the judge input, so they can't wait for a later minor release.
- **The `outcome` grader ships after 2.0.** 2.0 reserves the `applied` level and the `outcome` grader name, so adding them later breaks nothing. Until then, no write case reaches `applied`, and the report says so.
- **The stored run gains the write record and each server's write mode.** `run.json` records the write mode of every server in every variant. Each score records its evidence level.
- **Existing evals may stop at load.** An eval whose servers expose write tools without a proxy, or through `forwardWrites` without a `plannedWriteKey`, fails until it declares a write mode or `"writes": "unguarded"`. The error names the server and the tools that aren't read-only.
- **Plugin connectors change.** A connector that forwards writes sets `plannedWriteKey`, names its `dispatchers`, and passes `simulateWrites` to its proxy.
- **MST still trusts a server-planned server.** MST sees the server's mark, not the service's state. Only an outcome check shows that a write wasn't applied, so the report never shows a server-planned write above `requested`.
- **`CONTEXT.md` gains entries:** write case, write record, write mode, write evidence and its levels, unreported write, unrecorded write, unclassified dispatch, and outcome check.
