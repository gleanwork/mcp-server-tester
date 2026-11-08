---
status: proposed
---

# An eval's history is derived from its runs

An eval that runs every week, a variant on the server under development next to a baseline on a vendor's official MCP server, is read over time: is this week's variant better than last week's, and still better than the baseline? Each run compares itself with the previous run (`previousRun`), but nothing shows more than two runs, and nothing says where two runs stopped measuring the same thing. The old reporter's trend chart (and its `historyLimit`) went with the old dashboard ([#391](https://github.com/gleanwork/mcp-server-tester/pull/391)): it kept the last runs' summaries in its own files, beside the runs.

## Decision

- **The history is a file derived from the runs.** `<eval>/history.json`, format `mst.history/v1`, has a row per run directory. A row is what the run ran with (datasets and their content hashes, case IDs, the eval config's judges and their identities, each variant's client, model, servers, client apps and a hash of its setup) and what each variant measured (pass rates, judges, pairwise judges, cost, tokens, time, tool calls, failures, and each case's passed and counted trials). The runs stay the record: any process can rebuild the file from `runs/`, and no reader trusts it over them.
- **It is written where `latest.json` is**, by every run that writes a run directory (`mst run`, `mst grade`, the MCP Playwright reporter): locally from the local runs, and in a result store from the store's runs, after the run's upload. Writing it is best effort: a failure warns and never costs the run its results.
- **Rows are cached, eras are not.** A row is kept until its run's `run.json` changes or a newer MST builds rows differently. Which grading of a collection is shown, the eras and each variant's change since the previous run are worked out again from all the rows on every write, so a run that arrives late (an older regrade, a slow upload) lands where it belongs.
- **No lock.** Two coordinators can finish runs at once, and a `RunStore` has no compare-and-swap. A writer lists the runs, writes, lists them again and writes once more when one appeared (up to three times). A history that still misses a run is completed by the next writer, and `mst history` builds the rows it's missing as it reads.
- **Eras say where comparisons stop.** The datasets, the eval config's judges, the version of a plugin the eval loads (`run.json`'s `plugins`) or how writes are answered (`simulateWrites`) changing start a new era for every variant, including a variant that skipped the run where it changed; a variant's setup changing starts one for it. A new client app build doesn't: following one is what the history is for.
- **A setup is the same only when the runs show it is.** A variant's setup covers each server as `run.json` records it (endpoint or command, transport, connector), so a new endpoint under the same label counts; its servers' write modes; and the judge identities its scores recorded, so a case judge whose version, options or plugin settings changed counts, though the eval config's judges didn't change. A client option recorded only as a keyed hash counts as that hash. The key is the eval's (`option-key` beside `latest.json`, in no run), so the same value hashes the same in its runs. A hash under another key shows nothing, so it counts as a change: collapsing every hash to its option's name, as 2.0.0-rc.0 did, let a changed credential or endpoint look unchanged. Old runs are never hidden. A variant is compared only with the previous run of its era that was complete for it, with the paired test `previousRun` uses.
- **Partial runs, regrades, optimizations.** A partial run has a row, marked, and is never compared with a full run. A regrade is a row ordered by when its transcripts were collected, and a collection's newest complete grading supersedes the others. Tool optimization runs aren't in the history (ADR 0008).
- **Pairwise results are keyed by what they compared.** A variant's pairwise results are a map keyed by `<judge> vs <reference>`. Today the reference is a variant of the same run (`variant:official`). Judging this run's variant against another run's (`run:<run-id>/official`) can add entries without changing the format.

## Considered

- **A database (SQLite).** Queries would be easy, but a result store holds files, a run directory is already the unit MST copies, fetches and opens, and a second store of record could disagree with the runs.
- **Read every run on every view.** Nothing to keep in sync, but a store's `results.json` files can be large, and a weekly eval's history grows by every variant's results each week. The cache reads each run once.
- **Append a row when a run finishes.** Cheaper, but a late regrade, a resumed run or two writers at once would leave the file wrong with no way back but a rebuild.

## Consequences

- `mst history` prints an eval's history, from a directory or from a result store, and `--rebuild` writes it again.
- The history page (`<eval>/history/index.html`) is written from `history.json` with it, as a static page like a run's report, and each run's report links to it. It holds only IDs and numbers, so it needs no redaction of its own.
- Each run directory is read once more after it is written. A first write over an eval with many runs reads them all once.
- Every row records only what MST already records. Trial time percentiles come from trials' wall time; MST records no per-call latency, no asked-user count and no time to first tool call yet.
