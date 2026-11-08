---
status: proposed
---

# MST uses Anthropic's eval vocabulary

[ADR 0002](0002-common-eval-vocabulary.md) renamed MST's terms for 2.0. Where frameworks disagreed, it took the term most of them shared. The result is close to the vocabulary in Anthropic's [Demystifying evals for AI agents](https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents), but it differs in the terms that matter most for agent evals:

- **MST has no word for an outcome.** Anthropic defines the outcome as the final state in the environment at the end of a trial, and keeps it apart from the transcript: an agent can say it booked a flight, but the outcome is whether the reservation exists. `CONTEXT.md` lists "outcome" as a word to avoid, MST has no concept for that final state, and no grader checks one ([ADR 0014](0014-graders-check-outcomes-and-every-write-is-accounted-for.md)).
- **"Environment" means something else.** To Anthropic, the environment is what the agent acts on: the system whose final state is the outcome. In MST, it is where trials are collected: `--env local`, `docker`, or an extension's machines. "Check the outcome in the environment" means two different things.
- **MST chose the synonym.** Anthropic calls the record of a trial a transcript, and gives trace and trajectory as other names. MST uses "trace" and lists "transcript" as a word to avoid.
- **"Assertion" is at a different level.** To Anthropic, a grader holds assertions, also called checks. In MST, an assertion is a kind of grader. Each key of a case's `assertions` (`textContains`, `regex`, `toolsTriggered`, `toolCallCount`) already records its own score, so each one is a grader.
- **Anthropic's other terms are missing.** MST never says that it is an evaluation harness or that a client is an agent harness, and it lists "harness" and "suite" as words to avoid.

Someone who learned evals from Anthropic's guide still has to translate. 2.0 breaks compatibility already; after it, a rename needs a major version.

## Decision

- **Anthropic's guide is the reference.** Where it names a concept, MST uses its term with its meaning. MST departs from it only when the term collides with a term in the MCP specification, or when it would mean two things in MST. Each departure is listed below with its reason. This replaces ADR 0002's rule of taking the most widely shared term. ADR 0002's mapping stays as the way to carry other frameworks' vocabularies across.
- **Adopted as Anthropic defines them:**
  - **Outcome:** the final state of the environment at the end of a trial. It is not what the client says it did, and not how the attempt ended, which is its ending ([ADR 0010](0010-a-trial-ending-is-decided-where-it-ends.md)).
  - **Environment:** what the client acts on: the services behind the MCP servers and their data, such as a Slack workspace or a Jira project.
  - **Transcript:** the complete record of one trial: the client's tool calls (MCP or its own) and their results, skill loads, commands, subagents, tool searches, usage, and the final answer. It replaces "trace".
  - **Code grader, model grader and human grader:** the kinds of grader. Each key of a case's `assertions` is a code grader. Model graders keep the name **judge**, which Anthropic also uses for them. A person who gives labels is a human grader.
  - **Assertion:** one condition a code grader checks, such as one expected call in `toolsTriggered`. The case key keeps its name, because it lists assertions, grouped by grader.
  - **Evaluation harness** and **agent harness:** what MST is, and what a client is together with its model. Both are descriptions. The eval config keeps `client` and `model`.
  - **Eval suite:** Anthropic's long name for what MST calls an eval. "Eval" stays the name, and "suite" is no longer a word to avoid.
  - **Capability eval** and **regression eval:** MST keeps them at case level, as capability cases and regression cases, because one eval holds both. A capability case that passes reliably graduates by taking the `regression` tag.
  - **pass@k** and **pass^k**, over trials. MST already reports pass@1 as the pass rate, and pass^k.
- **Renamed:**
  - MST's current "environment" becomes **runner**: where a run's trials are collected, `local`, `docker`, or an extension's machines. `runner` is also the word CI systems use for the machine that runs a job. `--env` becomes `--runner`, `--env-option` becomes `--runner-option`, `--grade-env` becomes `--grade-runner`, the `env` extension kind becomes `runner` (`acme/runner/cloud-vm`), an environment definition becomes a runner definition, and exports such as `dockerEnvironment` and `machineEnvironment` follow.
  - "Trace" becomes **transcript** wherever a user sees it: the `traces/` directory and the `trace` field in stored runs, `TraceEvent`, judge inputs, the report and the docs. The OpenTelemetry export keeps "trace", because there it is OpenTelemetry's term for a different structure. That includes `storedRunTraces`, which builds a stored run's OpenTelemetry trace requests.
- **Kept, with the reason:**
  - **Case, not task.** Anthropic's task is a test case, and it gives "test case" as another name. The MCP specification has its own tasks: task-augmented requests, added in 2025-11-25 and moved to the Tasks extension in 2026-07-28. MST tests MCP servers and clients that may use them, so "task" would mean two things in MST.
  - **Expected, beside success criteria.** Anthropic's task has defined inputs and success criteria. In MST, a case's success criteria are its `expected` ground truth together with its graders, so `expected` keeps naming the ground truth.
  - **Client and model.** The MCP ecosystem calls Claude Code, Cowork and ChatGPT clients, and the model is set beside the client ([ADR 0011](0011-a-client-is-a-product-and-how-it-runs-is-not-configuration.md)). "Agent harness" describes the pair and isn't a config key.
  - **Variant, baseline, dataset, run.** Anthropic has no terms for these.
  - **"Outcome" stays out of endings.** ADR 0010 chose "ending" for how an attempt ended. "Outcome" now has Anthropic's meaning, which is the reason to keep it out of endings.
- **Old names are errors, not aliases.** As with ADR 0002, a config key, CLI flag, extension kind or export that uses an old name fails with a message naming its replacement.

## Consequences

- **`CONTEXT.md` gives Anthropic's term for each entry that has one.** The entries for outcome, environment, transcript, code grader, model grader, human grader and assertion change, and "Environment" in "Where a run happens" becomes "Runner".
- **ADR 0002's mapping table changes.** Its Anthropic column uses Anthropic's own terms, and the table gains rows for outcome, environment, evaluation harness and assertion.
- **ADRs 0004 and 0005 keep their text.** Each gets a note that ADR 0013 renamed environment to runner. ADRs record the decision as it was made.
- **The stored run layout changes.** `traces/` becomes `transcripts/` and `trace` becomes `transcript`. 2.0 doesn't read runs stored by its release candidates: `mst grade` and `mst open` name the change and stop.
- **The yes-or-no and preference judges get new versions.** Their prompts and the rendered transcript say "transcript" (`<transcript>`, not `<trace>`), and a judge's version covers both, so labels calibrated against the old versions go stale and the numbers in `docs/judges.md` need measuring again. `defineQuestionJudge`'s `needsTrace` becomes `needsTranscript`, and an agentic judge's workspace has `transcript/` in place of `trace/`.
- **Plugins that contribute environments must rename them.** An `acme/env/<name>` extension becomes `acme/runner/<name>`, and validation names the new kind.
- **The rename is mechanical but wide.** "trace" appears about 1,200 times in `src` and "environment" about 600 times, many of them for process environment variables, which keep their name. Each rename lands as its own change so that a review can check it.
