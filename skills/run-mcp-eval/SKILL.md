---
name: run-mcp-eval
description: Run an MCP eval with mst and read what it says. Covers checking a config before it spends money, small runs first, reading the pass rate and its range, comparing variants and the previous run, incomplete cases and infrastructure failures, resuming a run, grading it again, Docker and detached runs, and CI. Use when asked to run an eval, why an eval failed, what a run's results mean, to rerun or resume a run, regrade a run, or run evals in Docker or CI.
---

# Run an MCP Eval

`mst run` runs an eval config: every case on its variant's client and model, then the graders. This skill is about running it and reading the result. To write the dataset or the eval config, use `write-mcp-eval`. To decide whether a judge's verdicts can be trusted, use `calibrate-mcp-judge`.

Every command below is `npx mst ...` in a project that has `@gleanwork/mcp-server-tester` installed.

## Step 1: Check the config without running it

```bash
npx mst run --config eval.json --dry-run
```

`--dry-run` loads the config, its plugins and its datasets, and prints the eval's name, output directory, datasets, variants and environment as JSON. It catches unknown keys, plugins and config-level extension names that don't resolve, datasets that don't load, a case that sets client options its variant's desktop app can't take, and a `--variant` or `--case` the config doesn't have. A case's own plugin judge is checked only for its namespace: a misspelt judge name in a loaded plugin fails when the run grades. Fix what it reports before you spend tokens.

Then check the credentials the run needs:

- **The client's credentials.** `npx mst clients` lists each client's install, credentials and setup. For example, `api` with Anthropic needs `ANTHROPIC_API_KEY`, and `codex-cli` needs `OPENAI_API_KEY` (a Codex sign-in is not enough).
- **The judge's key**, when the config has judges. A judge's provider can differ from the client's.
- **Server tokens**: a server's `auth.accessTokenEnv` names an environment variable. Connector servers need `mst auth --config eval.json` once.

Keep keys out of the config. Put them in a file and pass `--secrets-file run.env` (JSON or dotenv). Results replace values named as credentials (`*_TOKEN`, `*_KEY`, ...). A local run also reads the environment. A worker in Docker or another environment doesn't inherit this machine's environment, so put what its client and servers need in the secrets file.

## Step 2: Run a little first

A full run costs money and time. Start with one case and one trial:

```bash
npx mst run --config eval.json --case search-recent-docs --trials 1
npx mst run --config eval.json --filter-tag smoke --max-cases 3
npx mst run --config eval.json --variant baseline
```

`--case`, `--filter-tag`, `--max-cases`, `--trials` and `--variant` make a **partial run**. A partial run is compared only with partial runs narrowed the same way, and never becomes the eval's latest run. When the small run looks right, run the whole config:

```bash
npx mst run --config eval.json --secrets-file run.env
```

## Step 3: Read the output

`mst run` prints one row per variant:

- **Cases passed** and the **pass rate**, with its likely range at 95% confidence. The range counts cases, not trials. A range wider than ±10 points is marked `!`, and the output says what to do: set `"run": { "trials": N }` in the eval config and run it again, or add cases when more trials won't help. Believe the range, not the point.
- **Judge pass rate**, when the config has judges.
- **MCP calls, client events, tokens, cost and time**, when the client reports them. Cost shows only when the client reports it or the config has `pricing`.
- **The change since the previous run** of the same eval config and variant, as `better`, `worse` or `unclear`, with the cases that regressed or improved. No change is shown when the config changed between the runs (`sameConfig: false`).

It prints the run's directory and the report's `mst open` command. It exits 1 when any case failed or is incomplete (Step 4). Open the report for everything else:

```bash
npx mst open .mcp-test-results/my-eval/runs/20261007T182504Z-7f3c2a   # the run mst run printed
npx mst open .mcp-test-results/my-eval                                # that eval's latest full run
```

A bare `mst open` opens the newest full, graded run. A partial run, a `--no-grade` run or a regrade of an older run never becomes the latest, so open it by its directory.

The report's sections are **Result** (each variant clearly better, clearly worse or unclear against the baseline), **Variants compared**, **What differs** (each variant's setup next to the baseline's), **Case by case** (every trial's trace and scores) and **Why trials failed**. Read the failing trials' traces before you change anything: the client may have called the right tool with the wrong arguments, or not called a tool at all.

The run's files are in `.mcp-test-results/<eval name>/runs/<run-id>/`. `results.json` has every case result and `summary.json` the per-variant totals. A run ID's last six characters (`7f3c2a`) are its short form, which every command below accepts.

## Step 4: Tell a failed case from a broken run

A trial ends one of two ways:

- **A trial**: the client ran and was graded. A wrong answer, a missing tool call or the client running out of turns is a trial that failed. Fix the server, its tool metadata, the case or the config.
- **An infrastructure failure**: something around the client broke (`setup`, `network`, `provider`, `client-app`, `workspace`, `collection` or `deadline`). It is not a failed trial. Its case is **incomplete**: neither passed nor failed, and left out of the pass rates.

`mst run` says how to finish incomplete cases. The usual causes:

