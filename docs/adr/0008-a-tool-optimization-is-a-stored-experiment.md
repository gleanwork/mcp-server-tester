---
status: proposed
---

# A tool optimization is a stored experiment

A tool optimization finds the tool metadata (names, descriptions, input schema text) that makes a client call the right tools more often. `runToolOptimization` already runs one: a baseline, candidate variants round by round, a regression guard, a paired sign-flip test corrected for the number of variants tried, and a recommendation. The `optimize-mcp-tool-metadata` skill says how to write candidates.

Using it on a real server showed what is missing.

- **The loop is one function call.** The candidates come from a `proposeVariants` callback inside one process. An agent that wants to read the results and write the next candidates has to write a script that calls the model itself. Nothing on the command line runs an optimization.
- **Nothing is kept between rounds.** A round on a desktop client takes hours. If the process stops, the optimization is lost, though every round's run is on disk. Rebuilding the result from those runs took a patched build.
- **The server can change during an optimization.** A hosted server's tool descriptions change when it deploys. A round measured against new descriptions is compared with a baseline measured against old ones, and nothing notices.
- **The winner's gain is overstated.** The winner is the best of several noisy measurements, so its measured gain is biased upward, even when the corrected test says it is better. The fix is a fresh run of the baseline and the winner, and that is also how a change found on a cheap client is checked on the client that matters.
- **Smaller gaps.** Nothing limits how many variants a run tries. An eval's optimization can't run in an environment (`env` is not passed on). On an eval, nothing reads the server's current metadata, so a proposer or a report can't show what a candidate changed.

## Decision

- **An optimization is a record on disk, and the runs it made.** `<eval dir>/optimizations/<id>/optimization.json` (`mst.optimization/v1`) holds the setup and the history: the eval config and base variant, the tools candidates may change, the metric, the case-grouping rules, the variant budget, the baseline's run (which holds the servers' tool metadata), and each round's candidates with the run that measured them. Each round is an ordinary run (`mst.run/v1`) in the eval's `runs/`, marked with the optimization's id and its role, and never the eval's latest run, so `mst run` keeps comparing with the last ordinary run. Scores are not stored. They are computed again from the runs whenever the record is opened, so stored results never disagree with the runs, and reopening an optimization replays it.
- **It advances in steps, and anyone can take them.**
  - `start` runs the baseline (and a grouping run when no case is tagged `regression`) and reads the servers' tools.
  - `evidence` shows what a proposer may see: the editable tools' current metadata, the other tools' descriptions, each case's expectation and result, the calls of failed trials, and every earlier candidate with its change from the baseline. Held-out cases, tool responses and final answers are left out.
  - `try` runs a set of candidates as one round.
  - `finish` judges every candidate against the number tried and writes the recommendation.
  - An agent, a person or MST's own proposer takes these steps. `runToolOptimization` takes them in one call, and still accepts a `proposeVariants` callback.
- **MST checks every candidate before it runs.** A candidate may change only the tools the optimization lists as editable, and only their name, their description, and the `description` and `title` text inside their input schema. A change to a parameter name, a type, an enum, `required` or the schema's structure is refused, because the server would reject the calls and the round would measure that. Renames follow the tool-surface rules (valid names, no collisions). A round that would go over the variant budget (`maxVariants`; `mst optimize` defaults to 6) is refused before it runs.
- **Every run records the tools its servers served.** When the optimization asks, `runEval` lists the base variant's servers' tools once, before any client starts, and keeps them in the run. A round whose servers serve different metadata from the baseline's fails, and says to start a new optimization. So does a round whose run differs from the baseline's in anything else it measured with: its datasets' content hashes, or the base variant's client, model, options and judges.
- **Confirmation is a fresh run.** `finish --confirm` runs the base variant and the winner again, on every case including the held-out ones, optionally on another eval config with the same servers (a desktop client, for example). The confirmation is one comparison, so it is tested at 0.025 with no correction. With `--confirm`, MST recommends `apply` only when both the optimization and the confirmation show a clear improvement and no broken cases.
- **MST's proposer is a built-in step, not an extension kind.** `propose` builds the same evidence, asks a model through `createJudgeCompletion` (any judge provider, gateways included) for at most the budget left, checks the reply, and runs it as a round. With `--out`, it only writes the candidates, for an agent or a person to edit and `try`. A `proposer` extension kind can come once a second proposer exists.
- **Rounds run where runs run.** The optimization passes `env` and its options to every run, so rounds can collect in Docker.
- **Out of scope.** Applying the winner to the server or the eval config. Changing the dataset, the servers or the tools' behavior. Pairwise judges during rounds. Optimizing several base variants at once (use `--confirm` on another config). Detaching an optimization's coordinator.

## Consequences

- An agent drives an optimization with `mst optimize start`, `evidence`, `try` and `finish`, and needs no script. The skill describes this loop.
- A stopped optimization continues with the next command. A round whose run stopped part way (shards that ended early) is completed with `mst run --resume <run-id>`; a round whose run never finished is run again with `try --retry`.
- `start`, `evidence`, `try` and `finish` ship first. `finish --confirm` and `propose` follow, on the same record.
- `runToolOptimization` on an eval writes a record too. On a dataset, inside a Playwright test, it runs in memory as before.
- The tool metrics (`toolF1`, `toolPrecision`, `toolRecall`) stay dataset metrics. On an eval, `passRate` over cases that assert only `toolsTriggered` is the trigger rate.
- The record is a new file format, versioned like `mst.run/v1`: readers ignore fields they don't know.
