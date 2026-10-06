# Use-case suite

Each directory in `cases/` is one comparison MST is built to run: tool triggering over time, tool-description variants, one aggregating server against several native servers, a host with and without a plugin, and so on. The suite runs every case through the `mst` CLI, as a user would, and checks the `results.json` it writes.

```bash
npm run build
npm run test:usecases
```

The suite needs no network and no LLM. The CLI only sees `PATH`, `HOME` and the temp-directory variables from your environment, so API keys and proxy settings can't change a run. CI runs it on every pull request.

## How a case runs

A case directory holds:

- `manifest.json`: an ordinary evaluation manifest.
- `dataset.json`: the cases it runs.
- `expected.json`: what the results must show.

The runner copies the directory to a temp directory, then fills in each `"{{server <catalog> <label>}}"` with a stdio server entry for `fixtures/catalogServer.mjs` serving `fixtures/catalogs/<catalog>.json`. It then runs `mst run --plugins fixtures/plugin.mjs`. With `runs` above 1, the runs share one output directory, and each run's index is in `USECASE_RUN`. Set `USECASE_KEEP=1` to keep the temp directories; a case whose checks fail keeps its directory either way and prints its path.

`fixtures/plugin.mjs` provides:

- **`usecase/model`**, a deterministic stand-in for a model. It connects to the arm's real MCP servers, lists their tools, and follows a `policy`:
  - The first rule whose `when` matches is the case's plan. A rule can match on `input`, `inputStartsWith`, `instruction` (in the host's `systemPrompt`), a host `plugins` entry, or the `run` index.
  - Each step calls a visible tool chosen by `name`, `nameIncludes` or `description`, emits a host-native `skill` event, or runs a tool search.
  - A step's `rate` makes it run on that share of trials, deterministically.

  Because tools are picked by what the host can see, renaming or re-describing a tool changes what it does.

  The model answers from the last tool output it read, so a trace can hold facts its answer leaves out. Token usage grows with the tool definitions and outputs.

- **`usecase/assistant`**, a host with `evidence: "none"`: it returns an answer and no trace.
- **`usecase/keywords`**, a judge that scores the share of keywords in the host's answer. It never reads the trace.

## Checks

Each check is a `path` into `results.json`, with `equals` or `exists`.

- A segment can select an array item with `[key=value]` (for example `arms[name=native]`) or an index (`[0]`). `length` counts items or keys.
- Segments are split on `.` first, so a selector value can't contain a dot.

`expected.json` is validated, so a misspelt field fails the suite instead of checking nothing.

The model host appends every trace it returns to a ledger. This catches aggregation errors without hand-computed constants:

- **`ledger.metrics`** recompute each arm's per-trial means from the ledger and compare them with MST's numbers.
- **`ledger.deltas`** do the same for arm deltas.
- **Arm names:** every arm in the ledger must appear in the results, and every reported arm must have ledger traces, unless it's listed in `ledger.noTrace`.

## Gaps

A check with a `gap` is something MST should report but doesn't yet. Its text names what's missing and the plan step that adds it.

- **Expected failures:** a gap check runs as an expected failure (`it.fails`). When a change makes it pass, the suite fails until you delete the `gap`, so gaps can't close silently.
- **Guarded:** a gap check under an arm or delta also asserts that the arm or delta exists, so it can't pass just because something it depends on went missing.
- **Whole cases:** `runGap` marks a case that can't run yet. `runGapError` is a pattern the CLI's output must match, so the case can't stay blocked for an unrelated reason.

## Adding a case

1. Create `cases/<nn>-<slug>/` with a manifest, a dataset and `expected.json`. Its fields are `title`, `exitCode` (or `exitCodes`), `checks`, and optionally `runs` and `ledger`.
2. Run `npm run test:usecases`. Every check either passes, or is a gap with a reason.
