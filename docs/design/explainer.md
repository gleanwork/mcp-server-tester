# Evals with plugins: design explainer

> **Design proposal.** This is the design behind the [walkthrough](./README.md): how MST, an organization's plugin, and eval configs fit together, what happens during a run, and which contracts hold it together. The [status table](#what-exists-today-vs-what-this-design-asks-for) separates what exists from what's planned. Terms follow [`CONTEXT.md`](../../CONTEXT.md) and [ADR 0002](../adr/0002-common-eval-vocabulary.md).

## Three layers

| Layer                                               | What it is                                                                                                                                                                   | Owner            | Knows the organization?                      |
| --------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- | -------------------------------------------- |
| **MST** (`@gleanwork/mcp-server-tester`, CLI `mst`) | The engine. It loads eval configs, runs every variant on every case in a real client, gathers traces, grades them, compares variants, writes results and renders the report. | Open source      | **No**                                       |
| **Organization plugin** (e.g. `@acme/mst-plugin`)   | The organization's extensions: datasets and judge configs extracted from its own systems, credential storage, an execution environment, result storage.                      | The organization | Yes                                          |
| **Eval configs**                                    | JSON files that say what to evaluate. They live in a personal or team repo, separate from MST and the plugin.                                                                | Eval authors     | Only through the plugin names they reference |

MST orchestrates and runs. The plugin brings data in and sends results out. The eval config is the part that changes from author to author. Anything a plugin does, an outside user can do with built-ins or their own plugin: `file` datasets, the `mst/judge/rubric` judge, the `local` environment, a local credential store, and `file`/`gcs` result stores. Secrets are never part of an eval config or the run format.

## Extension names

Every extension is named `<namespace>/<kind>/<name>`, so a name says what it is: `acme/judge/correctness` is a judge and `acme/env/cloud-vm` is an environment. MST checks the kind against where a name is used, so `acme/judge/correctness` under `datasets` fails at load time. Built-ins live in the `mst` namespace and may be written in short form (`local`, `gcs`, `cowork`). Plugin extensions may not.

