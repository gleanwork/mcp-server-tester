# ChatGPT in Docker

> **Design record.** Implemented: see [ChatGPT in Docker](../chatgpt-docker.md) for how to use it. Two details differ from this proposal: the provider's token command is `/bin/cat <token file>`, and the gateway's provider is chosen by `MST_CHATGPT_INFERENCE_BASE_URL` in the container, which `mst run` sets from `OPENAI_BASE_URL`.

## Goal

Run a ChatGPT eval the way a Cowork eval runs in Docker: each shard gets a disposable Linux container with its own ChatGPT desktop app, your machine stays usable, and no personal account is involved:

```bash
export OPENAI_BASE_URL=https://llm-gateway.example.com/openai/v1   # your gateway's OpenAI base
export MST_LLM_AUTH_COMMAND=…                                       # as for Cowork

npx mst env setup docker --config chatgpt-eval.json                 # builds mst-chatgpt-linux:<MST version> (planned)
npx mst run --config chatgpt-eval.json --env docker --env-option shards=3
```

The eval config needs nothing Docker-specific. `"client": "chatgpt"` selects the ChatGPT image, and on Linux the client already uses the AT-SPI driver.

## What a spike showed

ChatGPT desktop 26.1007.71326 (OpenAI's arm64 Linux package) ran natively in a container on an Apple Silicon Colima VM:

- **No account.** With no sign-in, the app passes its first-run screens and offers both ChatGPT Work and Codex.
- **Inference through a gateway.** A custom model provider in `config.toml` sends turns to an OpenAI-compatible gateway (the Responses API). The provider's token comes from a command, which the app's backend re-runs on an interval. A ChatGPT Work turn completed. Its rollout recorded `originator: codex_work_desktop`, the originator MST matches for that surface, and the gateway provider.
- **A keyring is required.** Without an unlocked keyring, the app sits on its splash screen behind a keyring password prompt (`gcr-prompter`). An empty-password login keyring created before launch avoids it.
- **A fresh profile shows a model announcement** ("Introducing …", **Continue with current model**) after the first-run screens. The Linux driver doesn't handle it yet.
- **No VM.** Unlike Cowork, ChatGPT needs no KVM or vsock devices.

## Design

### 1. Inference: a gateway provider, or an API key

The Linux client signs in with an API key today (`codex login --with-api-key`). Add a gateway mode, chosen when `OPENAI_BASE_URL` is set, using MST's existing [LLM gateway settings](../llm-gateways.md):

```toml
model = "gpt-6-luna"
model_provider = "mst_gateway"

[model_providers.mst_gateway]
name = "LLM gateway"
base_url = "https://llm-gateway.example.com/openai/v1"
wire_api = "responses"

[model_providers.mst_gateway.auth]
command = "/opt/mst/bin/inference-token"   # prints the token MST delivered
refresh_interval_ms = 60000
```

- **The token never enters the config or the environment.** `mst run` resolves it on the host (`MST_LLM_AUTH_COMMAND`, then `OPENAI_API_KEY`) and writes it into the container's tmpfs over `docker exec` stdin. It refreshes the file every 4 minutes, as for Cowork. The token command only reads that file.
- **Readiness replaces login.** Instead of `codex login status`, MST checks the gateway before the app starts: `GET <base>/models` with the token, and fails with `inference_unavailable` if that fails. The existing MCP preflight and app-server probe are unchanged.
- **API-key mode stays** for runs without a gateway: `MST_CHATGPT_API_KEY_FILE`, as today.
- **The run records the mode** in `nativeReadiness` (`inference: gateway | api-key`), with no URL or token.

### 2. Linux client changes

- **A fresh profile per session.** `$HOME/.codex` must not exist when a session starts, and nothing removes it afterwards, so a container's second variant fails with `home_not_fresh`. When MST created the profile (the exclusive `mkdir`), it removes it on dispose, owner-checked like the workspace. The evidence directory gets a subdirectory per session, so the next session doesn't find it non-empty.
- **The model announcement.** The driver's `prepare` clicks **Continue with current model** when that dialog is shown. It does this only for that observed dialog, as it already does for the first-run screens, so it never changes the model.
- **The keyring stays the caller's.** In Docker, the image's session script provides it (section 3).

### 3. The image: `docker/chatgpt-linux`

Built by `mst env setup docker` when the eval's client is `chatgpt`, next to the Cowork image and sharing its layout (`/opt/mst/bin`, `/opt/mst/plugins`, the `mst` user):

- **Base:** `node:22-trixie-slim`, like the Cowork image.
- **ChatGPT:** the `chatgpt` package for the build's architecture, from OpenAI's apt repository. The build reads `Filename` and `SHA256` from the repository's `Packages` index and checks the download against them. `--env-option chatgptVersion=<version>` pins a version; the default is the newest. The repository's `.list` entry is removed, so nothing updates the app inside a container.
- **Desktop:** `xvfb`, `dbus`, `at-spi2-core`, `python3-gi`, `gir1.2-atspi-2.0`, `gnome-keyring`, `libsecret-1-0`.
- **Session script:** as the desktop user, start Xvfb, the session bus and AT-SPI, and unlock an empty-password login keyring. Then write `ready`. The app isn't started here: the Linux client starts it per session with its own fresh `HOME`.
- **Fixed addresses**, so `docker exec` workers get them from the image's `ENV`: `DBUS_SESSION_BUS_ADDRESS`, `GNOME_KEYRING_CONTROL` (`--control-directory`), and `AT_SPI_BUS_ADDRESS` (read once, with `org.a11y.Bus.GetAddress`, into a file the worker's wrapper exports).
- **MST and plugins:** installed as in the Cowork image, at the version the run uses.

