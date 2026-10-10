# Comparing MCP server setups in Cowork

> **Design proposal.** This is how we intend evals to be run. Some of these commands and config keys don't exist yet; each is marked planned where it appears. The [explainer](./explainer.md) covers the design, the run lifecycle, and what exists today versus what's planned.

This walkthrough runs one eval end to end. It uses a fictional company, Acme, whose private plugin `@acme/mst-plugin` provides datasets, judges, a VM environment and a result store.

**Goal:** find out whether Cowork answers Acme's info-seeking questions better with Acme's aggregated MCP server, with the vendors' own MCP servers (Slack, Jira, Linear, GitHub, Gmail, Drive, Calendar), or with both, using the same model.

## Prerequisites

- Node.js 22+
- Access to your organization's MST plugin package (here `@acme/mst-plugin`)
- Cloud credentials for the plugin's result store and credential store (only for remote runs, CI, or remote results)
- For local Cowork runs: Claude Desktop on your Mac
- For container runs: Docker (or OrbStack), and Claude Desktop's Linux package or a desktop image your organization publishes

## 1. Install

Keep eval configs in your own repo, either a personal one or a team repo of use cases.

```bash
mkdir cowork-evals && cd cowork-evals
npm init -y
npm i -D @gleanwork/mcp-server-tester@beta @acme/mst-plugin

# Once, on a Mac that will run Cowork locally
npx mst cowork setup

# Once, to run Cowork in containers (section 6; planned)
npx mst env setup docker --app ./claude-desktop-linux.deb
# → built mst-desktop@sha256:9c1e…
```

See what the plugin provides (`mst plugins` is planned):

```bash
npx mst plugins --plugins @acme/mst-plugin
```

```text
@acme/mst-plugin 0.14.0 (namespace: acme, snapshot 2026-10-06)
  dataset            acme/dataset/info-seeking, acme/dataset/action-taking, acme/dataset/tool-selection
  judge              acme/judge/correctness, acme/judge/completeness, acme/judge/groundedness
  pairwise-judge     acme/pairwise-judge/preference
  connector          acme/connector/search, acme/connector/slack, acme/connector/jira, …
  credential-store   acme/credential-store/secret-manager   (planned kind)
  setup              acme/setup/reset-test-tenant           (planned kind)
  env                acme/env/cloud-vm
  result-store       acme/result-store/eval-results
  config             acme/config/cowork
```

Names are `<namespace>/<kind>/<name>`, so `acme/judge/correctness` is a judge.

## 2. Find datasets and judges

Datasets and judge configs come from the plugin's nightly snapshot by default. You can pull live data or pin an older snapshot instead.

```bash
npx mst datasets --plugins @acme/mst-plugin
npx mst judges --plugins @acme/mst-plugin
npx mst judges show acme/judge/correctness
```

```text
acme/dataset/info-seeking     50 cases    snapshot 2026-10-06   tags: source:correctness, tool:*
acme/dataset/action-taking    32 cases    snapshot 2026-10-06
acme/dataset/tool-selection   120 cases   snapshot 2026-10-06
```

Extract a dataset to read, diff, or freeze it:

```bash
npx mst datasets pull acme/dataset/info-seeking --out datasets/info-seeking.json
npx mst datasets pull acme/dataset/info-seeking --source live
npx mst datasets pull acme/dataset/info-seeking --snapshot 2026-10-01
```

Each case has an `input`, an `expected` answer, tags, and optional default judges:

```json
{
  "id": "e2e-0011",
  "input": "What is the process for reporting a newly discovered customer-impacting outage?",
  "expected": {
    "answer": "File a SEV in the incident tool, page the on-call IC, then…"
  },
  "tags": ["source:correctness"],
  "judges": ["acme/judge/completeness"]
}
```

## 3. Write the eval config

`evals/cowork-aggregated-vs-vendor-mcp.json`:

