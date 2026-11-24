---
status: proposed
---

# Desktop clients share one automation, and Computer Use is the exception

MST runs evals on three kinds of client. The `api` client is the model alone. `claude-code` and `codex-cli` are command-line tools that MST starts as processes. `cowork`, `chatgpt` and `codex-app` are desktop apps, which MST has to operate the way a person does.

[ADR 0011](./0011-a-client-is-a-product-and-how-it-runs-is-not-configuration.md) decided that how a client runs follows from the client and the OS, and it recorded what each desktop client used at the time: Computer Use on macOS and an accessibility (AT-SPI) automation on Linux. It listed that difference among the ones that stay "because the products differ". The products don't differ in this. MST's code does:

- **MST drives a desktop app in three ways.** On macOS, a planner model reads screenshots and moves the mouse (Computer Use). On Linux, Cowork has one AT-SPI adapter and ChatGPT has another. They share a D-Bus client. Above it, each has its own node type, its own interface and its own rules.
- **Computer Use is slow and it guesses.** In a live comparison on one machine and one version of Claude Desktop, submitting a prompt took a median of 61.4 s with Computer Use and 3.5 s through the accessibility tree. Two of six Computer Use submits started a task; seven of seven did through the accessibility tree. Computer Use also needs a planner model with its credential and its cost, needs Screen Recording permission, and takes the pointer and the keyboard.
- **One client behaves differently on each OS.** `computerUseModel` is valid on macOS and an error on Linux, and `maxActions` has a different range on each. Approvals, resets and failures follow different code on each OS, so the same eval isn't run by the same rules.
- **A new desktop client writes its own automation.** ChatGPT's Linux code is an adapter of about 500 lines and rules of about 700, beside Cowork's. The Computer Use loop is in `cowork/` and takes `application: 'cowork' | 'chatgpt'`, so one product's directory holds another product's branches.

More desktop clients will come. Each one today means a new automation for each OS.

## Decision

- **A client is one of three kinds, and the kind decides how MST runs it.**

  | Kind          | Built-in clients                 | How MST runs it                                             |
  | ------------- | -------------------------------- | ----------------------------------------------------------- |
  | The API       | `api`                            | Calls the model's provider and the servers' tools itself    |
  | A CLI         | `claude-code`, `codex-cli`       | Starts the tool as a process and reads what it writes       |
  | A desktop app | `cowork`, `chatgpt`, `codex-app` | Operates the app's window through the OS accessibility tree |

  A plugin's client is one of these kinds too. This replaces ADR 0011's rule that the client and the OS decide.

- **Where a desktop client runs is the runner's business, not the client's.** The same client code runs on `local`, in a `docker` container and on a runner extension's machines ([ADR 0004](./0004-environments-run-shards-over-a-channel.md)). A desktop in a container or a VM is not another kind of client. Running many desktops at once, as a browser-testing grid runs many browsers, means a runner with more machines. It never means a change to a client.

