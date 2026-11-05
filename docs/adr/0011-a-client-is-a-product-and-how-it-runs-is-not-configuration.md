---
status: accepted
---

# A client is a product, and how it runs is not configuration

Every client returns one trace, and the same graders score it. Nothing in grading or reporting branches on a client's name. What differs from client to client is how MST runs it, and part of that reaches the eval config:

- **An option changes the product.** `chatgpt` with `clientOptions.surface: "codex"` tests the Codex surface of the desktop app, not ChatGPT. Its name also collides with the `codex` client, which is the Codex CLI, and the two Codex products need names that tell them apart.
- **A setting chooses what the OS already decides.** `cowork` takes `clientOptions.computerUseProvider: "anthropic-computer-use" | "linux-desktop"`, but each OS supports only one of them. The coordinator fills in its own OS's value when it reads the config, so a run from macOS with `--env docker` can send the macOS value to a Linux worker. `linux-desktop` isn't Computer Use and has no provider.
- **One idea has several names.** The desktop action budget is `computerUseMaxActions` on Cowork and on ChatGPT for macOS, and `nativeMaxActions` on ChatGPT for Linux. The default `timeout` is none for `mst`, 180 s for Claude Code, 300 s for Codex and ChatGPT, and 900 s for Cowork. Some options are accepted and never used: `pluginDir`, `pluginMcpUrl`, `apiToken` and `server` on `claude-code`, and a fixed `provider` on `cowork` and `chatgpt`.
- **Each client applies its own rules around a trial.** Deadlines, the check that servers are ready, reset after a failure, failure diagnosis and secret redaction are written once per client. Stored results drop answers and tool outputs from traces, but ChatGPT's conversation history stays in its client telemetry.
- **Nothing lists the clients.** The only list MST prints is the error for an unknown client. The docs table doesn't say which OS, credentials or setup command each client needs.
- **Some names say how, not what.** `mst` names the tool, not what the client is: a model alone with the servers' tools. The code calls the per-OS mechanism a driver, controller, runtime, platform, backend and adapter. Recorded identities mix `openai.chatgpt.agent.desktop-app.macos` with `linux-desktop`.

## Decision

- **A client is one product that a person would name.** The built-in clients are:

  | Client        | What it is                                                                       |
  | ------------- | -------------------------------------------------------------------------------- |
  | `api`         | The model alone, through its provider's API, with the servers' tools (was `mst`) |
  | `claude-code` | The Claude Code CLI                                                              |
  | `cowork`      | Claude Desktop in Cowork mode                                                    |
  | `codex-cli`   | The Codex CLI (was `codex`)                                                      |
  | `chatgpt`     | The ChatGPT desktop app                                                          |
  | `codex-app`   | The Codex surface of the desktop app (was `chatgpt` with `surface: "codex"`)     |

  No option changes which product a client is. `mst`, `codex`, and `surface` on `chatgpt`, fail validation and name their replacement, as the client names ADR 0002 replaced do. The two Codex products are named for what they are, `codex-cli` and `codex-app`, so neither name is the bare product name that could mean the other.

- **How a client runs follows from the client and the OS of the machine that runs the trial.** It is not configuration. On macOS, `cowork`, `chatgpt` and `codex-app` use Computer Use, with `computerUseModel` as its planner. On Linux they use the accessibility (AT-SPI) automation, which has no planner. `computerUseProvider` is removed. The machine that runs the trial decides, not the coordinator. A trial records the environment and OS it ran on, so its result says how it ran. MST adds no term for this: a client, a model and an environment describe a trial. In code, a client's per-OS parts are `<client>/macos.ts` and `<client>/linux.ts`.

- **MST owns the rules around a trial, the same for every client.** Shared timeout enforcement and reset retry timings remain follow-ups, as recorded below.
  - `timeout` means one thing: the time from the prompt to the trace, without app setup. Each client's definition states its default.
  - Dataset loading rejects empty or whitespace-only inputs for every client, including run-only plugins, before opening a client or submitting any trial. Valid prompt text is preserved exactly, without trimming. Direct native-session calls retain their blank-input guard before submission.
  - One readiness check runs before the first trial: each server connects and lists at least one tool.
  - One reset and diagnosis policy applies to a client that keeps an app open across trials.
  - One redaction pass covers everything MST stores, client telemetry included.
  - How a trial ended follows ADR 0010.