```json
{
  "$schema": "https://unpkg.com/@gleanwork/mcp-server-tester@beta/schema/eval-config.schema.json",
  "name": "cowork-aggregated-vs-vendor-mcp",
  "plugins": ["@acme/mst-plugin"],
  "extends": ["acme/config/cowork"],

  "datasets": ["acme/dataset/info-seeking"],

  "client": "cowork",
  "model": "claude-opus-4-8",
  "trials": 3,

  "judges": ["acme/judge/correctness"],
  "pairwiseJudges": ["acme/pairwise-judge/preference"],
  "metrics": ["passed", "judge_score", "cost_usd", "duration_s", "tool_count"],
  "redactStoredResponses": false,

  "servers": {
    "acme": { "connector": "acme/connector/search" },
    "slack": { "connector": "acme/connector/slack" },
    "jira": { "connector": "acme/connector/jira" },
    "linear": { "connector": "acme/connector/linear" },
    "github": { "connector": "acme/connector/github" },
    "gmail": { "connector": "acme/connector/gmail" },
    "gdrive": { "connector": "acme/connector/gdrive" },
    "gcal": { "connector": "acme/connector/gcal" }
  },

  "variants": [
    { "name": "aggregated", "servers": ["acme"] },
    {
      "name": "vendor-mcp",
      "servers": [
        "slack",
        "jira",
        "linear",
        "github",
        "gmail",
        "gdrive",
        "gcal"
      ]
    },
    {
      "name": "aggregated-plus-vendor-mcp",
      "servers": [
        "acme",
        "slack",
        "jira",
        "linear",
        "github",
        "gmail",
        "gdrive",
        "gcal"
      ]
    }
  ]
}
```

- **`servers`** defines each server once. The key is its label in traces and the report. Each one names a plugin connector, which says where the server is, how to sign in, and how Cowork reaches it (here, through a dry-run proxy). A server can also be a plain `http` or `stdio` entry with a literal or environment-backed token; `mst auth` signs in only to connector servers.
- **`variants`** run the same cases with the same client and model, and only their servers differ. The first variant is the baseline; set `"baseline"` to choose another.
- **`datasets`** use the snapshot by default. To pin a snapshot: `{ "ref": "acme/dataset/info-seeking", "snapshot": "2026-10-01" }`. For live data: `{ "ref": "…", "source": "live" }`. (One `{ "type": … }` form is planned to replace `ref`.)
- **`redactStoredResponses: false`** keeps full traces in the run. Stored traces are redacted by default, and a redacted run can't be collected with `--no-grade`, regraded (section 8) or resumed (section 7). Letting a plugin's shared config set this is planned.
- **`judges`** apply to every case, on top of each case's own judges. Pointwise judges score each trial. Pairwise judges compare each variant with the baseline on each case.
- **`setup`** (planned, optional) lists plugin steps that run before collection and tear down afterwards, e.g. `acme/setup/reset-test-tenant`.

Point write-capable servers at test tenants or test accounts. A connector's dry-run proxy blocks writes, or answers them with a success reply when the eval config sets `"simulateWrites": true`. MST can't block writes for Cowork's own connectors, the ones added in the Claude account, so disconnect any that could write to real accounts.

Check the plan without running anything. Today `--dry-run` prints the plan as JSON and doesn't check sign-ins; the text plan below, with its `credentials` line, is planned:

```bash
npx mst run --config evals/cowork-aggregated-vs-vendor-mcp.json --dry-run
```

```text
cowork-aggregated-vs-vendor-mcp
  datasets    acme/dataset/info-seeking (snapshot 2026-10-06, 50 cases, sha256 3f9a…)
  client      cowork · model claude-opus-4-8 · 3 trials per case
  variants    aggregated (baseline) · 1 server
              vendor-mcp · 7 servers
              aggregated-plus-vendor-mcp · 8 servers
  graders     acme/judge/correctness, acme/judge/completeness (12 cases)
              acme/pairwise-judge/preference (each variant vs aggregated)
  env         local (macOS) · 1 shard
  results     .mcp-test-results/cowork-aggregated-vs-vendor-mcp/
  total       450 trials · 100 pairwise preferences
  credentials 2 of 8 servers need `mst auth` (gmail, gcal)
```

The `env` line says where the trials would run. With `--env docker --env-option shards=4`, it reads `docker (linux/amd64) · 4 shards · image mst-desktop@sha256:9c1e…`.

## 4. Authenticate once

```bash
npx mst auth --config evals/cowork-aggregated-vs-vendor-mcp.json --store acme/credential-store/secret-manager
```

```text
acme     oauth           ✓ valid
slack    oauth           → opening browser for consent…  ✓ saved
jira     oauth           ✓ valid
linear   oauth           ✓ valid
github   github-app      ✓ client credentials (no consent needed)
gmail    google-oauth    → opening browser for consent…  ✓ saved
gdrive   google-oauth    ✓ valid (shares gmail grant)
gcal     google-oauth    ✓ valid (shares gmail grant)
```

