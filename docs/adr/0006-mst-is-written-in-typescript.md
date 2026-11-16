---
status: accepted
---

# MST is written in TypeScript

MST is a TypeScript package, and its checks are TypeScript checks: `typecheck`, `lint`, `format`, `knip`, Vitest and Playwright. During the 2.0 prereleases it also gained Python:

- `scripts/cowork_computer_use.py` drove Claude Desktop on macOS with a computer-use loop. It needed `anthropic`, `pyautogui`, `mss`, `Pillow` and pyobjc, which `src/evals/cowork/pythonRuntime.ts` installed into a venv on the user's machine at run time, from `scripts/cowork-requirements.txt`. It is now TypeScript and a Swift helper (port 1 below).
- `scripts/cowork_linux.py` and `scripts/chatgpt_linux.py` drove managed third-party Claude Desktop and ChatGPT on Linux over AT-SPI, through Python's GObject bindings. They are now TypeScript over D-Bus (port 4 below).
- `docker/cowork-linux/bin/desktop-ready` was a Python script, and `install-settings` checked JSON with `python3 -c`. Both now run on the image's Node (port 3 below).
- `docker/chatgpt-linux/bin/chatgpt-package`, which picks the ChatGPT Linux package to download, was a Python script. It is now `chatgpt-package.mjs`, run by the image's Node.
- `src/evals/coworkSetup/bundle.ts` and `src/evals/coworkSetup/macTransaction.ts` write credential helpers for Claude Desktop to run, as Python inside a shell script, run with `/usr/bin/python3`. They are now Node scripts (port 2 below).

None of this Python has the checks the TypeScript has. CI doesn't lint, format or type-check it. Its tests run only because `src/evals/cowork/pythonDrivers.test.ts` starts `python3 -m unittest`. The macOS driver also made its own LLM calls, through the Anthropic Python SDK in `run_driver`, rather than MST's `resolveLLMEndpoint()`. That was a second place for MST's LLM calls, which REVIEW.md's "One place per job" rule forbids.

A contributor, or an agent, reading the repo can't tell which language new code should use. MST also asked its macOS users for a Python with pinned packages, on top of Node, and it still needs Python on Linux and for the credential helpers.

## Decision

- **MST's code is TypeScript.** This covers `src/`, the CLI, the drivers for desktop clients, the helpers MST writes for a client to run, and the scripts in the images MST ships.
- **Swift is for macOS APIs that Node can't reach**, such as accessibility and input control. MST compiles it with `nativeHelper.ts`, as `coworkSetup/macController.ts` and `chatgptSetup/macController.ts` do today.
  - A Swift helper takes JSON in and gives JSON out. It does one primitive at a time: read the window, press a control, type text.
  - It holds no eval logic. Waiting, retries, deadlines and what counts as ready stay in TypeScript, where they are tested with the rest.
- **Linux drivers talk to AT-SPI over D-Bus from TypeScript.** AT-SPI is a D-Bus protocol, so it needs no native binding.
  - If a spike on MST's Linux image shows that this is impractical, a thin layer may call `libatspi` through Python's GObject bindings, under the same rule as Swift: primitives over JSON, no eval logic, and only the image's system packages, never pip.
  - That exception needs its own ADR, which amends this one with the spike's evidence.
- **A helper that a client runs is a Node script**, started with the Node that runs MST (`process.execPath`), not `/usr/bin/python3`. It starts isolated, as `python3 -I` does today: nothing in the environment it inherits, such as `NODE_OPTIONS`, can load code into it.
- **New shell is for an image's entry points and one-line glue only.** `scripts/run-cowork.sh`, the macOS runner for a source checkout, predates this ADR and stays; fixes to it are fine.
- **Code that belongs to one organization goes in that organization's plugin** (ADR 0001), in whatever language the plugin uses. MST doesn't carry it. The desktop drivers stay in MST because they drive public clients that MST ships as built-ins (`cowork`, `chatgpt`).
- **A new language, or a new exception, needs an ADR that amends this one.** This includes code inside a TypeScript string, such as an inline script.