- **Every desktop client is driven through the OS accessibility tree, with [`agent-desktop`](https://github.com/vercel-labs/agent-desktop), on every OS.** MST reads the app's controls by role and name and acts on them directly: it sets the prompt's text and presses the control that sends it. No screenshot is read and no model decides where to click. `agent-desktop` uses the AX API on macOS, AT-SPI on Linux and UI Automation on Windows, behind one command-line interface.

- **One interface, which no product owns.** It has six operations: take a snapshot of the app's window, read a control's text, activate a control, bring a control into view, enter text in a control, and open a link in the app. A transport implements them over one way of reaching the app. `agent-desktop` is the transport every client moves to, and MST's AT-SPI client is a transport too. What differs between OSes stays inside a transport: how the app's window is found, how a link is opened, and what a Linux session needs. A client's rules never name a transport. One module of the client does, so the transport under a client changes there and nowhere else. The interface and its transports live in a directory of their own under `src/evals/`, outside every product's directory, and a test fails when a product is named there.

- **A desktop client supplies three things and no automation code.**
  1. **Its identity:** how to tell its window from every other window, and the link that opens a new conversation.
  2. **Its rules:** which controls are the prompt, the send control, the model picker and an approval, and what the app shows when it is ready, busy or waiting on a question. They are written once, over the interface, and not once per OS. Where the app differs between OSes, that is a branch in the rules.
  3. **Its setup and its evidence:** how the app is installed, signed in, configured and restarted, and how its own record of a conversation becomes a transcript.

  Adding a desktop client means writing those three. It means no accessibility code, no screenshot loop and no OS-specific entry point beyond setup.

- **The rules for acting on someone's app are shared too.** Every read and action has a deadline. An action is never repeated. A prompt is sent once. When MST can't tell that the app shows the trial's own conversation, it presses nothing and the trial fails. Every client reports an action with the same receipt and the same named failures.

- **Something else is allowed only when it must be.** A client on an OS may be driven another way only when all of these hold:
  1. An operation the client needs can't be done through `agent-desktop` on that app and that OS.
  2. A live check shows it, and the pull request records the check.
  3. This ADR's table of exceptions gains a row: the client, the OS, the operation, and what would remove the exception.

  Slower is not a reason. A workaround that MST has to carry is not a reason either, while it works. Computer Use is the fallback on macOS. It stays, as code no product owns, for as long as one exception uses it, and it is deleted with the last one.

- **Code that hasn't moved is debt, not an exception.** The table below lists it. Each row is replaced, in the order under "Order of work".

- **`agent-desktop` is a pinned dependency behind one module.**
  - One module runs it. Nothing else in MST starts the binary or reads its output.
  - `package.json` names an exact version. An upgrade is its own pull request, with the live checks run again.
  - It is an optional dependency, so installing MST doesn't fail on a machine that drives no desktop. A desktop client fails before it touches the app when the binary is missing, and says how to install it.
  - A workaround for a defect in it lives in the shared implementation, names the upstream issue, and is removed when a release fixes it.
  - It is written in Rust and MST runs it as it runs `xdotool`. MST's own code stays TypeScript ([ADR 0006](./0006-mst-is-written-in-typescript.md)).

- **A client's default changes only after proof, and both ways of driving it stay until then.** A client on an OS has one default, which is what it ran on before this ADR. It may have a second way, which it can be run on while that way is proven. Merging a transport changes no default.
  - The second way is chosen with `MST_DESKTOP_AUTOMATION=agent-desktop`, in the environment of the machine that runs the trial. It is not an eval config option: how a client runs is still not configuration (ADR 0011). The variable is for proving a move, and it goes when the last default has changed.
  - A value that a client can't run on fails before MST touches the app.
  - A receipt written on anything but the default names what wrote it, so two runs can be told apart.

- **Proof is the same four checks for every client, and anyone can run them again.**
  1. **Parity.** `mst desktop parity` reads one idle screen of the live app through both transports and lists every control that differs. It presses nothing. Where the default reads no tree (Computer Use), there is nothing to compare, and the next check stands alone.
  2. **Recorded trees.** `mst desktop snapshot` saves what the app shows, from a profile that holds nobody's data. The saved trees are test fixtures, and the client's rules run against them in CI.
  3. **Each operation, live.** In a profile made for the check: reaching an empty prompt, entering a prompt with line breaks and reading it back, sending once, choosing the model, answering an approval, and resetting after a failure.
  4. **A paired run.** One fixed eval, run with `mst run` on each way, on the same machine and the same version of the app. The endings, the pass rate and the duration are compared.

  The results go in a record under `docs/desktop-validation/`, one for each client and OS. A record names the versions, gives each check's result, and lists what was not checked. A test fails when a client's default is `agent-desktop` and it has no record. The guide to the four checks is in the same directory, and a new desktop client is validated by the same guide.

- **What a default replaced is deleted last.** It stays for one release after the default changes, so a regression can be checked against it.

- **Options follow.** `computerUseModel` stays valid for a client and OS while Computer Use is its default. After the default changes it fails validation, unless the table of exceptions lists that client and OS. `maxActions` means one thing with one range on every OS.

## Where each client stands

As of 2026-11-21. "Driven today by" is the default, and no default has changed. "Tried" means a live check; nothing here is a complete `mst run`, and no row has a record of proof.

| Client and OS                 | Driven today by          | State             | What is known                                                                                                                                                           |
| ----------------------------- | ------------------------ | ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `cowork`, first-party, macOS  | Computer Use             | Built, not merged | The comparison above. Not tried: a live approval.                                                                                                                       |
| `cowork`, third-party, macOS  | Computer Use             | Not tried         | The same app as the row above.                                                                                                                                          |
| `cowork`, Linux               | Cowork's AT-SPI adapter  | Tried in a spike  | The tree has the same names and depths as the adapter's. Clicks work. Prompts go in by a clipboard paste, 16,391 characters and 300 lines included. Not tried: sending. |
| `chatgpt`, `codex-app`, macOS | Computer Use             | Read only         | On ChatGPT 26.1111.21308, `agent-desktop` reads a complete tree (1,240 nodes). The prompt takes a set value and the send control takes a click. Nothing was pressed.    |
| `chatgpt`, `codex-app`, Linux | ChatGPT's AT-SPI adapter | Not tried         | Today its first-run profession choice needs a real mouse click.                                                                                                         |
| Any client, Windows           | Nothing                  | Not tried         | MST has no setup for a desktop app on Windows.                                                                                                                          |

### Exceptions

None. No client has been shown to need Computer Use.

### What `agent-desktop` needs on Linux

Found in the spike, with `agent-desktop` 1.3.1 and Claude Desktop 5.11492.5 in MST's image:

- **A window manager.** Without one it can't tell the app's window from its other frames. The image runs one.
- **A clipboard paste for the prompt.** Chromium's editors offer no set-value over AT-SPI. Typed keys can't carry a line break, because the key for it also sends the prompt. A paste carries every prompt tried.
- **A client that stays on the accessibility bus.** `agent-desktop` connects for one command and leaves. When the last client leaves while Chromium handles a key, Chromium crashes ([agent-desktop#529](https://github.com/vercel-labs/agent-desktop/issues/529)). One key press crashed the app in 5 of 5 runs, and one paste in 3 of 3. With a client held for the whole batch, neither crashed it in 15 presses and 8 pastes. MST holds that client until a release fixes the cause.
- **More time for each snapshot:** about 580 ms, against 14 to 33 ms for MST's adapter. This ADR accepts that for one implementation. What it adds to a whole run isn't measured.

## Order of work

Each step is its own pull request. A step that lets a client run on `agent-desktop` changes no default. A step that changes a default comes with its record.

1. The interface moves out of `cowork/`, with MST's AT-SPI client behind it as a transport. Nothing changes for a run.
2. `agent-desktop` becomes a transport, with the variable that chooses it and the two commands. `cowork` on Linux can run on it, with what the section above lists.
3. `cowork` first-party on macOS can run on it.
4. Each of those two is proven, and its default changes.
5. `cowork` third-party on macOS: it can run on it, it is proven, and its default changes. After it, `cowork` uses no Computer Use.
6. `chatgpt` and `codex-app` on macOS, in the same three parts, with their rules written over the interface.
7. `chatgpt` and `codex-app` on Linux, on the same rules.
8. What nothing uses is deleted, a release after the last default that used it changed: the Computer Use loop, its planner and its Swift helper (about 2,300 lines), and both AT-SPI adapters (about 950 lines).

The Linux drivers of `cowork` run most of today's evals, and other work changes them often. Steps 1 and 2 leave their rules alone, so that work and this don't collide.

## Considered

- **The best tool for each OS**, which is ADR 0011's position. MST's AT-SPI adapter is faster on Linux than `agent-desktop`, and it has no upstream crash to work around. But every client then has an automation for each OS, a fix lands in one and not the others, and a new client starts from nothing.
- **Computer Use everywhere.** It is one path and it works on any app that draws a window. The comparison above is why not: it is slow, it costs a model call for each step, and it doesn't do the same thing twice.
- **MST's own accessibility client for each OS.** MST has one for AT-SPI. It would need a second in Swift for macOS and a third for Windows, and reading a tree and pressing a control is all that `agent-desktop` does.
- **The Chrome DevTools Protocol**, since the apps are built on Electron. Claude Desktop blocks the switches that open a debugging port, and starting an app with one changes the app under test.

## Not decided here

- **Windows.** `agent-desktop` supports it. MST has no setup, image or runner for a desktop app there.
- **How many desktops one machine runs.** A Docker host runs one Claude Desktop container at a time, because the app's VM service listens on a port the whole host shares ([Cowork in Docker](../cowork-docker.md)). Running more at once is runner work.
- **Whether a client definition names its kind.** Today a client that needs no desktop declares `headless`, and core reads that. A `kind` field waits until core needs one.
- **Shared timeouts and reset timings**, which ADR 0011 left for later.

## Consequences

- **ADR 0011 and ADR 0006 change when this is accepted.** ADR 0011's "On macOS … use Computer Use. On Linux they use the accessibility (AT-SPI) automation" becomes this ADR's rule, and its consequence that the difference stays is withdrawn. ADR 0006's "Linux drivers talk to AT-SPI over D-Bus from TypeScript" holds only for code that hasn't moved, and for the held client. Each gets a note.
- **MST depends on a young tool for every desktop client.** `agent-desktop` reached 1.0 on 2026-10-28 and had six more releases in the next sixteen days. The pin, the single module and the live checks on an upgrade are how MST carries that. If the tool stops being maintained, the interface is where another implementation goes.
- **A macOS desktop run needs less.** A client with no exception needs no planner model, no credential for one and no Screen Recording permission.
- **Nothing changes for a run until a default does.** A run that doesn't set `MST_DESKTOP_AUTOMATION` is driven as it was. A default change is a breaking change of its own: it ships with its record and a note in the migration guide.
- **The eval config changes with a default.** `computerUseModel` fails on a client whose default is no longer Computer Use. The migration guide lists each change as its step lands.
- **MST carries two ways of driving a client for a while.** That is the cost of proving a move before making it. The order of work ends it.
- **Transcripts don't change.** They come from the app's own record of a conversation, not from how MST pressed its controls.
- **When the defaults change, Linux runs get slower by the snapshot time, and macOS runs get faster.** The paired runs measure by how much.
- **`CONTEXT.md`, `docs/cowork.md` and `docs/chatgpt-desktop.md` change with each step**, not before it.
