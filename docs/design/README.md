# Comparing MCP server setups in Cowork

> **Design proposal.** This is how we intend evals to be run. Many of these commands and config keys don't exist yet. The [explainer](./explainer.md) covers the design, the run lifecycle, and what exists today versus what's planned.

This walkthrough runs one eval end to end. It uses a fictional company, Acme, whose private plugin `@acme/mst-plugin` provides datasets, judges, a VM environment and a result store.

**Goal:** find out whether Cowork answers Acme's info-seeking questions better with Acme's aggregated MCP server, with the native vendor MCP servers (Slack, Jira, Linear, GitHub, Gmail, Drive, Calendar), or with both, using the same model.

## Prerequisites

- Node.js 22+
- Access to your organization's MST plugin package (here `@acme/mst-plugin`)
- Cloud credentials for the plugin's result store and credential store (only for remote runs, CI, or remote results)
- For local Cowork runs: Claude Desktop on your Mac

## 1. Install

Keep eval configs in your own repo, either a personal one or a team repo of use cases.

```bash
mkdir cowork-evals && cd cowork-evals
npm init -y
npm i -D @gleanwork/mcp-server-tester@beta @acme/mst-plugin

# Once, on a Mac that will run Cowork locally
npx mst cowork setup
```

See what the plugin provides:

```bash
npx mst plugins --plugins @acme/mst-plugin
```