| Kind               | Used in            | Purpose                                                                                                         |
| ------------------ | ------------------ | --------------------------------------------------------------------------------------------------------------- |
| `dataset`          | `datasets`         | Resolves a named dataset from a snapshot or live                                                                |
| `judge`            | `judges`           | Pointwise judge: scores one trial against `expected`                                                            |
| `pairwise-judge`   | `pairwiseJudges`   | Compares a variant's trials with the baseline's on one case                                                     |
| `credential-store` | `mst auth --store` | Holds refresh grants so runs can refresh tokens without a browser                                               |
| `interceptor`      | `intercept`        | Sits between client and server to block, record, replay or stub ([parked](#intercepting-server-traffic-parked)) |
| `setup`            | `setup`            | Pre-run work with a matching teardown                                                                           |
| `env`              | `--env`            | Where the client runs during collect                                                                            |
| `result-store`     | `--results`        | Where a run is written                                                                                          |
| `config`           | `extends`          | Shared settings an eval config can extend                                                                       |
| `client`           | `client`           | The application under test (built-ins: `cowork`, `chatgpt`, …)                                                  |

## The eval config

An eval config describes **what** to evaluate: datasets, client, model, trials, graders, servers and variants. It never describes **where** the run happens or **where results go**. Flags decide those (`--env`, `--results`), so the same file runs on a laptop, on VMs, or in CI.

- **Servers** are defined once in a top-level `servers` map whose keys are labels. Variants pick servers by label, which keeps large server sets readable and makes "What differs" in the report a plain set difference.
- **Variants** share cases, client and model, and change one thing (servers here; system prompt, tool metadata or client elsewhere). The first is the baseline unless `baseline` names another.
- **Judges** come from three levels. A case's `judges` are its defaults, the config's `judges` apply to every case, and a variant's `judges` apply to that variant. If the same judge appears at more than one level, the more specific config's options win: variant over eval config over case.
- **Data selection** precedence: `--plugin-option` flag › eval config (`source` / `snapshot`) › plugin default (bundled snapshot).
- **Run-time narrowing** (`--variant`, `--case`, `--trials`, `--max-cases`, `--filter-tag`) never edits the config. A narrowed run is labelled partial, so it never stands in for a full run.

## How a run works: resolve, collect, gather, grade, compare

```text
                    ┌──────────── collect ───────────────┐   ┌── grade ───┐   ┌── compare ──┐
mst run ─► resolve ─►  shard 1: client runs trials ─► traces ─┐
  config,           │  shard 2: client runs trials ─► traces ─┼─► gather ─►  assertions  ─►  metrics, paired
  datasets,         │  …                                      │   (one run    judges           statistics,
  judges            └─ shard N: client runs trials ─► traces ─┘    directory)  pairwise judges  summary, report
```

**Resolve** happens on the coordinator, which is the machine where `mst run` was typed, or the CI runner. MST loads the config, resolves datasets and judge configs once (from a snapshot or live), and records them by content hash in `run.json` along with a new run ID. Every shard and every grader uses exactly this resolved set.

**Collect** happens in the environment. The client runs each case × variant × trial and writes one trace per trial: the input, every tool call (server, tool, args, output), the final answer, usage, cost and timing. Shards write into the same run. Collect doesn't judge anything. Its progress only shows completed trials and infrastructure errors.

**Gather** happens on the coordinator, which waits for every shard and merges their traces into one run directory. If a shard fails, its trials are marked missing rather than failed, and the run is `collect: partial`. `--resume <run-id>` collects only the missing trials.

**Grade** happens centrally, after gather:

- **Assertions** (code graders such as `toolsTriggered`) are deterministic and free.
- **Pointwise judges** give one verdict and score per trial.
- **Pairwise judges** give one verdict per case for each variant against the baseline. They need both variants' traces, which may come from different shards, so grading has to wait for gather.

Grading runs on the coordinator, so judge credentials never reach client machines. Grades sit next to the traces, one file per grader per trial.

**Compare** joins traces and grades into `results.json`, computes per-variant metrics and paired statistics against the baseline into `summary.json`, and builds the report.

Because grading only reads stored traces:

- `--no-grade` stops after gather, and `mst grade <run-id>` grades later.
- Regrading (with a new judge, a new rubric or live judge configs) writes a new run (`<run-id>.g2`) whose `run.json` points at the original traces. Client runs, the expensive part, are never repeated to change grading.
- A run that is collected but not graded still opens in the report, with trials marked "not graded".

With `--detach`, the coordinator also runs remotely as a job the environment provides, so the author can close the laptop. `mst runs list/watch/cancel` follow it.

## Authentication

The model follows Playwright's setup project and `storageState`:

- **Once:** `mst auth --config <file>` walks every server in every variant and gets each one a credential. It uses browser consent where the vendor requires it, and client credentials or service accounts where the plugin has set them up. Long-lived refresh grants go into a credential store: local by default, or a plugin store for remote runs and CI.
- **Each run (setup):** before collect, MST refreshes every grant, hands short-lived access tokens to the client on the machine where it runs, and runs the config's `setup` steps.
- **Each run (teardown):** after collect, MST removes staged tokens and runs each setup step's teardown, even when the run fails or is cancelled.
- **Fail fast:** a missing or revoked grant stops the run before any client starts and names the `mst auth` command that fixes it.

Refresh grants never go into eval configs, results, logs or client VMs.

How tokens reach the client depends on how the client reaches the server. A server reached through a process MST launches on the client's machine is straightforward. A connector the client calls from its vendor's cloud is authorized inside the client's own account, and MST can't stage anything there. See [Intercepting server traffic](#intercepting-server-traffic-parked).

## Environments

`--env` selects where the client runs during collect. The config stays the same: the environment picks the platform driver, for example macOS computer use locally and a Linux desktop driver on a VM. MST ships `local`, and plugins add others such as `acme/env/cloud-vm`. Options pass through with `--env-option key=value` (e.g. `shards=5`).

This follows prior art. Harbor selects execution backends with `--env` (`docker`, `daytona`, `modal`, …) over unchanged task definitions. Inspect AI's sandbox providers are registered by third-party packages and can be overridden with `--sandbox`.

An environment must be able to:

1. Provision the client machines (one per shard).
2. Stage resolved datasets, the case slice and access tokens on each.
3. Run collect for its slice and stream progress.
4. Upload traces into the run's location.
5. Tear down and delete the machines, including on cancel.
6. Optionally host a remote coordinator for `--detach`, and list, watch and cancel runs for `mst runs`.

## Results contract

A run is written locally by default. `--results` sends it to a result store instead: either an inline location (`gs://bucket/prefix`, `file:./dir`) or a named store a plugin provides. `mst stores` lists the stores available.

Every store holds the same versioned **MST run format** (`"format": "mst.run/v1"`, with a published JSON Schema) under `<store>/<eval-name>/runs/<run-id>/`:

```text
run.json                                             # resolve: config + hash, resolved datasets/judges + hashes,
                                                     #   environment, shards, status of each phase
traces/<variant>/<case-id>/<trial>.json              # collect
grades/<grader>/<variant>/<case-id>/<trial>.json     # grade: assertions and pointwise judges
grades/<pairwise-judge>/<variant>-vs-<baseline>/<case-id>.json   # grade: pairwise
results.json                                         # compare: traces + grades joined
summary.json                                         # compare: per-variant metrics and paired statistics
report/index.html
```

Each eval also gets `latest.json`, pointing at the newest complete, graded run. Shards upload traces into the same layout, which is how gather works remotely. MST owns the format and keeps it stable within a major version. Organization-specific consumers, such as an internal dashboard, read the store on their own side and are not part of MST or the plugin. Stored traces leave out raw tool outputs by default (`"redactStoredResponses": false` keeps them). Judges always see full traces, because grading reads them before redaction.

## The report

Every eval uses one report shape: comparing servers, clients, system prompts or tool metadata, or comparing a run with an earlier one. Only the content of **What differs** changes, so authors never relearn the UI for a new kind of eval. The sections are Result, Variants compared, What differs, Case by case, and Why trials failed. A recommendation to apply a variant appears only for tool optimization runs. For comparisons like aggregated vs native there is nothing to apply, so the report describes the results without recommending.

## Intercepting server traffic (parked)

This is a known problem with no solution yet.

**Goal.** We want to sit between the client and each MCP server, the way MSW does for HTTP in tests, to:

- **block** write tools (return a planned write instead of sending a message or filing a ticket),
- **record** every request and response, independent of what the client's own trace shows,
- **replay** recorded responses, so data drift doesn't mix with model or tool-description changes,
- **stub** individual tools with fixed responses.

A config might say `"intercept": "acme/interceptor/dry-run"` or `{ "ref": "mst/interceptor/replay", "from": "<run-id>" }`, and the interceptor would apply to every variant equally.

**Why it's hard.** Interception only works when the client reaches the server through something running on a machine we control. Cowork's own connectors run in Anthropic's cloud: Anthropic's MCP client calls the vendor directly, and there's nowhere to put a proxy. That may also apply to `http` servers Cowork reaches from the cloud rather than from the desktop. This needs checking.

**Directions to evaluate:**

1. **Local bridge per server.** MST launches each server as a local stdio bridge (in the style of `mcp-remote`) to the vendor URL. The bridge is where an interceptor plugs in and where `mst auth` stages tokens. This works for any server we define. It doesn't measure "Cowork with its own connectors", because the client registers a different server.
2. **Registered connector wrappers.** An interceptor wraps a connector definition (URL, auth, tool list), so one wrapper serves both the client's registration and our proxy. It needs a design per client.
3. **Client-hosted connectors stay observation-only.** We accept the client's own trace, without blocking or replay, run those variants against test tenants, and mark them "not intercepted" in the report.

## How a plugin gets its data

A plugin can ship a **snapshot** of datasets and judge configs and offer a **live** mode. For example:

```text
snapshots/
├── manifest.json            # snapshot date, source revisions, content hashes
├── datasets/*.json          # MST datasets
└── judges/*.json            # rubric, model, threshold, required fields
```

A scheduled job in the plugin repo extracts datasets and judge configs from the organization's systems and converts them to MST formats. It validates them with MST, commits them, and publishes a new plugin version only if something changed. Live mode runs the same extraction during resolve. MST sees neither path: it only calls the plugin's `dataset` and `judge` extensions. `run.json` records the snapshot date or live fetch time and the content hash of every dataset and judge config, so any result traces back to its exact data.

## What exists today vs what this design asks for

| Command / key                                                                                 | Today                                                    | Proposed                                                         |
| --------------------------------------------------------------------------------------------- | -------------------------------------------------------- | ---------------------------------------------------------------- |
| `mst run --config`                                                                            | `--manifest`                                             | Rename to `--config` (ADR 0002)                                  |
| `variants`, `baseline`, `client`, `model`, `trials`, `input`, `expected`                      | Partly (`arms`, `host`, `scenario` remain in the schema) | Finish the ADR 0002 renames                                      |
| `<namespace>/<kind>/<name>` names, checked by kind                                            | `namespace/name`                                         | Add the kind segment; reject a kind in the wrong place           |
| Top-level `servers` map; variants pick servers by label                                       | Servers inline per arm                                   | New                                                              |
| `--variant`, `--case`, `--trials`, `--max-cases`, `--filter-tag`                              | `--arm`; others are config keys                          | Run-time narrowing; partial runs labelled                        |
| `plugins`, `extends`                                                                          | ✅ (`--plugins`)                                         | —                                                                |
| `mst plugins`, `mst datasets [pull]`, `mst judges [show]`, `mst stores`                       | ❌                                                       | Generic inspection; dataset extensions gain an optional `list()` |
| `--plugin-option ns.key=value`                                                                | ❌                                                       | Generic run-time plugin options                                  |
| Case / config / variant judge merge rules                                                     | Partly                                                   | Define                                                           |
| `pairwiseJudges` in eval configs, pairwise results in summary and report                      | `comparePairwise` API only                               | Wire into the grade phase and the report                         |
| Resolve → collect → gather → grade → compare; `--no-grade`; `mst grade`; regrade as a new run | Grading is inline per case                               | Split into phases; grading reads stored traces                   |
| Sharded collect, gather, `--resume`                                                           | ❌                                                       | New                                                              |
| `mst auth`, credential stores, token staging and teardown                                     | `mst login` / `mst token` per URL                        | New command and extension kind                                   |
| `setup` steps                                                                                 | ❌                                                       | New extension kind                                               |
| `intercept`, interceptor extension                                                            | ❌                                                       | **Parked**: needs a design for client-hosted connectors          |
| `--env`, `--env-option`, environment extension, built-in `local`                              | ❌                                                       | New extension kind; environment selects the client driver        |
| `--detach`, `mst runs list/watch/cancel`, remote coordinator                                  | ❌                                                       | New                                                              |
| `--results <store or URI>`, `mst open --results`                                              | Stores in config only; `mst open` is local               | Run-time store selection; open from stores                       |
| `mst.run/v1` phase layout and JSON Schema                                                     | Run summary exists, unversioned                          | Version and publish                                              |
| One report shape for every eval                                                               | Experiment tab for tool optimization                     | Generalize; recommendation only for tool optimization            |

## Open questions

1. **Intercepting client-hosted connectors.** Which [direction](#intercepting-server-traffic-parked) do we take? Does Cowork reach configured `http` servers from the desktop or from Anthropic's cloud?
2. **Cases that assume one variant.** Some questions can't be answered fairly without the aggregated server ("What can the Acme connector do for Gmail?"). Should they be tagged (`requires:acme`) and reported separately, or should every variant still run every case?
3. **Skipping consent.** Which vendors offer client credentials or service accounts for test tenants, and which need a person to consent once?
4. **Scope of stored refresh grants.** A single identity that can read every user's grants is too broad. Credential stores need per-user or per-workflow scoping.
5. **Judge cost.** The grade phase should report judge and pairwise usage as its own cost line, separate from client inference.
6. **Graders in datasets.** ADR 0002 renames `expect` to `assertions`. Should per-case judges be a sibling `judges` key, as written here, or sit under `assertions`?
7. **Environment contract.** Is the [list above](#environments) enough for `local`, a cloud VM environment, and a future generic `docker` or `local-vm` environment?
