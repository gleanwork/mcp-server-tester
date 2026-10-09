---
status: accepted
---

# Environments run shards over a channel

A desktop client runs one conversation at a time per machine, and today that machine is the user's own. While an eval runs, the machine can't be used for anything else, and its state can break or skew the results: in one Cowork run, a stray window kept taking focus, and from case 13 on no submission reached the client. The run is also slow. The walkthrough's 450 trials take about 8.5 hours on one desktop.

The design (`docs/design/README.md`) plans `--env`, shards, gather and `--resume`, but it leaves open what an environment must do ([explainer](../design/explainer.md), open question 7). This record answers that question.

## Decision

- **An environment creates machines and opens a channel to each. MST does everything else.** The kind is `env` (`acme/env/cloud-vm`), declared under a plugin's `environments`. The built-in `local` runs the trials in the `mst run` process, as MST does today, on one shard.
- **`--env` and `--env-option` are flags, not part of the eval config.** Where the client runs doesn't change the question an eval asks.
  - The environment's schema checks `--env-option key=value`.
  - MST owns two options. `shards` defaults to 1 and can't exceed the environment's `maxShards`. `keep` is `never` (the default), `failed` (keep a failed shard's machine for inspection) or `always`.
  - `local` rejects `shards` above 1.
- **A channel has three operations:** run a command with its stdin and stdout attached, copy a directory to the machine, and copy one back. An optional fourth forwards a port, for a live view of the desktop.
  - Docker, a VM over IAP SSH and a Kubernetes pod each provide all three: `docker exec -i` and `docker cp`, `gcloud compute ssh --tunnel-through-iap` and `gcloud compute scp`, `kubectl exec -i` and `kubectl cp`.
  - MST provides a helper that builds a complete environment from a function that creates a machine, so most environments implement only that function. An environment that can't use the helper implements `runShard` itself.
- **A worker runs the same code as a local run.** The coordinator copies a bundle to the machine: `run.json`, the resolved datasets and the shard's trial keys. It then starts the hidden command `mst collect --bundle <dir> --out <dir>` there.
  - `mst collect` drives the client through the same code `local` uses (`runDesktopBatch`, the proxies, native evidence), so a trace can't differ between a local and a remote run.
  - The worker never resolves a dataset or runs a judge, so it needs no dataset or judge plugins and no judge credentials.
- **The worker and the coordinator speak `mst.shard/v1`**, one JSON object per line.
  - The worker writes to stdout: `hello` (its MST version, image digest and client version), `need-tokens`, `trial` (a trace was written), `heartbeat`, and `done` (counts, and whether clean-up worked).
  - The coordinator writes `tokens` and `cancel` to stdin.
  - A version mismatch fails the shard at `hello`, before any prompt.
  - A heartbeat tells a slow case from a dead channel. Each case keeps its own deadline.
- **Tokens travel only over stdin.** The worker writes them only to tmpfs (`/run/mst/tokens`, mode 0700), never to the bundle, the image, argv or a trace. Refresh grants stay with the coordinator, and a worker asks for new tokens before its tokens expire.
- **A shard holds whole cases.** Trials are split by `hash(caseId) mod N`, and a case's variants and trials all go to one shard, so each paired comparison runs on one machine, minutes apart.
  - A worker writes each trial's trace as soon as the trial finishes.
  - The coordinator copies `/out` back after each `trial` event. With a `gs://` result store, the worker writes the traces there directly instead.
  - Either way, a dropped channel loses at most the trial in flight.
- **Missing isn't failed.** After collect, the coordinator gathers every shard's traces into one run. A trial with no trace is missing:
  - its case is incomplete and left out of pass rates,
  - the run is recorded as `collect: partial`,
  - `--resume <run-id>` collects only the missing trials.
- **Linux Cowork gets an owned-desktop mode.** A shard runs several variants on one desktop, so MST must write each variant's managed settings, as it already does on macOS.
  - A worker image sets `MST_DESKTOP_OWNED=1` and makes `/etc/claude-desktop/managed-settings.json` writable by the desktop user. MST then writes the file for each variant and restores it at the end.
  - Without the variable, Linux preparation stays read-only, as it is today.
- **`run.json` records where the run ran**: the environment's name and options, the shard count, and each shard's image digest and client version. Each trace records its shard. Because options are recorded, they must not hold secrets.

## Considered

- **A fresh container per variant**, instead of owned-desktop mode. It isolates variants better, but each variant would cost a desktop start and a channel of its own. It would also split a case's variants across machines.
- **Environments that implement whole shards themselves**, with no channel. This stays possible through `runShard`, but every environment would reimplement staging, tokens and progress, and their traces could differ.

## Not decided here

- **Where the desktop image is built.** A worker image must provide what the Linux runtimes document in `docs/cowork.md` and `docs/chatgpt-desktop.md`: a fresh tmpfs HOME, a private D-Bus, an unlocked keyring, AT-SPI, a display, and a disposable container with `no-new-privileges`. Whether MST ships a Dockerfile, or each organization supplies its own image through its plugin, is decided with the Docker environment. Either way, Claude Desktop's Linux package can't go in a public image.
- **Whether "local" containers run in the laptop's Docker or on a remote Docker host** (`DOCKER_HOST=ssh://…`). That waits on whether Claude Desktop runs under Docker on Apple Silicon.
- **macOS VMs.** Cowork's own VM would need nested virtualization, so macOS runs stay on the user's desktop.

## Consequences

- The environment interfaces become public in the `./evals` entry point: `EnvironmentDefinition`, `Environment`, the channel and the `mst.shard/v1` messages. They can change between 2.0 prereleases.
- `--detach` and `mst runs` come after shards. Both need an environment with a `detach` function, and credential and result stores that aren't local.
- Fan-out is capped by rate limits, not by machines: every shard shares one LLM gateway and the same vendor servers. Runs need a cap per provider and per server, beside `maxShards`.