```text
@acme/mst-plugin 0.14.0 (namespace: acme, snapshot 2026-10-06)
  dataset            acme/dataset/info-seeking, acme/dataset/action-taking, acme/dataset/tool-selection
  judge              acme/judge/correctness, acme/judge/completeness, acme/judge/groundedness
  pairwise-judge     acme/pairwise-judge/preference
  connector          acme/connector/slack, acme/connector/jira
  credential-store   acme/credential-store/secret-manager
  setup              acme/setup/reset-test-tenant
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
npx mst datasets pull acme/dataset/info-seeking --plugin-option acme.source=live
npx mst datasets pull acme/dataset/info-seeking --plugin-option acme.snapshot=2026-10-01
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

`evals/cowork-aggregated-vs-native.json`:

```json
{
  "$schema": "https://unpkg.com/@gleanwork/mcp-server-tester@beta/schema/eval-config.schema.json",
  "name": "cowork-aggregated-vs-native",
  "plugins": ["@acme/mst-plugin"],
  "extends": ["acme/config/cowork"],

  "datasets": ["acme/dataset/info-seeking"],

  "client": "cowork",
  "model": "claude-opus-4-8",
  "trials": 3,

  "judges": ["acme/judge/correctness"],
  "pairwiseJudges": ["acme/pairwise-judge/preference"],
  "metrics": ["passed", "judge_score", "cost_usd", "duration_ms", "tool_count"],

  "servers": {
    "acme": {
      "transport": "http",
      "serverUrl": "https://mcp.acme.example/mcp"
    },
    "slack": { "transport": "http", "serverUrl": "https://<slack-mcp-url>" },
    "jira": { "transport": "http", "serverUrl": "https://<jira-mcp-url>" },
    "linear": { "transport": "http", "serverUrl": "https://<linear-mcp-url>" },
    "github": { "transport": "http", "serverUrl": "https://<github-mcp-url>" },
    "gmail": { "transport": "http", "serverUrl": "https://<gmail-mcp-url>" },
    "gdrive": { "transport": "http", "serverUrl": "https://<drive-mcp-url>" },
    "gcal": { "transport": "http", "serverUrl": "https://<calendar-mcp-url>" }
  },

  "variants": [
    { "name": "aggregated", "servers": ["acme"] },
    {
      "name": "native",
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
      "name": "aggregated-plus-native",
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

- **`servers`** defines each server once. The key is its label in traces and the report.
- **`variants`** run the same cases with the same client and model, and only their servers differ. The first variant is the baseline; set `"baseline"` to choose another.
- **`datasets`** use the snapshot by default. To pin a snapshot: `{ "ref": "acme/dataset/info-seeking", "snapshot": "2026-10-01" }`. For live data: `{ "ref": "…", "source": "live" }`.
- **`judges`** apply to every case, on top of each case's own judges. Pointwise judges score each trial. Pairwise judges compare each variant with the baseline on each case.
- **`setup`** (optional) lists plugin steps that run before collection and tear down afterwards, e.g. `acme/setup/reset-test-tenant`.

Point write-capable servers at test tenants or test accounts. MST can't yet block write tools for Cowork's connectors.

Check the plan without running anything:

```bash
npx mst run --config evals/cowork-aggregated-vs-native.json --dry-run
```

```text
cowork-aggregated-vs-native
  datasets    acme/dataset/info-seeking (snapshot 2026-10-06, 50 cases, sha256 3f9a…)
  client      cowork · model claude-opus-4-8 · 3 trials per case
  variants    aggregated (baseline) · 1 server
              native · 7 servers
              aggregated-plus-native · 8 servers
  graders     acme/judge/correctness, acme/judge/completeness (12 cases)
              acme/pairwise-judge/preference (each variant vs aggregated)
  env         local (macOS) · 1 shard
  results     .mcp-test-results/cowork-aggregated-vs-native/
  total       450 trials · 100 pairwise preferences
  credentials 2 of 8 servers need `mst auth` (gmail, gcal)
```

## 4. Authenticate once

```bash
npx mst auth --config evals/cowork-aggregated-vs-native.json --store acme/credential-store/secret-manager
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

Each run refreshes these grants and hands short-lived tokens to the client, then removes them when it finishes. Leave out `--store` to keep grants on your machine only. Remote runs and CI need a shared credential store.

```bash
npx mst auth status --config evals/cowork-aggregated-vs-native.json
npx mst auth revoke --config evals/cowork-aggregated-vs-native.json --server slack
```

## 5. Run locally

Use small local runs to iterate:

```bash
npx mst run --config evals/cowork-aggregated-vs-native.json --variant native --case e2e-0011 --trials 1
npx mst run --config evals/cowork-aggregated-vs-native.json --max-cases 5
npx mst run --config evals/cowork-aggregated-vs-native.json --filter-tag source:correctness
```

```text
setup     auth staged for 8 servers · desktop lease acquired
collect   aggregated              e2e-0000 ●●●  e2e-0001 ●●●  e2e-0002 ●●●
          native                  e2e-0000 ●●●  e2e-0001 ●●●  e2e-0002 ●●!
          aggregated-plus-native  e2e-0000 ●●●  e2e-0001 ●●●  e2e-0002 ●●●
teardown  tokens removed · Claude Desktop profile restored
grade     aggregated              e2e-0000 ✓✓✓  e2e-0001 ✓✓✓  e2e-0002 ✓✓✗
          native                  e2e-0000 ✓✗✓  e2e-0001 ✓✓✓  e2e-0002 ✗✗–
          aggregated-plus-native  e2e-0000 ✓✓✓  e2e-0001 ✓✓✓  e2e-0002 ✓✓✓
● collected  ! infrastructure error  ✓ passed  ✗ failed  – missing
```

The client runs the trials first. Judges then grade the collected traces.

## 6. Run remotely

Use the same config, on 5 fresh VMs:

```bash
npx mst run --config evals/cowork-aggregated-vs-native.json \
  --env acme/env/cloud-vm --env-option shards=5 \
  --results acme/result-store/eval-results
```

The VMs run the trials. Your machine gathers their traces, runs the judges, and writes the results. Ctrl-C deletes the VMs and keeps the traces collected so far. Rerun with `--resume <run-id>` to collect only what's missing.

To walk away from a long run, detach it:

```bash
npx mst run --config evals/cowork-aggregated-vs-native.json \
  --env acme/env/cloud-vm --env-option shards=5 \
  --results acme/result-store/eval-results --detach
# → run 7f3c2a started on acme/env/cloud-vm

npx mst runs list --env acme/env/cloud-vm
npx mst runs watch 7f3c2a
npx mst runs cancel 7f3c2a
```

### On a schedule

```yaml
# .github/workflows/cowork-aggregated-vs-native.yml
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
          npx mst run --config evals/cowork-aggregated-vs-native.json
          --env acme/env/cloud-vm --env-option shards=5
          --results acme/result-store/eval-results
```

## 7. Regrade without re-running

Judges read stored traces, so you can change or add judges and regrade without running Cowork again:

```bash
npx mst run --config evals/cowork-aggregated-vs-native.json --env acme/env/cloud-vm --no-grade
npx mst grade 7f3c2a
npx mst grade 7f3c2a --plugin-option acme.source=live
npx mst grade 7f3c2a --judge acme/judge/groundedness
# → run 7f3c2a.g2 (traces from 7f3c2a)
```

## 8. Find your results

Runs are written locally by default:

```text
.mcp-test-results/cowork-aggregated-vs-native/runs/<run-id>/
├── run.json        # config, resolved datasets and judges, environment, phase status
├── traces/         # one trace per trial
├── grades/         # one score per grader per trial; pairwise preferences per case
├── results.json    # traces and grades joined
├── summary.json    # per-variant metrics and comparisons
└── report/
```

`--results` sends the run somewhere else instead:

```bash
--results acme/result-store/eval-results     # a store your plugin provides
--results gs://my-bucket/cowork-evals        # any GCS location
--results file:./shared-results              # any local directory
```

```bash
npx mst stores --plugins @acme/mst-plugin
```

## 9. Read your results

Every graded run ends with a comparison against the baseline:

```text
cowork-aggregated-vs-native · run 7f3c2a · 50 cases × 3 trials · baseline: aggregated

variant                  pass    judge   vs baseline (pairwise)   $/case   median   tools used
aggregated               0.94    0.91    —                        0.68     58 s     acme 100%
native                   0.71 ▼  0.74 ▼  32% win · 61% loss       0.77     52 s     slack 41% · jira 37% · …
aggregated-plus-native   0.95    0.92    48% win · 40% loss       0.81 ▲   52 s     acme 92% · native 4%

▼ ▲ clearly worse / clearly better than baseline
native: 11 cases regressed · 2 improved      aggregated-plus-native: 1 regressed · 2 improved
```

Open the report:

```bash
npx mst open                                                          # newest local run
npx mst open .mcp-test-results/cowork-aggregated-vs-native/runs/<run-id>
npx mst open --results acme/result-store/eval-results 7f3c2a
npx mst open --results acme/result-store/eval-results --latest cowork-aggregated-vs-native
```

The report has the same sections for every eval:

- **Result:** which variants are better, worse, or unclear compared with the baseline.
- **Variants compared:** the summary table above. _Show statistics_ adds confidence intervals, p-values and pass^k.
- **What differs:** each variant's setup next to the baseline's.
- **Case by case:** every trial, with its trace, each grader's score, and the pairwise preference against the baseline.
- **Why trials failed:** failed trials grouped by cause.