Each run refreshes these grants and hands short-lived tokens to the client, then removes them when it finishes. Leave out `--store` to keep grants on your machine only. Remote runs and CI need a shared credential store. Today `--store` takes a directory; plugin credential stores such as `acme/credential-store/secret-manager` are planned.

```bash
npx mst auth status --config evals/cowork-aggregated-vs-vendor-mcp.json
npx mst auth revoke --config evals/cowork-aggregated-vs-vendor-mcp.json --server slack
```

## 5. Run locally

Use small local runs to iterate:

```bash
npx mst run --config evals/cowork-aggregated-vs-vendor-mcp.json --variant vendor-mcp --case e2e-0011 --trials 1
npx mst run --config evals/cowork-aggregated-vs-vendor-mcp.json --max-cases 5
npx mst run --config evals/cowork-aggregated-vs-vendor-mcp.json --filter-tag source:correctness
```

```text
setup     auth staged for 8 servers · desktop lease acquired
collect   aggregated                  e2e-0000 ●●●  e2e-0001 ●●●  e2e-0002 ●●●
          vendor-mcp                  e2e-0000 ●●●  e2e-0001 ●●●  e2e-0002 ●●!
          aggregated-plus-vendor-mcp  e2e-0000 ●●●  e2e-0001 ●●●  e2e-0002 ●●●
teardown  tokens removed · Claude Desktop profile restored
grade     aggregated                  e2e-0000 ✓✓✓  e2e-0001 ✓✓✓  e2e-0002 ✓✓✗
          vendor-mcp                  e2e-0000 ✓✗✓  e2e-0001 ✓✓✓  e2e-0002 ✗✗–
          aggregated-plus-vendor-mcp  e2e-0000 ✓✓✓  e2e-0001 ✓✓✓  e2e-0002 ✓✓✓
● collected  ! infrastructure error  ✓ passed  ✗ failed  – missing
```

The client runs the trials first. Judges then grade the collected traces.

## 6. Run in containers

> **Planned.** MST has no `docker` environment yet (DEVPLAT-1451), and today no environment other than `local` can run connector servers or variants with tool metadata, so this config can't run in one yet.

Run the same config in 4 Linux containers on your machine:

```bash
npx mst run --config evals/cowork-aggregated-vs-vendor-mcp.json --env docker --env-option shards=4
```

```text
setup     auth staged for 8 servers · 4 containers from mst-desktop@sha256:9c1e…
collect   shard 1  e2e-0003 ●●● ●●● ●●●  e2e-0007 ●●● ●●● ●●●
          shard 2  e2e-0000 ●●● ●●● ●●●  e2e-0011 ●●● ●●! ●●●
          shard 3  e2e-0001 ●●● ●●● ●●●
          shard 4  e2e-0002 ●●● ●●● ●●●  e2e-0005 ●●● ●●● ●●●
teardown  tokens removed · 4 containers deleted
grade     …
```

Cowork runs in the containers, so you can keep using your Mac. Each container is a fresh desktop: it has nothing from your own Claude Desktop, and leaves nothing behind. A case's variants and trials all run in one container, so each comparison is made on one desktop, minutes apart.

To use an image your organization publishes instead of building one, add `--env-option image=registry.acme.example/mst-desktop@sha256:…`.

Watch a container's desktop while it runs (`mst runs` is planned), or keep a container that failed so you can look at it:

```bash
npx mst runs view <run-id> --shard 2
npx mst run --config evals/cowork-aggregated-vs-vendor-mcp.json --env docker --env-option shards=4 --env-option keep=failed
```

## 7. Run remotely

Use the same config, on 5 fresh VMs. They run the same image as the containers in section 6. The limits in section 6 apply here too, and `--results` is planned (DEVPLAT-1461):

```bash
npx mst run --config evals/cowork-aggregated-vs-vendor-mcp.json \
  --env acme/env/cloud-vm --env-option shards=5 \
  --results acme/result-store/eval-results
```

The VMs run the trials. Your machine gathers their traces, runs the judges, and writes the results. Ctrl-C deletes the VMs and keeps the traces collected so far. Rerun with `--resume <run-id>` to collect only what's missing. `--env-option keep=failed` keeps a VM whose shard failed, as it does for containers.

To walk away from a long run, detach it (`--detach` and `mst runs` are planned):

