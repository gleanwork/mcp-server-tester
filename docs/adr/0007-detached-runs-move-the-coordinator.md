---
status: accepted
---

# Detached runs move the coordinator

With `--env`, the trials and the grading run on an environment's machines, but the coordinator still runs where `mst run` was typed, usually a laptop ([ADR 0004](./0004-environments-run-shards-over-a-channel.md), [ADR 0005](./0005-grading-runs-in-an-environment.md)). The coordinator does the rest of the run:

- It opens each shard's channel. A worker is a process started over that channel, so it ends when the channel does.
- It holds the refresh grants, and hands each worker its access tokens (`need-tokens`), and the secrets file's values (`tokens`).
- It grants trials room under the eval config's `limits` (`acquire`), copies traces back, gathers the shards, and writes the run, its store copy and its report.

So a run lasts only as long as the laptop stays awake and online. Closing its lid ends every shard within a minute ("The worker sent nothing for 60 s"). The machines stay up, with nothing running on them, until the environment's own deadline deletes them. A run of a few hours means keeping a laptop open, plugged in and on one network for those hours.

The walkthrough plans `--detach` and `mst runs` for this ([section 7](../design/README.md#7-run-remotely)), and ADR 0004 says both need "an environment with a `detach` function, and credential and result stores that aren't local". This record decides what detaching does.

The workaround today is to run the coordinator on a machine of your own in the cloud. It works, but by hand: install MST and the plugins at the right versions, and copy the eval's credentials there. Copying a cloud login, the simplest way to let that machine create the workers, copies everything in it, including keys for other projects. Detaching should make this the supported path, without copying a user's login anywhere.

## Decision

- **`--detach` runs the coordinator on a machine the environment creates, and returns.** `mst run --env <name> --detach` and `mst grade <run> --env <name> --detach` check the run, create a **coordinator machine**, start the coordinator there, print the detached run's id, and exit. The launching machine can then go offline.
  - The coordinator runs the commands a user would type, on its machine: `mst run`, then `mst run --resume` once if the run is partial, then `mst grade --env` when the run was given `--grade-env`. A detached run writes what a local `mst run --env` writes, with the same code.
  - `--resume <run> --detach` completes a run on a new coordinator machine, as a lost coordinator's run needs.
  - Without `--detach`, nothing changes.
- **`mst run --grade-env` collects, then grades in the same environment** (`mst grade --env`), with the same `--env-option`s. It is ADR 0005's "`mst run --grade-env`", decided: a detached run usually wants it, so the coordinator machine runs no judges. It works without `--detach` too.
- **An environment opts in with a `coordinator` function.** `EnvironmentDefinition.coordinator(options, context)` creates one machine and returns a `CoordinatorMachine`: its id, a channel (the same `WorkerChannel` workers use), its work directory, how to run MST there (`mst`), a `finish` command it runs at the end (typically deleting itself), and `dispose` for when starting it fails. It takes the environment's own `--env-option`s.
  - The machine must have the launching machine's MST and the eval's plugins, installed so they resolve from its work directory. The versions then match the workers' at `hello`, as they do for a laptop.
  - It runs under a **cloud identity the environment configures**, such as a service account that can create the workers, open their channels and write the result store. MST never copies the user's cloud login to it.
  - An environment without `coordinator` refuses `--detach` before any machine is created.
- **What is typed locally resolves; the coordinator machine runs.** The launching machine loads the eval config, its plugins and its datasets, and ships a **coordinator bundle**: `detach.json` (the plan: the command, the environment and its options, the stores, the selection flags), the eval config file, and `datasets.json`, the datasets as loaded here, each with its origin. The coordinator passes them on with the hidden `--loaded-datasets` flag, so dataset plugins' credentials (a production bucket, say) stay on the launching machine, as ADR 0005 keeps them off grade workers.
  - The eval config file is shipped alone. Plugins come from the coordinator machine's installation, so `--detach` refuses `--plugins`.
  - The launching machine copies the bundle into `<workDir>/detached/<id>` and runs `mst coordinate --bundle <dir>` over the channel. That command starts the coordinator in a session of its own, so it keeps going when the channel closes, and returns.
- **A detached run needs a result store.** `--detach` refuses a run without `--results` (or the eval config's `results.store`), and a local directory store. The coordinator keeps the run there as a local run does, and its own records beside the eval's runs:
  - `<eval>/detached/<id>/status.json`, rewritten at least every 30 s: the state (`starting`, `running`, `done`, `failed`, `cancelled`), the phase (`collect`, `resume`, `grade`), trials collected and graded, the run and its regrade once known, and the last lines of output;
  - `<eval>/detached/<id>/log.txt`, the coordinator's output, uploaded every minute and at the end.
- **A detached run with connector servers needs a shared credential store.** The coordinator machine refreshes the grants for the whole run, and providers that rotate refresh tokens invalidate the copy a refresh replaces, so a copy of the local store would break.
  - **Credential stores become an extension kind**, `credentialStores` in a plugin: `--store <namespace>/credential-store/<name>` on `mst run` and `mst auth`, beside a directory. A definition has `create()` and says whether other machines reach the same grants (`shared`). `--detach` needs a `shared` one.
  - Refresh grants still never reach a worker. They move from the laptop's process to the coordinator machine's.
- **Secrets go over the channel.** The `--secrets-file` values travel in one JSON line on `mst coordinate`'s stdin, never in the bundle, argv or the image. The coordinator keeps them in a private file in memory-backed storage (`/dev/shm`), gives them to its commands as their environment and `--secrets-file`, and deletes them at the end. The ambient environment of the launching machine isn't sent: what the run needs, such as a model key, must be in the secrets file. Judge keys must outlast the run, as ADR 0005 requires.
- **`mst runs` reads the store, not the machines.** Each takes the eval config (`-c`) and `--results` as the run was given.
  - `mst runs list` lists the eval's detached runs, newest first, with their state and counts. `mst runs status <id>` shows one, and `mst runs watch <id>` follows it until it ends. An id's last six characters name it.
  - `mst runs logs <id>` prints the coordinator's log.
  - `mst runs cancel <id>` writes `<eval>/detached/<id>/cancel`. The coordinator checks for it with each heartbeat and interrupts the command under way as Ctrl-C does: its shards end, their machines are deleted, and what was collected is kept.
  - A running coordinator whose heartbeat is older than five minutes shows as `lost`. `mst run --resume <run> --detach` finishes its run.
- **The coordinator machine has a deadline.** It runs its `finish` command when the run ends, on failure too. The environment also gives it a deadline of its own, so a coordinator that dies leaves nothing behind for long.

## Considered

- **Durable workers**: each worker keeps running when its channel drops, writes its traces to the result store itself, and a coordinator that comes back reattaches. A lid closed for a minute would then cost nothing. But the coordinator does more than receive traces. Workers ask it for access tokens, so they would stop when their tokens expired, and they wait for `granted` before each trial, so they would stop at once. Making workers independent would move token refresh and rate limits off the coordinator. That is a larger change, and detaching is needed either way for runs that outlast a laptop.
- **The coordinator in one process**, calling `runEval` and `gradeRun` in order instead of running MST's commands. It saves a process per step, but each step would need its own wiring for output, cancellation and the run directory, which the commands already have.
- **Run in CI.** A scheduled workflow (walkthrough section 7) already moves the coordinator off a laptop. It needs the same credential store, result store and cloud identity as `--detach`, so it gains from this work too. A job runner's limit on job length, often six hours, also caps the run, and starting an ad hoc run there is slower than `--detach`.
- **Ship the local credential store to the coordinator machine.** It needs no remote store, but the two copies drift as soon as a provider rotates a refresh token.
- **Keep a laptop awake**, with `caffeinate` or a sleep setting. It doesn't survive a closed lid, a lost network or an empty battery, and it ties the run to that laptop.

## Not decided here

- **Which cloud credential stores MST ships.** A secret-manager store per cloud, or plugins only. Today a plugin provides one.
- **Recording the coordinator in `run.json`**, beside `environment.machines`: the detached run's id and its machine. The status in the store says where it ran until then.
- **Locking a grant across machines.** A credential store's `withLock` holds across processes on one machine. A laptop and a coordinator machine refreshing the same grant at once can still race, so don't run the same connectors on both at once.
- **Notifications** when a detached run ends, beyond `mst runs watch`.

## Consequences

- An environment that supports `--detach` defines `coordinator`, and documents the cloud identity its coordinator machine runs as and the roles it needs.
- `--detach` needs a remote result store and, with connector servers, a shared credential store from a plugin.
- The public types gain `EnvironmentDefinition.coordinator`, `CoordinatorMachine`, `CoordinatorContext`, `CredentialStoreDefinition` and `DetachStatus`. They can change between 2.0 prereleases.
- A resumed run keeps how it was started: a run collected with `--no-grade` stays ungraded after `--resume`, and is graded with `mst grade`.