- **`MCP server not ready, so no trial was sent`**. Before a batch's first trial, MST connects to each server and lists its tools, with retries after 10 s and 30 s. A server that never connects or lists no tools blocks its batch. Check the server's command or URL and its token, then finish the run.
- **A provider error** such as a `503` or a rate limit. Finish the run.
- **An unavailable client**, such as a desktop app another batch still holds. The run goes on with the other variants. Finish the run.
- **A failure a retry can't help**, such as a missing permission. Fix the setup and run again.

To finish a run, resume it in an environment (`--resume <run> --env docker`, Step 5). A run collected locally can't be resumed locally: run its incomplete cases again with `--case`.

## Step 5: Resume or grade again

Both need the run's full traces. Set this in the eval config before the run you want to resume or regrade:

```json
"redactStoredResponses": false
```

The default redacts answers and tool outputs from stored files. A redacted run can't be resumed, graded again or labeled on `mst label`'s page.

```bash
npx mst run --config eval.json --resume 7f3c2a --env docker   # collect only the missing trials
npx mst grade 7f3c2a --config eval.json                       # grade the stored traces with today's graders
npx mst grade 7f3c2a.g2 --config eval.json --resume           # run only the judges that failed to run
```

- **`run --resume`** collects only the trials that are missing or ended in a retryable infrastructure failure, then grades the whole run again. Only an environment collects trials, so a run collected locally needs `--env`, or run its cases again with `--case`.
- **`grade`** runs no client. It grades the stored traces with the config's assertions and judges as they are now, and writes a new run, `<run-id>.g2`, then `.g3`. Use it after you change a judge, a threshold or an assertion.
- **`--no-grade`** collects without grading, for grading later or somewhere else: `mst run --config eval.json --no-grade`, then `mst grade`.
- **`grade --resume`** keeps every verdict the run has and runs only the judges that timed out or failed. It refuses when the judges changed. Grade in full then.

## Step 6: Run somewhere else

- **Docker.** `--env docker` runs trials in containers from MST's Linux images: the ChatGPT image for `chatgpt` and `codex-app`, else the Cowork image. Build the image once with `mst env setup docker --config eval.json`. `--env-option shards=4` splits cases over four containers. Each Docker context runs one Cowork container at a time, so four `cowork` shards run side by side only with four contexts (`--env-option contexts=a,b,c,d`).
- **Detached.** `--detach` runs the coordinator on a machine a plugin environment creates, so your machine can go offline. It needs `--env`, a result store other machines reach (`--results gs://bucket/prefix`), and secrets in `--secrets-file`. Follow it with `mst runs list`, `mst runs watch <id>` and `mst runs logs <id>`, each with the same `--config` and `--results`. `mst runs cancel <id>` stops it and keeps what it collected.
- **Several configs.** `mst batch --config-dir ./evals --workers 2` runs every eval config in a directory, and exits 1 when any failed. `--skip-existing` skips configs whose result store already has a completed run.

## Step 7: Run in CI

- Pass secrets with `--secrets-file`, written from the CI's secrets. When trials run in Docker or another environment, its workers get the file's values, not the CI machine's environment.
- `mst run` exits 1 when a case fails or is incomplete, so an infrastructure failure fails the job too. An eval whose cases pass only some of the time fails some jobs: set `trials` and `passThreshold` on those cases rather than retrying the job.
- Keep runs across machines with a result store (`--results gs://bucket/prefix`, or `results.store` in the config). The previous run is then the store's newest one, so a fresh CI machine still compares with the last run.
- Upload `.mcp-test-results/<eval name>/runs/<run-id>/report/` as an artifact to read it later.

## Common mistakes

- **A full run before a dry run.** `--dry-run` costs nothing and catches most config errors.
- **Comparing variants by eye.** Read the report's **Result**, a paired test over the cases, not whether two ranges overlap. When it says `unclear`, add trials in the config or add cases. `--trials` on the command line makes a partial run that isn't compared with full runs.
- **Treating an incomplete case as a failure.** Infrastructure failures are left out of the pass rates on purpose. Finish the run (Step 4).
- **Comparing a partial run with a full one.** MST won't, and the printed comparison is empty. Run the whole config to compare.
- **Regrading a redacted run.** Set `"redactStoredResponses": false` before the run, not after.
- **Changing a judge and rerunning the clients.** `mst grade` grades the stored traces again without paying for the clients.

## References

- [CLI reference](https://github.com/gleanwork/mcp-server-tester/blob/main/docs/cli.md): every option of `run`, `grade`, `batch`, `open`, `runs` and `env setup`
- [What a run leaves behind](https://github.com/gleanwork/mcp-server-tester/blob/main/docs/evaluation-framework.md#what-a-run-leaves-behind): the run directory, regrades and result stores
- [Metrics](https://github.com/gleanwork/mcp-server-tester/blob/main/docs/evaluation-framework.md#metrics): what each metric counts, incomplete cases and how trials end
- [Server readiness](https://github.com/gleanwork/mcp-server-tester/blob/main/docs/evaluation-framework.md#server-readiness): the check before each batch
- [Cowork in Docker](https://github.com/gleanwork/mcp-server-tester/blob/main/docs/cowork-docker.md) and [ChatGPT in Docker](https://github.com/gleanwork/mcp-server-tester/blob/main/docs/chatgpt-docker.md)