### 4. The environment: one `docker`, two images

`docker` stays one environment. It picks a profile from the eval's `client`:

|                            | Cowork                             | ChatGPT                                |
| -------------------------- | ---------------------------------- | -------------------------------------- |
| Image                      | `mst-cowork-linux:<version>`       | `mst-chatgpt-linux:<version>`          |
| Devices, seccomp           | KVM, vsock, net; MST's profile     | none; Docker's default profile         |
| Inference                  | Anthropic gateway or key           | OpenAI gateway or key                  |
| Containers per Docker host | one (fixed vsock port)             | several                                |
| Per-shard setup            | restart Claude Desktop per variant | the client's fresh profile per session |

- `--env-option image=` still overrides the image.
- The container lifecycle doesn't change: owner labels, sweeping orphans, `keep`, removal at exit.
- **Sizing:** the app needs about 1.5 GB of memory per container (to confirm). A 12 GB Colima VM should fit about four shards.

### 5. Connectors

They already work in environments. Each worker launches the connector servers itself, with tokens sent from this machine. For ChatGPT, a dry-run proxy entry is a plain stdio server with `minTools`, which ChatGPT rejected until now. With the `minTools` fix, MST's preflight checks it and `config.toml` never contains it. Vendor variants passed on macOS with that fix.

## Comparability

A Docker run differs from a Mac run in more than the machine: the app is signed out, and inference goes through a gateway instead of an account. What's in the model's context may differ too. Treat the environment as part of the run, and compare variants within one environment. A run records `env` and `nativeReadiness.inference`, so reports can say which it was.

## Security

- No personal account, browser profile or keychain enters the container. The gateway token lives only in tmpfs, and the keyring is empty.
- The app runs with `approval_policy = "never"` and `sandbox_mode = "danger-full-access"`, as on Linux today. So the container is the only boundary: not privileged, `no-new-privileges`, no devices, and removed after the run.
- Vendor writes stay blocked by the dry-run proxy.

## Open questions

1. **Package trust.** The `Packages` index and the download are both fetched over HTTPS from OpenAI. The repository's `InRelease` is signed, but OpenAI publishes the key only inside the package. Is the HTTPS-plus-checksum chain enough, as it is for the Cowork image's `key.asc`?
2. **First-run state.** Can a pre-written app state skip the first-run screens and the announcement entirely, instead of the driver clicking through them?
3. **Gateway model names.** The gateway accepted `gpt-6-luna`. Do all evaluated models have the same IDs on the gateway and in the app?
4. **Memory per container,** to set a sensible default for `shards`.

## Delivery

1. The `minTools` fix, with its tests and docs (done on a branch).
2. Linux client: gateway inference, a fresh profile per session, and the model announcement, tested with a fixture desktop as today.
3. The ChatGPT image and the environment profile. Then a live run of three variants on Colima, compared with the same cases on macOS.
