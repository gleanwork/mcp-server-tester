# Optimizing a tool description: `find_skills`

This example asks whether a better description makes a model call `find_skills` when it should, without calling it when it shouldn't. It runs the same cases and description candidates on two clients: `mst` (a model through the Vercel AI SDK) and `cowork` (Claude Desktop's Cowork, driven by MST).

The server is the repo's catalog fixture (`tests/usecases/fixtures/catalogServer.mjs`) serving [catalog.json](./catalog.json), which has three tools:

- `search`: "Search company documents."
- `read_document`: "Read a document by id."
- `find_skills`: "Find skills." This is the baseline description.

## The cases

[cases.json](./cases.json) has 13 cases:

| Kind       | Cases | Passes when                                                               |
| ---------- | ----- | ------------------------------------------------------------------------- |
| capability | 9     | the model calls `find_skills` for an action in a connected app            |
| regression | 4     | the model answers a knowledge question with `search`/`read_document` only |

- **Capability cases** cover creating and updating tracker tickets, posting in chat, sending email, scheduling a meeting, creating a document, sharing a file, adding a task, and "what can you do in my apps?". They likely fail with the terse baseline description; they are what a better description should fix.
- **Two capability cases are `held-out`** (`files-share`, `tasks-add`). They are reported but left out of the metric, which checks that a winning description generalizes beyond the cases it was chosen on.
- **Regression cases** are tagged `regression`. They use `exclusive: true`, so any `find_skills` call fails them. A candidate that breaks them is disqualified, however many capability cases it fixes. See [How variants are judged](../../docs/mcp-host.md#how-variants-are-judged).

## The candidates

[variants.json](./variants.json) has two `find_skills` descriptions:

- `find-skills-actions`: names the actions and apps, and sends knowledge questions to `search`.
- `find-skills-discovery`: frames the tool as listing what can be done.

`runVariantExperiment` runs the baseline and each candidate for `--trials` trials per case, then recommends a candidate only on clear evidence.

## Run it

```bash
npm run build                                   # the example imports the package from dist
node examples/find-skills-optimization/run.mjs --dry-run       # validate, no model calls
node examples/find-skills-optimization/run.mjs                 # mst, claude-haiku-4-5
node examples/find-skills-optimization/run.mjs --client cowork # Cowork, claude-sonnet-4-6
```

- **`mst`** needs credentials for the model's provider (for Anthropic, `ANTHROPIC_API_KEY`, or a gateway; see [LLM gateways](../../docs/llm-gateways.md)).
- **`cowork`** needs macOS, Claude Desktop, and the setup in [Cowork](../../docs/cowork.md). It drives the desktop app, one case at a time, for 13 cases × 3 trials × 3 variants (117 sessions; a few hours). After a failed case, MST resets the app before the next one.
- Use `--trials 1` for a quick look.

`run.mjs` writes the eval config to `.mst/<client>/eval.json`, with absolute paths: Cowork starts the server itself, so a relative path or a bare `node` would not resolve. Results, with answers kept, go to `.mst/<client>/results/`, and the experiment result goes to `.mst/<client>/experiment.json`. The script prints each candidate's pass rate against the baseline, and the recommendation.

To read why a case failed, open a case result's `toolCallTrace`: calls marked `unexpected`, and required tools in `missed`.
