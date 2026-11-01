---
status: accepted
---

# A trial's ending is decided where it ends

Every attempt at a case ends in one of two ways. Either it is a trial, which is graded and counts, or it is an infrastructure failure, which says nothing about the client and is left out. MST answered "which one?" in several places, with different rules:

- **Readers guessed from text.** `isInfrastructureFailure` called an attempt infrastructure when it had any client failure kind, a grading error, or an error message containing `429`, `503`, `network`, `rate limit`, a Cowork binding phrase, or a context-overflow phrase. A failure that a model's answer or a server's error happened to describe in those words was dropped from the pass rate.
- **The shard worker had its own rule.** It counted a trial as infrastructure only when it had an error, so it disagreed with the runner about attempts that had a failure kind but no error.
- **`--resume` collected only two kinds.** It collected `missing` and `not-submitted` attempts again. A desktop that crashed, a Claude session that never bound, or a provider's `503` was left out of the pass rate for good, and the case was graded on the trials it had left.
- **A case whose every trial failed on infrastructure counted as failed.** Its pass rate over no trials was 0.
- **Some failures of the client counted as infrastructure.** Claude Code reaching its turn limit, and any model running out of context, were dropped from the pass rate. These are often exactly what an eval should catch: a server whose tool results fill the context.
- **A grading error counted as infrastructure.** A trial the client completed well was dropped because its judge couldn't run.

## Decision

- **An ending is a trial or an infrastructure failure.** A trial is graded as usual, even when the client errored or ran out of its own turns, time or context. An infrastructure failure is one only when MST can name what broke around the client, from one closed set:
  - the **client app**: the desktop or CLI program MST drives crashed, wasn't available, didn't take the prompt, or gave output MST couldn't read
  - the client's **workspace** (Cowork's VM)
  - the **network**
  - the model **provider**'s API
  - **collection**: MST couldn't collect the trial's result (its shard ended without it, or its artifacts couldn't be copied)
  - an MST **deadline**
  - **setup**: the eval, the case, a client setting or a permission

  It records what broke, why, and whether a retry can help. The client's own detail (ChatGPT's `ambiguous_matching_sessions`, say) stays in its diagnostics for people. No logic reads it.

- **Collection decides an ending; grading never changes it.** A grading error is not an infrastructure failure: the client's attempt ended fine. The trial is ungraded and `mst grade --resume` grades it again.
- **The producer decides, at the point of failure.** A client, the desktop batch or the shard worker records the ending where the attempt ended. `CaseExecution` is the one place a producer's ending becomes the stored one, and the shard worker uses the same adapter. Readers (metrics, comparisons, OTLP, the report, resume) ask the ending module and never parse text. Text matching is allowed only inside a producer, for text it gets from something it doesn't control (a provider SDK's `429`, Claude Desktop's binding message). Errors that MST catches from a client that threw go through one small rule in the ending module, for network errors.
- **Running out of context depends on when.** Mid-trial, the context filled with the client's own turns and tool results: that is a trial. On the first request, the case's prompt doesn't fit before the client did anything: that is a setup failure a retry can't help.
- **A case that is short a trial, or has an ungraded trial, is incomplete.** It is neither passed nor failed, and is left out of pass rates until it is completed. Per-trial measurements (tool calls, duration, usage) use the trials it has.
- **`--resume` collects every infrastructure failure a retry can help.** The ones a retry can't help (a prompt the desktop truncates, a client setting the eval can't run with, a missing permission) stay incomplete. The run reports them as needing a fix to the eval, the case or the setup.
- **`mst.run/v1` records the ending as an additive field.** Each trial record gets an `ending`. `infrastructureError` is still written, derived from the ending, so existing readers keep working. A run stored before this change has no `ending`: the ending module maps one from its old fields when the run is read. Old runs keep the classification they were recorded with, except a trial a grader couldn't score: it becomes an ungraded trial. A Claude Code trial that reached its turn limit stays infrastructure when it is regraded or resumed, because the stored trace doesn't keep the detail needed to reclassify it.
- **Out of scope.** Preflight checks that catch a setup failure before anything is spent (a Claude Code `json` output setting, say). Giving the ending to the Playwright reporter's test results.

## Consequences

- Pass rates on real runs change. Cases that were graded on fewer trials than they declare, or that counted as failed with no trials, become incomplete until they are resumed. Turn-limit and context-overflow failures start counting against the client.
- A run that lost many trials to infrastructure shows them as incomplete cases with a reason, instead of quietly smaller cases.
- A new client maps its own failures onto the closed set. It doesn't add words to a shared list.
- It shipped in two steps in one beta. The first added the ending module, the stored field, the readers and the resume change, with each producer's existing failure kinds mapped as they were, and kept the old shared text list for an error with no failure kind. The second made each producer type its own endings (the `mst` client from its provider's status, Claude Code's turn limit, the context split, ChatGPT and Cowork) and deleted the shared text list. A stored infrastructure failure with no failure kind now reads as a retryable client-app failure.