## The existing Python

Every piece is ported; MST has no Python. The ports, in order:

1. **`cowork_computer_use.py`**: done. It is TypeScript and a Swift helper, its LLM calls go through `resolveLLMEndpoint()`, and MST no longer creates a Python environment on macOS. `pythonRuntime.ts`, `scripts/cowork-requirements.txt` and the `./cowork-runtime` and `./cowork-requirements` exports are gone, with a migration note.
2. **The credential helpers in `bundle.ts` and `macTransaction.ts`**: done. Their checks (owner-only, no symlinks, size limit, file unchanged while read) are `readCredential` in `coworkSetup/credentialHelper.ts`, typed and tested in-process. Each helper is a shell script that runs that function's own source on the Node that runs MST, with a few lines of glue that call it and print the result. The wrapper starts Node with `env -i`, so nothing in the environment Claude Desktop starts it with, such as `NODE_OPTIONS`, can load code into it.
3. **`desktop-ready` and `install-settings`**: done. `desktop-ready` runs `cowork/desktopReady.ts` (shipped as `dist/cowork/desktopReady.js`) on the image's Node, and `install-settings` checks JSON with `node -e`.
4. **`cowork_linux.py` and `chatgpt_linux.py`**: done. `linuxAtspiBus.ts` is the one AT-SPI client over D-Bus that every Linux driver uses. First-party and managed (third-party) Cowork keep their workflow policy in `linuxFirstPartyDriver.ts` and `linuxThirdPartyDriver.ts`, over the `LinuxUi` interface that `linuxAtspi.ts` implements. ChatGPT keeps its policy in `chatgpt/linuxDriver.ts`, over the AT-SPI desktop in `chatgpt/linuxAtspiDesktop.ts`. Each runs as an isolated Node entry point on the Node that runs MST. Live smoke checks of the ported drivers are pending; offline tests do not establish live compatibility.

With the last port, MST removed `pythonDrivers.test.ts`, the `MST_COWORK_PYTHON` and `MST_CHATGPT_PYTHON` settings, and `python3`, `python3-gi` and `gir1.2-atspi-2.0` from both Linux Dockerfiles. The package exports `./cowork-linux-runtime` and `./chatgpt-linux-runtime` stay, as `./cowork-linux-first-party-runtime` already did: each now names a Node entry point in `dist/` (`dist/cowork/linuxThirdParty.js`, `dist/chatgpt/linuxDriver.js`) rather than a Python script. That is a contract change, so it has a migration note.

## Considered

- **Allow Python for desktop drivers.** Python has the best AT-SPI binding. But each language needs its own lint, type check, test runner, packaging and review rules, and MST has none of them for Python. The macOS driver showed the cost: its pip packages installed on the user's machine at run time, and it grew a second LLM path that no TypeScript check could see.
- **Move the drivers to a plugin.** They drive public clients that MST ships as built-ins, so every user of the `cowork` and `chatgpt` clients needs them. A plugin is for what one organization needs.
- **A Node binding for `libatspi`** through GObject introspection. It would be a native addon, built for each platform and Node version. D-Bus needs no build.

## Not decided here

- **An MST image for the ChatGPT Linux client.** MST ships the driver but no image, unlike Cowork's `docker/cowork-linux`. Whether MST should ship one comes later.
- **How a Swift helper is tested** beyond today's mocked execution in `nativeHelper.test.ts`.

## Consequences

- New Python fails review (REVIEW.md, "One language"), and AGENTS.md tells agents to write TypeScript.
- No MST run needs Python: macOS and every Linux driver use Node, and the Linux images install no Python.
- `./cowork-linux-runtime` and `./chatgpt-linux-runtime` name Node entry points, run with `process.execPath`, not Python scripts.
