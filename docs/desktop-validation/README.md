# Validating a desktop transport

[ADR 0017](../adr/0017-desktop-clients-share-one-automation.md) moves every desktop client to one automation, `agent-desktop`, but changes no client's default until the move is proven. This directory holds the proof: one record for each client and OS, named `<client>-<os>.md` (`cowork-linux.md`, `cowork-first-party-darwin.md`). The clients are the keys of `DESKTOP_DEFAULTS` in `src/evals/desktopDefaults.ts`, and the OSes are `linux` and `darwin`.

`tests/desktopValidation.test.ts` fails when a client's default is `agent-desktop` and its record is missing, and when a record lacks a section below. A new desktop client is validated the same way before it ships on `agent-desktop`.

## The four checks

Run them on one machine, with one version of the app, against the transport the client runs on today and against `agent-desktop`. Where a check can't run, say so under **Not checked** rather than leaving it out.

1. **Parity.** `mst desktop parity --app <name>` reads one idle screen of the running app through the client's default transport and through `agent-desktop`, and lists every control that differs by role, name or state. It presses nothing. Run it on the screens the client's rules match: the empty prompt, a running task, an approval. Where the default reads no tree (Computer Use on macOS) there is nothing to compare, and the record says so.

2. **Recorded trees.** `mst desktop snapshot --app <name> --automation agent-desktop --out <file>` saves what the app shows, from a profile that holds nobody's data. Commit the trees as fixtures and run the client's rules against them in CI, so a change to the rules or the transport shows up before a live run does.

3. **Each operation, live.** In a profile made for the check, with `MST_DESKTOP_AUTOMATION=agent-desktop`: reach an empty prompt, enter a prompt with line breaks and read it back, send once, choose the model, answer an approval, and reset after a failure. Record what each did, with the receipt's `telemetry.automation`.

4. **A paired run.** One fixed eval, run with `mst run` on each transport, on the same machine and version. Compare the endings, the pass rate and the duration.

## The record

```markdown
# <client> on <os>

## Versions

MST, the app, the OS, agent-desktop, and the date.

## Parity

Which screens, how many controls, and each difference with why it is or isn't a problem.

## Recorded trees

Where the fixtures are, and which test runs the rules against them.

## Each operation, live

One line per operation: what was done, what the app showed, the receipt.

## A paired run

The eval, both runs' directories, endings, pass rate and duration.

## Not checked

What the checks above left out, and why.
```

A default changes in its own pull request, with the record, a note in the migration guide, and the replaced transport kept for one release.
