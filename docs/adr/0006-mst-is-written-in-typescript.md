---
status: accepted
---

# MST is written in TypeScript

MST is a TypeScript package, and its checks are TypeScript checks: `typecheck`, `lint`, `format`, `knip`, Vitest and Playwright. During the 2.0 prereleases it also gained Python:

- `scripts/cowork_computer_use.py` drives Claude Desktop on macOS with a computer-use loop. It needs `anthropic`, `pyautogui`, `mss`, `Pillow` and pyobjc, which `src/evals/cowork/pythonRuntime.ts` installs into a venv on the user's machine at run time, from `scripts/cowork-requirements.txt`.
- `scripts/cowork_linux.py` and `scripts/chatgpt_linux.py` drive Claude Desktop and ChatGPT on Linux over AT-SPI, through Python's GObject bindings.
- `docker/cowork-linux/bin/desktop-ready` is a Python script, and `install-settings` checks JSON with `python3 -c`.
- `src/evals/coworkSetup/bundle.ts` and `src/evals/coworkSetup/macTransaction.ts` write credential helpers for Claude Desktop to run, as Python inside a shell script, run with `/usr/bin/python3`.

None of this Python has the checks the TypeScript has. CI doesn't lint, format or type-check it. Its tests run only because `src/evals/cowork/pythonDrivers.test.ts` starts `python3 -m unittest`. The macOS driver also makes its own LLM calls: it reads `ANTHROPIC_API_KEY` when it has no token and defaults to `https://api.anthropic.com` (`run_driver` in `cowork_computer_use.py`). That is a second place where MST's LLM calls get a base URL and credential, which REVIEW.md's "One place per job" rule forbids.

A contributor, or an agent, reading the repo can't tell which language new code should use. MST also asks its users for a Python with pinned packages, on top of Node.

## Decision

- **MST's code is TypeScript.** This covers `src/`, the CLI, the drivers for desktop clients, the helpers MST writes for a client to run, and the scripts in the images MST ships.
- **Swift is for macOS APIs that Node can't reach**, such as accessibility and input control. MST compiles it with `nativeHelper.ts`, as `coworkSetup/macController.ts` and `chatgptSetup/macController.ts` do today.
  - A Swift helper takes JSON in and gives JSON out. It does one primitive at a time: read the window, press a control, type text.
  - It holds no eval logic. Waiting, retries, deadlines and what counts as ready stay in TypeScript, where they are tested with the rest.
- **Linux drivers talk to AT-SPI over D-Bus from TypeScript.** AT-SPI is a D-Bus protocol, so it needs no native binding.
  - If a spike on MST's Linux image shows that this is impractical, a thin layer may call `libatspi` through Python's GObject bindings, under the same rule as Swift: primitives over JSON, no eval logic, and only the image's system packages, never pip.
  - That exception needs its own ADR, which amends this one with the spike's evidence.
- **A helper that a client runs is a Node script**, started with the Node that runs MST (`process.execPath`), not `/usr/bin/python3`.
- **Shell is for an image's entry points and one-line glue only.**
- **Code that belongs to one organization goes in that organization's plugin** (ADR 0001), in whatever language the plugin uses. MST doesn't carry it. The desktop drivers stay in MST because they drive public clients that MST ships as built-ins (`cowork`, `chatgpt`).
- **A new language, or a new exception, needs an ADR that amends this one.** This includes code inside a TypeScript string, such as an inline script.

## The existing Python

Fixes to the Python above can continue until each piece is ported. The ports, in order:

1. **`cowork_computer_use.py`**: to TypeScript and a Swift helper. Its LLM calls go through `resolveLLMEndpoint()` and the Anthropic TypeScript SDK. This ends the second LLM path, so it goes first.
2. **The credential helpers in `bundle.ts` and `macTransaction.ts`**: to Node scripts, keeping their checks (owner-only, no symlinks, size limit, file unchanged while read).
3. **`desktop-ready` and `install-settings`**: to TypeScript run by the image's Node, and `node -e`.
4. **`cowork_linux.py` and `chatgpt_linux.py`**: to TypeScript over D-Bus, after the spike.

After the last port, MST removes `pythonRuntime.ts` and its test, `pythonDrivers.test.ts`, `scripts/cowork-requirements.txt`, the `MST_COWORK_PYTHON` and `MST_CHATGPT_PYTHON` settings, and `python3`, `python3-gi` and `gir1.2-atspi-2.0` from the Dockerfile. It also removes the package exports `./cowork-runtime`, `./cowork-linux-runtime`, `./chatgpt-linux-runtime` and `./cowork-requirements`. Those are contracts, so their removal gets a migration note.

## Considered

- **Allow Python for desktop drivers.** Python has the best AT-SPI binding. But each language needs its own lint, type check, test runner, packaging and review rules, and MST has none of them for Python. The macOS driver shows the cost: its pip packages install on the user's machine at run time, and it grew a second LLM path that no TypeScript check could see.
- **Move the drivers to a plugin.** They drive public clients that MST ships as built-ins, so every user of the `cowork` and `chatgpt` clients needs them. A plugin is for what one organization needs.
- **A Node binding for `libatspi`** through GObject introspection. It would be a native addon, built for each platform and Node version. D-Bus needs no build.

## Not decided here

- **An MST image for the ChatGPT Linux client.** MST ships the driver but no image, unlike Cowork's `docker/cowork-linux`. Whether MST should ship one comes later.
- **How a Swift helper is tested** beyond today's mocked execution in `nativeHelper.test.ts`.

## Consequences

- New Python fails review (REVIEW.md, "One language"), and AGENTS.md tells agents to write TypeScript.
- Until port 1 lands, macOS Cowork runs still need `python3` and its venv.
- The four package exports above go away during the 2.0 prereleases, with a migration note.
