# ChatGPT in Docker

`mst run --env docker` runs ChatGPT desktop evals in Linux containers instead of on your Mac. Each shard gets a container with its own ChatGPT desktop app, signed out, with a fresh profile for every variant. Your machine stays usable while the eval runs, and no personal account is involved.

MST provides the image as a Dockerfile that you build yourself (`mst env setup docker`). It installs the ChatGPT desktop app from OpenAI's Linux package repository at build time; MST doesn't publish an image with ChatGPT in it.

## What you need

- A Docker host: Linux, or Docker Desktop, OrbStack or [Colima](https://github.com/abiosoft/colima) on a Mac. ChatGPT runs no VM, so it needs no KVM or nested virtualization. OpenAI publishes the app for amd64 and arm64, so Apple Silicon runs it natively.
- Inference for the app, one of:
  - **An LLM gateway** that serves OpenAI's Responses API: `OPENAI_BASE_URL` with `MST_LLM_AUTH_COMMAND` (or a key MST sends to the gateway). See [LLM gateways](./llm-gateways.md).
  - **An OpenAI API key:** `OPENAI_API_KEY`, which the app signs in with.

## Build the image

```bash
npx mst env setup docker --config chatgpt-eval.json --env-option contexts=colima-mst-kvm
```

With a ChatGPT eval (`"client": "chatgpt"`), this builds `mst-chatgpt-linux:<MST version>` on each Docker context you name, and installs the eval's plugins, as for [Cowork](./cowork-docker.md#plugins). The build downloads the `chatgpt` package for the host's architecture and checks it against the SHA-256 and size in the repository's index. Pin a version with `--env-option chatgptVersion=<version>`; the default is the newest. Rebuild after upgrading MST.

## Run

```bash
export OPENAI_BASE_URL=https://llm-gateway.example.com/openai/v1
export MST_LLM_AUTH_COMMAND=…
npx mst run --config chatgpt-eval.json --env docker --env-option contexts=colima-mst-kvm
```

The eval config is the one you'd run on Linux. Two macOS-only things don't belong in it: the Computer Use options (`computerUseModel`, `computerUseMaxActions`), which the Linux client rejects, and `configPath`. Options are as for [Cowork](./cowork-docker.md#run) (`shards`, `contexts`, `image`, `readyTimeout`, `keep`), except that a Docker host isn't limited to one container: several shards can share a context.

## What happens

For each shard, MST:

1. Starts a container with a tmpfs at `/run/mst`, no devices, Docker's default seccomp profile and `no-new-privileges`.
2. Writes the gateway token, or the API key, into the tmpfs over `docker exec`'s stdin, and refreshes it every 4 minutes. It is never in the image, on a command line, in an environment variable, or in the app's config. The container's environment says only which it is and, for a gateway, its URL.
3. Waits for the desktop session: an X server, the session bus, AT-SPI, and an unlocked keyring (without one, the app waits on a password prompt).
4. Copies the shard's bundle in, and runs `mst collect` as the desktop user. For each variant, the [Linux ChatGPT client](./chatgpt-desktop.md#linux-runtime-contract) creates `$HOME/.codex`, writes the variant's servers and model, starts the app and goes through its first-run screens, runs the cases, then stops the app and removes `$HOME/.codex`, so the next variant starts fresh.
5. Copies the results back and removes the container, as for Cowork.

Each session's evidence (the app's log, its runtime config, and a screenshot of a failed setup) is in `/run/mst/evidence/session-*` in the container. Keep a failed shard's container with `--env-option keep=failed` to read it; it's on a tmpfs, so read it with `docker exec`, not `docker cp`.

## Grading, other machines and detached runs

The eval's client picks the image everywhere the docker environment runs, after the eval config's `extends`: a shared config can make an eval a ChatGPT eval.

- **`mst env setup <environment> --config <eval>`** passes the client to the environment's `setup` (`client` in its context), so `docker` builds `mst-chatgpt-linux:<MST version>`.
- **`mst run`, `mst grade --env` and `--grade-env`** open the environment with the client (`client` in `EnvironmentContext`). A grade shard runs in a container of the same ChatGPT image, with no desktop.
- **`--detach`** gives the coordinator machine the client (`client` in `CoordinatorContext`), so a plugin environment can start it from the image its shards use.

A plugin environment that runs MST's docker environment on machines of its own (a VM per shard, say) only has to pass the client on: `docker.setup(options, { log, plugins, client })`, and `docker.open(options, context)` with the context it was given.

The gateway or API key comes from the coordinator's environment (`OPENAI_BASE_URL` with `OPENAI_API_KEY` or `MST_LLM_AUTH_COMMAND`). A detached coordinator runs `mst run` with the run's `--secrets-file` values in its environment, so put them there.

## Compared with a Mac

In a container, the app is signed out and gets inference from your gateway or API key; on a Mac it runs signed in as you. The model's context, its tools and its limits can differ between the two. Compare variants within one environment; `run.json` records which one a run used.