```bash
npx mst run --config evals/cowork-aggregated-vs-vendor-mcp.json \
  --env acme/env/cloud-vm --env-option shards=5 \
  --results acme/result-store/eval-results --detach
# → run 7f3c2a started on acme/env/cloud-vm

npx mst runs list --env acme/env/cloud-vm
npx mst runs watch 7f3c2a
npx mst runs cancel 7f3c2a
```

### On a schedule

```yaml
# .github/workflows/cowork-aggregated-vs-vendor-mcp.yml
on:
  schedule: [{ cron: '0 9 * * 3,5' }]
  workflow_dispatch: {}
jobs:
  eval:
    runs-on: ubuntu-latest
    permissions: { contents: read, id-token: write, packages: read }
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 22 }
      # authenticate to your cloud for the credential store and result store
      - run: npm ci
      - run: >
          npx mst run --config evals/cowork-aggregated-vs-vendor-mcp.json
          --env acme/env/cloud-vm --env-option shards=5
          --results acme/result-store/eval-results
```

## 8. Regrade without re-running

Judges read stored traces, so you can change or add judges and regrade without running Cowork again. This needs the run stored with `"redactStoredResponses": false`, as the config in section 3 sets:

```bash
npx mst run --config evals/cowork-aggregated-vs-vendor-mcp.json --env acme/env/cloud-vm --no-grade
npx mst grade 7f3c2a --config evals/cowork-aggregated-vs-vendor-mcp.json
# → run 7f3c2a.g2 (traces from 7f3c2a)
```

Planned: `mst grade` without `--config`, and the `--plugin-option` and `--judge` flags:

```bash
npx mst grade 7f3c2a --plugin-option acme.source=live
npx mst grade 7f3c2a --judge acme/judge/groundedness
```

## 9. Find your results

Runs are written locally by default:

```text
.mcp-test-results/cowork-aggregated-vs-vendor-mcp/
├── latest.json         # the newest complete, full run
└── runs/<run-id>/
    ├── run.json        # the config's identity, each variant's setup, resolved datasets and judges,
    │                   #   environment, phase status
    ├── traces/         # one trace per trial
    ├── artifacts/      # each trial's client artifacts, for judges
    ├── scores/         # one score per grader per trial; pairwise preferences per case
    ├── results.json    # traces and scores joined
    ├── summary.json    # per-variant metrics and comparisons
    └── report/
```

Planned (DEVPLAT-1461): `--results` sends the run somewhere else instead. Today a result store set in the eval config gets each run's results and summary, and the run directory stays local.

```bash
--results acme/result-store/eval-results     # a store your plugin provides
--results gs://my-bucket/cowork-evals        # any GCS location
--results file:./shared-results              # any local directory
```

```bash
npx mst stores --plugins @acme/mst-plugin   # planned
```

`run.json` records where the run ran: the environment, its options and the number of shards. Recording each shard's image digest and Claude Desktop version, and each trace's shard, is planned for 2.0.

## 10. Read your results

Every graded run ends with a comparison against the baseline:

```text
cowork-aggregated-vs-vendor-mcp · run 7f3c2a · 50 cases × 3 trials · baseline: aggregated

variant                      pass    judge   vs baseline (pairwise)   $/case   median   tools used
aggregated                   0.94    0.91    —                        0.68     58 s     acme 100%
vendor-mcp                   0.71 ▼  0.74 ▼  32% win · 61% loss       0.77     52 s     slack 41% · jira 37% · …
aggregated-plus-vendor-mcp   0.95    0.92    48% win · 40% loss       0.81 ▲   52 s     acme 92% · slack 3% · …

▼ ▲ clearly worse / clearly better than baseline
vendor-mcp: 11 cases regressed · 2 improved      aggregated-plus-vendor-mcp: 1 regressed · 2 improved
```

Open the report:

```bash
npx mst open                                                          # newest local run
npx mst open .mcp-test-results/cowork-aggregated-vs-vendor-mcp/runs/<run-id>

# planned (DEVPLAT-1461)
npx mst open --results acme/result-store/eval-results 7f3c2a
npx mst open --results acme/result-store/eval-results --latest cowork-aggregated-vs-vendor-mcp
```

The report has the same sections for every eval:

- **Result:** which variants are better, worse, or unclear compared with the baseline.
- **Variants compared:** the summary table above. _Show statistics_ adds confidence intervals, p-values and pass^k.
- **What differs:** each variant's setup next to the baseline's.
- **Case by case:** every trial, with its trace, each grader's score, and the pairwise preference against the baseline.
- **Why trials failed:** failed trials grouped by cause.
