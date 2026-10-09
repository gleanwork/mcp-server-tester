# How MST evals work

> **Design proposal.** This is the companion to the [walkthrough](./README.md). The walkthrough shows _what_ you type. This page explains _what happens_ when you type it, and _why_ it works that way. Some of it is built and some isn't; [What's built](#whats-built-and-whats-planned) at the end keeps track.

It assumes you know roughly what an MCP server is: a service that gives an AI application tools to call, such as "search Slack" or "create a Jira issue". It doesn't assume anything else.

## The problem

Say you run an MCP server that searches across all of a company's tools. You want to know whether Cowork (Anthropic's desktop assistant) gives better answers with your server than with one MCP server per vendor (Slack's, Jira's, GitHub's, and so on).

Asking Cowork one question and reading the answer won't tell you much:

- **The same question gets different answers.** The model behind Cowork isn't deterministic. One good answer could be luck.
- **One question isn't representative.** You need dozens of realistic questions, each with a known good answer.
- **"Better" needs a consistent judge.** Reading 450 answers by hand isn't practical, and it isn't consistent either. An LLM can grade them, but it has to grade every answer the same way.
- **The comparison has to be fair.** Both setups need the same questions, the same model and the same client, with only the servers changed.
- **Real clients are desktop apps.** Cowork has to be driven like a person would drive it, on a Mac or a Linux VM. That's slow, so a full run takes an hour or more.
- **Your data and credentials are yours.** The questions, the grading rules and the logins are specific to your company and can't live in an open-source tool.

MST handles all of this. You describe the comparison in one file, and MST runs it, grades it and tells you what changed.

## Terms

These terms are used throughout this page and the walkthrough. The full glossary is in [`CONTEXT.md`](../../CONTEXT.md).

**What you're testing**

| Term         | Meaning                                                                                                | In the walkthrough                               |
| ------------ | ------------------------------------------------------------------------------------------------------ | ------------------------------------------------ |
| **Client**   | The AI application under test. MST drives it the way a user would.                                     | `cowork`                                         |
| **Model**    | The LLM the client uses.                                                                               | `claude-opus-4-8`                                |
| **Server**   | An MCP server the client can call tools on.                                                            | `acme`, `slack`, `jira`, …                       |
| **Variant**  | One setup being tested: a client, a model and a set of servers. Every variant gets the same questions. | `aggregated`, `native`, `aggregated-plus-native` |
| **Baseline** | The variant the others are compared against. The first one, unless you say otherwise.                  | `aggregated`                                     |

**What you're testing with**

| Term            | Meaning                                                                                                  | In the walkthrough                               |
| --------------- | -------------------------------------------------------------------------------------------------------- | ------------------------------------------------ |
| **Case**        | One question for the client (the **input**) and what a good result looks like (the **expected** answer). | `e2e-0011`: "What is the process for reporting…" |
| **Dataset**     | A named list of cases.                                                                                   | `acme/dataset/info-seeking` (50 cases)           |
| **Eval**        | Everything about one comparison: datasets, variants, how to grade, what to measure.                      | —                                                |
| **Eval config** | The JSON file that defines one eval.                                                                     | `evals/cowork-aggregated-vs-native.json`         |

**What happens during a run**

| Term      | Meaning                                                                                                              | In the walkthrough                                      |
| --------- | -------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| **Trial** | One attempt at one case by one variant. Each case runs several trials, because answers vary.                         | `"trials": 3`                                           |
| **Trace** | The record of one trial: every tool call (server, tool, arguments, result), the final answer, tokens, cost and time. | `traces/native/e2e-0011/2.json`                         |
| **Run**   | One execution of an eval: every variant on every case, for every trial. It has a **run ID**.                         | `7f3c2a`: 50 cases × 3 variants × 3 trials = 450 trials |

**How answers are graded**

| Term               | Meaning                                                                                                                                             | In the walkthrough               |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------- |
| **Grader**         | Anything that grades a trial: an assertion or a judge.                                                                                              | —                                |
| **Assertion**      | A grader written in code. It's deterministic and costs nothing, for example "the client called a search tool".                                      | —                                |
| **Judge**          | A grader that is an LLM. It reads the trial and the expected answer and gives a **score**: 0 to 1, pass or fail, and why.                           | `acme/judge/correctness`         |
| **Pairwise judge** | A judge that reads two variants' trials of the same case and gives a **preference**: which is better, by how much, and why.                         | `acme/pairwise-judge/preference` |
| **Comparison**     | How each variant differs from the baseline: metric changes, whether each change is better, worse or unclear, and which cases improved or regressed. | The table at the end of a run    |

**How MST is extended**

| Term                 | Meaning                                                                                                                                 | In the walkthrough                                       |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| **Plugin**           | A package that adds things to MST, all under one **namespace**.                                                                         | `@acme/mst-plugin`, namespace `acme`                     |
| **Extension**        | One thing a plugin adds, of a given **kind**: a dataset, a judge, a connector, an environment, a result store, …                        | `acme/judge/correctness` is an extension of kind `judge` |
| **Connector**        | An extension that describes one vendor's MCP server: its URL, how to sign in, and optionally a proxy in front of it.                    | `acme/connector/slack`                                   |
| **Credential store** | Where long-lived sign-ins (refresh grants) are kept, so runs can get fresh tokens without a browser.                                    | `acme/credential-store/secret-manager`                   |
| **Environment**      | Where the client runs: your machine, containers on it, or VMs. Each machine runs one **shard** of the trials.                           | `local`, `docker`, `acme/env/cloud-vm`                   |
| **Result store**     | Where a run's files are written.                                                                                                        | a local directory, `acme/result-store/eval-results`      |
| **Snapshot**         | A frozen copy of a plugin's datasets and judge settings, published nightly. The alternative is **live**: fetched at the start of a run. | `snapshot 2026-10-06`                                    |

## Three parts, three owners

An eval brings together three things, and each one has a different owner.

```mermaid
flowchart LR
  config["<b>Your eval config</b><br/>what to compare"]
  plugin["<b>Your company's plugin</b><br/>datasets, judges, sign-ins,<br/>VMs, where results go"]
  mst["<b>MST</b><br/>runs the clients,<br/>grades, compares"]
  out["Results<br/>and report"]
  config --> mst
  plugin --> mst
  mst --> out
```

| Part                      | Owner                              | Changes when                              | Knows about your company?         |
| ------------------------- | ---------------------------------- | ----------------------------------------- | --------------------------------- |
| **MST**                   | Open source                        | MST releases                              | No                                |
| **Your company's plugin** | Your company (a platform team)     | Datasets, judges or infrastructure change | Yes                               |
| **Eval configs**          | You or your team, in your own repo | You want to compare something new         | Only the plugin's extension names |

**Why split it this way:**

- **MST stays open source.** Nothing company-specific goes in it: no tenant URLs, no internal datasets, no cloud accounts. Anything a company needs, its plugin adds.
- **Each part changes at its own pace.** Eval configs change daily, the plugin changes when data or infrastructure changes, and MST changes when it releases. Keeping them apart means a new comparison never needs a plugin release, and a new dataset never needs an MST release.
- **Anyone can do without a plugin.** MST has built-ins for everything a plugin adds: datasets from files, a generic rubric judge, your machine as the environment, local sign-ins, and results in a local directory or a GCS bucket.

### Extension names say what they are

Every extension is named `<namespace>/<kind>/<name>`. `acme/judge/correctness` is a judge from the `acme` plugin, and `acme/env/cloud-vm` is an environment from the same plugin.

**Why:** an eval config mentions a lot of names. With the kind in the name, you can read a config without looking anything up. MST also checks the kind against where the name is used, so putting a judge under `datasets` fails straight away instead of halfway through a run. MST's own built-ins can be written without a namespace (`local`, `file`, `cowork`).

## A run, from top to bottom

This follows `mst run --config evals/cowork-aggregated-vs-native.json` through every step, using the walkthrough's example: 50 cases × 3 variants × 3 trials = 450 trials.

```mermaid
flowchart TD
  s1["<b>1. Load</b><br/>read the eval config and plugins"]
  s2["<b>2. Resolve</b><br/>fix the exact cases and judge settings"]
  s3["<b>3. Prepare</b><br/>check sign-ins, hand out fresh tokens"]
  s4["<b>4. Collect</b><br/>the client answers every case, 3 times per variant"]
  s5["<b>5. Clean up</b><br/>remove tokens, reset the client"]
  s6["<b>6. Gather</b><br/>put every trace in one run"]
  s7["<b>7. Grade</b><br/>assertions and judges score each trace"]
  s8["<b>8. Compare</b><br/>each variant against the baseline"]
  s9["<b>9. Report</b><br/>write results, print the summary"]
  s1 --> s2 --> s3 --> s4 --> s5 --> s6 --> s7 --> s8 --> s9
```

Steps 4 and 5 happen wherever the client runs. Every other step happens where you typed `mst run`, which is your machine or a CI job. That machine is called the **coordinator**.

### 1. Load

MST reads the eval config, loads every plugin it lists, and checks the config: every name exists, every name is the right kind, and every variant's servers are defined.

_Why first:_ a typo should cost you a second, not an hour of Cowork time. `--dry-run` stops after step 3 and prints the plan.

### 2. Resolve

MST turns names into exact content. `acme/dataset/info-seeking` becomes 50 specific cases, and `acme/judge/correctness` becomes a specific rubric, model and pass threshold. Both come from the plugin's snapshot unless you ask for live data. MST records a content hash of each one in the run's `run.json`.

_Why:_ a run's results only mean something if you know exactly what was tested and how it was graded. If the dataset changes tomorrow, today's run still says which version it used, and two runs can be compared knowing whether their data matched.

_Why snapshots by default:_ a snapshot doesn't change under you, so rerunning last week's eval gives you last week's questions. Live data is there when you want the newest cases.

### 3. Prepare

Every server in every variant needs a valid sign-in before Cowork starts.

- **Earlier, once:** you ran `mst auth`. For each server it found how that vendor signs in (browser consent, client credentials, or a fixed token) and saved the long-lived sign-in, called a **refresh grant**, in a credential store.
- **Now, every run:** MST checks that every grant the run needs is in the store. If one is missing or revoked, the run stops here and prints the `mst auth` command that fixes it. Otherwise, MST exchanges each grant for a short-lived access token and hands it to the client: in a private file for servers behind a local proxy, or in a private environment variable for direct connections.
- **During the run:** tokens in private files are refreshed before they expire, so an hour-long run doesn't fail at minute 61. A token passed in an environment variable can't be refreshed mid-run, so servers with short-lived tokens go through a local proxy that reads the file.

A **connector** is what tells MST how a vendor's server signs in and how the client should reach it. A connector can put a proxy in front of the server. A **dry-run proxy** lets read tools through and returns a "planned write" for anything that would send a message or change data.

_Why this way:_ you sign in once, not once per run, and no token ever goes into an eval config, a trace, a log or a report. Short-lived tokens are the only thing handed out, and only for as long as the run lasts.

The [connectors and `mst auth` contract](./auth-and-connectors.md) has the details.

### 4. Collect

The client runs every trial. For each one, MST:

1. sets the client up with that variant's servers and model,
2. gives it the case's input, as a user would,
3. waits for it to finish (or time out),
4. writes the **trace**: every tool call with its server, arguments and result, the final answer, tokens, cost and time.

Nothing is graded here. The progress output only shows which trials finished (`●`) and which hit an infrastructure problem (`!`), such as the client crashing. An infrastructure problem isn't a failed trial, because the client never got to answer.

**Where it runs:** wherever `--env` says. With `local` (the default), MST drives Cowork on your Mac. With `docker`, MST drives Cowork in Linux containers on your machine. With `acme/env/cloud-vm`, the plugin starts VMs and MST drives Cowork on each of them. You can split the trials across several containers or VMs, called **shards**, with `--env-option shards=5`. A case's variants and trials all go to one shard.

```mermaid
flowchart TD
  prep["<b>Coordinator</b> (your machine or CI)<br/>load, resolve, prepare"]
  subgraph env["Environment: --env acme/env/cloud-vm --env-option shards=5"]
    direction LR
    vm1["VM 1<br/>90 trials"]
    vm2["VM 2<br/>90 trials"]
    vm5["… VM 5<br/>90 trials"]
  end
  store[("Result store<br/>traces from every VM")]
  post["<b>Coordinator</b><br/>gather, grade, compare, report"]
  prep --> env
  env -- traces --> store
  store --> post
```

**How a shard runs:** an environment only creates machines and opens a **channel** to each one. A channel can run a command with its input and output attached, and copy files in and out. Docker, SSH and Kubernetes all have one. Over the channel, MST copies the shard's cases to the machine and starts a **worker** there. The worker drives the client with the same code a local run uses, writes each trace as it finishes, and reports its progress back. Tokens reach the worker over the channel's input and are kept only in memory-backed files; refresh grants never leave the coordinator. [ADR 0004](../adr/0004-environments-run-shards-over-a-channel.md) has the protocol.

_Why `--env` is a flag and not part of the eval config:_ the question you're asking doesn't change with where the client runs. Keeping it out of the config means the same file works for a quick local check, a full run on VMs, and a nightly CI job.

_Why containers:_ in a container, Cowork can't be disturbed by your windows and doesn't touch your own Claude Desktop, and every run starts from the same desktop. You can also run several at once on one machine.

_Why VMs:_ a desktop client can only run one conversation at a time per machine. Fifty cases × three variants × three trials, at a minute or more each, is hours on one machine. Five VMs make it about an hour.

### 5. Clean up

As soon as collect ends, MST removes the access tokens it handed out, stops any proxies, and puts the client back how it found it. Containers and VMs are deleted; `--env-option keep=failed` keeps one whose shard failed, so you can look at it. Clean-up runs even when the run fails or you press Ctrl-C.

_Why straight after collect:_ tokens and VMs are only needed while the client is running. Grading doesn't need them, so they aren't kept for it.

### 6. Gather

The coordinator waits until every shard has uploaded its traces, then puts them all into one run directory. If a shard failed, its trials are marked **missing**, not failed. `mst run --resume <run-id>` collects only the missing trials.

_Why:_ the next step compares variants case by case. If case `e2e-0011` ran for `aggregated` on VM 1 and for `native` on VM 4, both traces have to be in one place first.

### 7. Grade

Now, on the coordinator, every grader reads the traces:

| Grader                                            | Reads                                                            | Gives                                               | How many in the example                  |
| ------------------------------------------------- | ---------------------------------------------------------------- | --------------------------------------------------- | ---------------------------------------- |
| Assertions                                        | one trace                                                        | a score                                             | per trial, per assertion                 |
| Judge (`acme/judge/correctness`)                  | one trace plus the case's expected answer                        | a score: 0–1, pass or fail, and why                 | 450                                      |
| Pairwise judge (`acme/pairwise-judge/preference`) | one variant's trials and the baseline's trials for the same case | a preference: which is better, by how much, and why | 100 (50 cases × 2 non-baseline variants) |

A case's own dataset can ask for extra judges in its `judges`, beside its assertions (`e2e-0011` asks for `acme/judge/completeness`). The eval config's judges apply to every case, on top of the case's own. A variant's judges replace the eval config's for that variant. When a case lists a judge the eval config also lists, the case's settings win.

A case **passes** for a variant when enough of its trials pass. By default that means all of them, and `passThreshold` lowers the bar.

_Why grading is a separate step and not done during collect:_

- **The pairwise judge needs both sides.** It can't run until both variants' trials of a case exist, and they may come from different VMs.
- **Every trial is graded the same way.** One grading pass, with one resolved set of judge settings, grades all 450 trials. No trial is graded by an older rubric because its VM started earlier.
- **You can regrade without re-running.** Collect is slow and expensive, and grading is cheap. Because grading only reads stored traces, `mst grade <run-id>` can regrade with a new rubric, an extra judge or today's live judge settings, without starting Cowork again. A regrade is saved as a new run (`7f3c2a.g2`) that points at the original traces, so the first grading isn't overwritten.
- **Judge credentials stay on the coordinator.** The VMs never need them.

`--no-grade` stops after step 6, which is useful for collecting overnight and grading in the morning.

### 8. Compare

MST compares each variant with the baseline, on every metric: pass rate, judge score, pairwise win rate, cost per case, latency and tool use.

Because every variant answered the same cases, MST compares them **case by case** (a paired comparison), not just average against average. For each metric it decides whether the variant is **better**, **worse** or **unclear** compared with the baseline. "Unclear" means the difference is small enough that it could be chance at this number of cases and trials. It also lists the cases that improved or regressed.

_Why paired:_ some cases are hard for every variant and some are easy for every variant. Comparing the same case across variants removes that spread, so a real difference shows up with fewer cases.

_Why "unclear" exists:_ with 50 cases, a two-point change in pass rate is usually noise. Saying "unclear" stops people from acting on noise.

### 9. Report

MST writes `results.json` (every trial with its trace and scores) and `summary.json` (every variant's metrics and comparisons), prints the summary table, and builds the report that `mst open` shows.

Everything goes to the **result store**: a local directory by default, or wherever `--results` points. As with `--env`, that's a flag and not part of the config, for the same reason.

## What's in a run

Every result store holds the same layout. Each part was written by one of the steps above:

```text
<eval-name>/runs/<run-id>/
├── run.json        # step 2: the config, exact datasets and judge settings (with hashes),
│                   #   the environment (its options, shards, and each shard's image
│                   #   and client version), and how far each step got
├── traces/         # step 4: one file per trial, with its shard
├── scores/         # step 7: one score per grader per trial; one preference per case per variant
├── results.json    # step 9: traces and scores joined
├── summary.json    # step 9: per-variant metrics and comparisons
└── report/         # step 9: what `mst open` shows
```

This layout is a contract, versioned as `mst.run/v1`, and MST keeps it stable within a major version. That stability is why other tools can rely on it. A company dashboard can read `summary.json` straight from the bucket without depending on MST's code. It's also what makes resume and regrade possible: both read what the earlier steps left behind.

Stored traces leave out raw tool results by default, because they can hold real company data. Judges see the full traces, because grading happens before the results are stored.

## Reading the report

The report has the same sections for every eval, whether you're comparing servers, models, system prompts or tool descriptions:

1. **Result:** for each variant, whether it's better, worse or unclear than the baseline.
2. **Variants compared:** the summary table, with confidence intervals if you want them.
3. **What differs:** each variant's setup next to the baseline's. For this eval, that's which servers each variant had.
4. **Case by case:** every trial's trace, every score, and every preference.
5. **Why trials failed:** failed trials grouped by cause, such as no tool called, wrong tool, judged incorrect, or infrastructure error.

_Why one layout:_ the questions are always the same: is it better, by how much, where, and why. Learning a new screen for each kind of eval gets in the way of answering them.

The report only recommends applying a variant for **tool optimization**, which compares rewritten tool descriptions against the current ones. Comparing your server with the vendors' servers isn't a change you'd "apply", so the report shows the result and leaves the decision to you.

## Where the plugin's data comes from

A plugin can ship datasets and judge settings in two ways:

- **Snapshot (the default):** a scheduled job in the plugin's repo pulls datasets and judge settings from the company's systems, converts them to MST's formats, checks them with MST, and publishes a new plugin version only if something changed. A run uses whatever snapshot is in the installed plugin version.
- **Live:** the plugin fetches the same data during step 2.

Which one a run uses, from strongest to weakest: the `--plugin-option` flag, then the eval config (`"source": "live"` or `"snapshot": "<date>"`), then the plugin's default. MST doesn't know or care where the data came from. It only asks the plugin for a dataset or a judge by name and records what it got.

## Known gap: Cowork's own connectors

The dry-run proxy and token hand-out in step 3 need a path we control between the client and the server:

```mermaid
flowchart LR
  subgraph ours["A machine we control"]
    cowork1["Cowork"] --> proxy["Local proxy<br/>tokens, dry-run, recording"]
  end
  proxy --> vendor1["Vendor's<br/>MCP server"]

  cowork2["Cowork"] -.-> cloud
  subgraph theirs["Anthropic's cloud"]
    cloud["Cowork's own connector"]
  end
  cloud --> vendor2["Vendor's<br/>MCP server"]
```

- **Top: servers we configure.** Cowork talks to a process on the same machine, and that process talks to the vendor. That's where MST hands out tokens and where a dry-run proxy blocks writes. This works today.
- **Bottom: Cowork's own connectors.** When you add Slack from Cowork's connector directory, Anthropic's cloud calls the vendor. There's nowhere for us to put a proxy, so we can't block writes, record calls fully, or replay responses. Sign-in also happens in the Cowork account, not through `mst auth`.

That matters because "Cowork with its own connectors" is the setup most users actually have. The options:

1. **Use servers we configure for every variant** (top path). This is fair and fully controlled, but it isn't quite the native experience.
2. **Wrap connectors** so one definition serves both Cowork's registration and our proxy. This needs a design for each client.
3. **Treat Cowork's own connectors as observe-only.** We run them against test accounts, rely on Cowork's own trace, and mark the variant "not intercepted" in the report.

There's a related unknown: it's not yet confirmed whether Cowork reaches the plain `http` servers we configure from the desktop or from Anthropic's cloud. If it's the cloud, those servers need a local proxy too.

## What's built and what's planned

| Area                                                    | Built                                                                                                                                                                                                                                                      | Planned                                                                                            |
| ------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| Eval configs, variants, baseline, client, model, trials | `--config`, `--variant` (one or more), `--case`, `--filter-tag`, `--max-cases`, `--trials`; narrowed runs marked partial                                                                                                                                   | —                                                                                                  |
| Extension names                                         | `namespace/kind/name`, checked by kind (ADR 0003); `mst/` built-ins; a top-level `servers` map keyed by label                                                                                                                                              | —                                                                                                  |
| Datasets and judges from plugins                        | `plugins`, `extends`; case `judges` beside `assertions`; judge merge rules (case plus eval config, the case's settings win)                                                                                                                                | `mst plugins`, `mst datasets`, `mst judges`, `--plugin-option`                                     |
| Sign-ins (step 3)                                       | Connectors, `mst auth` / `status` / `revoke`, local credential store, token hand-out and renewal, dry-run proxy                                                                                                                                            | Plugin credential stores; handing tokens to VMs                                                    |
| Environments (steps 4–5)                                | Local Cowork on macOS and Linux; each trial's trace written when it finishes; the `env` kind, `--env`, `--env-option` (`shards`, `keep`), shards over a channel (`mst collect`), gather with missing trials, `--resume`, the environment in `run.json`     | `docker`, `--detach`, `mst runs`                                                                   |
| Grading as its own step (6–7)                           | Grading during collect, or skipped (`mst run --no-grade`); `mst grade <run> --config` regrades stored traces as a new run (`.g2`, `gradedFrom`); `comparePairwise` as an API; pairwise judges in eval configs (`pairwiseJudges`, after every variant runs) | `mst grade` without `--config`; `--judge`; regrades reading the traces in place rather than a copy |
| Results (8–9)                                           | Run summaries; result stores set in the config; the `mst.run/v1` layout and its JSON Schemas; the report written with each run; `mst open` for local runs; the MCP Playwright reporter writing the same runs, evals only                                   | `--results`, `mst open --results`                                                                  |
| Report                                                  | Tool optimization report                                                                                                                                                                                                                                   | The same layout for every eval                                                                     |
| Cowork's own connectors                                 | —                                                                                                                                                                                                                                                          | An approach; see [Known gap](#known-gap-coworks-own-connectors)                                    |

## Open questions

1. **Cowork's own connectors.** Which of the three options above, and does Cowork reach configured `http` servers from the desktop or from the cloud?
2. **Cases only one variant can answer.** "What can the Acme connector do for Gmail?" isn't fair to the native variant. Should such cases be tagged and reported separately?
3. **Skipping consent.** Which vendors offer client credentials or service accounts for test accounts, so `mst auth` needs no browser?
4. **Who can read stored sign-ins.** A shared credential store must keep each person's grants separate.
5. **Judge cost.** Grading should report its own cost, separate from the client's.
6. **Judges in datasets.** Settled: a case's judges sit beside its assertions, in `judges`.
7. **What an environment must do.** Settled ([ADR 0004](../adr/0004-environments-run-shards-over-a-channel.md)): create machines and open a channel to each (run a command, copy files in and out). MST does the rest over that channel, the same way for containers and VMs: it hands each worker its trials and tokens, reads its progress, and gathers its traces. Still open: whether MST ships the desktop image or each organization supplies its own.