- **One contract for every client, built-ins included.** A `ClientDefinition` has a name, a description, its requirements (OS, credentials, setup command), an options schema, and `run`, `open`, or both. Run-only clients need no change; MST wraps a one-shot session when needed. `open` receives fixed client options, model, servers and environment. Its session has `run`, `reset`, optional `diagnose`, and `close`. Each trial supplies its identity and prompt, and returns its result plus `continue`, `reset`, or `stop`. A session can list servers that resolve only after opening; MST checks them then. Different fixed settings use separate sessions. MST calls these operations under the rules above. Built-in clients use no private layer: the external-client capability pipeline and the simulation result shape that `mst` and `claude-code` convert through are removed.

- **One idea has one option name, and a config that can't run fails when it loads.** The shared names are `timeout`, `maxActions`, `reasoningEffort` (one list of values) and `appVersion`. An option that a client can't use fails validation. So does a case override that a client can't honor, such as a different `model` per case in one desktop batch.

- **`mst clients` lists the clients from their definitions.** For each one it shows what it is, the OS it needs, its credentials, its setup command, and its options with their defaults. `show` prints the same information for one client. Both JSON forms include the options schema: `default` for a literal value, `x-defaultDescription` for a dynamic default or omission semantics. Runtime fallbacks and schema annotations share their values; listing does not fill in missing options. The docs tables are generated from the same schemas.

- **A known environment OS is checked at eval load.** Each variant and case client's `requirements.os` must allow the executing machine's OS for `local`, Linux for built-in `docker`, or a plugin environment's declared `os: 'macos' | 'linux'`. The environment field is optional. Unknown or mixed environments leave it out, and MST does not guess. Validation opens no machines and does not compute per-OS option defaults.

## Consequences

- The eval config changes before 2.0. `mst` becomes `api`, `codex` becomes `codex-cli`, `chatgpt` with `surface: "codex"` becomes `codex-app`, `computerUseProvider` goes, and the option names above change. Each earlier name fails validation and names its replacement, and the migration guide lists them.
- A stored run keeps the client names it was written with. Readers treat `mst` as `api`, `codex` as `codex-cli`, and `chatgpt` with the Codex surface as `codex-app`.
- Plugin clients that implement `runBatch` move to `open()`. A plugin client with only `run` needs no definition change. Its datasets now reject whitespace-only inputs too; a blank later case cannot be discovered after earlier cases have already run.
- Code goes: the capability pipeline in `src/evals/externalClient/` (about 1,100 lines, used only by ChatGPT), the simulation result shape, and `externalClient/builtins/macosDesktop.ts`, which nothing uses. ChatGPT's own steps move into its client. Native trace readers move out of `externalClient/`.
- Some differences stay, because the products differ. Computer Use on macOS has a planner model and its cost; the Linux automation has neither. Results show which one ran.
- `CONTEXT.md` changes with the renames, not before them.
- It ships as separate pull requests: `mst clients` and the generated table; the renames and option changes; the MST-owned trial rules, with redaction first; then the contract change and the removals.

## Implementation status

Local and worker collection now use the shared session loop. Built-in and plugin clients may implement `run`, `open`, or both; collection prefers `open`, and run-only clients remain unchanged. The client extension's `runBatch` and the desktop wrappers are removed. Declared-server readiness runs before opening, and Cowork's preparation-dependent readiness runs after opening. Reset retries, diagnosis deadlines, leases and cleanup policy remain unchanged.

File, plugin and in-memory datasets reject blank inputs before any client opens or trial runs, for all clients; valid prompt text is unchanged. The canonical dataset input schema owns this rule, with no client validation hook.

Cowork, ChatGPT and Codex app now have concrete `macos.ts` and `linux.ts` entry points, selected from the product and worker OS when the batch opens. The platform selectors are removed. The native helpers, app transactions and turn bodies remain shared. New results omit driver identities, including `driver` on Linux receipts; readers retain old fields without rewriting stored runs.

The option/default catalogue and known-environment OS checks are implemented, including case clients and optional plugin environment OS metadata. The contract and removal sequence is complete, and this ADR is accepted.

### Deferred work

Shared timeout enforcement and reset retry timings remain deferred. Existing client deadlines, reset retries and diagnosis limits are unchanged. Preserving ChatGPT's typed planner failure cause and replacing `vercel-sdk` / `anthropic-api` in the connection-policy error also remain separate work.

### Verification

The sequence was checked with unit tests, CLI use cases, mocked desktop sessions and local MCP servers. Live Linux Cowork execution was not tested.
