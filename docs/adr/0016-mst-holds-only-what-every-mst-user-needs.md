---
status: proposed
---

# MST holds only what every MST user needs

MST has three parts with three owners ([ADR 0001](./0001-eslint-style-declarative-plugins.md)): MST itself, an organization's plugin, and a team's eval configs. [ADR 0006](./0006-mst-is-written-in-typescript.md) adds that MST's code is TypeScript and that code for one organization goes in its plugin. Those rules say what MST is. They don't say where a new change goes, and more people now send changes. Two kinds of change show the gap.

- **A tool around MST, proposed as part of MST.** A harness that runs another eval framework's tasks on MST's clients does its work by calling `mst run`. It was proposed as a second workspace in this repo, in Python, with its own manifest and lockfile. Nothing in it needs to be here: it uses MST the way any user does. In this repo it would be a second language that CI doesn't check, and a second package that every release has to carry.
- **One product's rules in core.** The `cowork` client's first-party mode has limits of its own: one shard, no detached runs, no simulated writes. Eval loading, config validation and the detached launch each import `cowork/firstParty.ts` and ask `isFirstPartyCowork(...)` to apply them. Core now knows one mode of one product by name. The next product with a limit adds another branch in the same places.

Each change is reasonable to the person who makes it. Together they make the repo larger for every user and core harder to hold in your head. The first breaks a rule that `REVIEW.md` already has, so a rule that only a reviewer applies isn't enough. The second breaks no written rule, because none says what core may know about a product.

## Decision

**A change goes in the first home on this list that fits.**

1. **Its own repo**, when it uses MST only through the `mst` command or the package's public exports. It can be in any language. If it needs something MST doesn't export, the change to MST is that export, not the tool.
2. **An organization's plugin**, when one organization needs it (ADR 0001, ADR 0006).
3. **A product's own code**, when one client product needs it.
4. **Core**, for what is left: what every user of MST needs.

Three rules follow.

- **Core names no product.** Product code is the code for one client product, such as Claude Desktop, ChatGPT or Codex. It lives in that product's directory and client file under `src/evals/`.
  - Core reaches a product only through its client definition: its options schema, its sessions and what it declares about itself.
  - When core has to treat a client differently, the client declares a general property and core reads the property. `checksServersAfterPrepare` and `assertClientSupports` already work this way. Core doesn't ask which product, or which mode, it is running.
  - Three kinds of file may import product code: `builtinClients.ts`, which adds the built-in clients; the entry points in `src/entries/`, which export a product's public names; and a product's own CLI command.
- **No product is the reference product.** MST runs evals on several clients, and each is one surface among them. Defaults, the run format, the report and the general docs describe clients in general. A product's modes and limits are on that product's page.
- **A new contract, mode or protocol has an accepted ADR before its code merges.** The contracts are the ones `REVIEW.md` lists. A mode is an option that changes how a client runs or what a run's results mean. A protocol is any format MST exchanges with another process. For a large change, the ADR is its own pull request, first.

MST stays one package in one language. It has no workspaces, and no `package.json` outside the root, the docs site and the examples.

## How it is checked

`tests/repoShape.test.ts` runs with the unit tests, on tracked and new files. It fails on:

- a file that isn't of a kind the repo already holds, which covers another language's source, manifest and lockfile;
- a new top-level directory;
- a second package, or `workspaces` in the root `package.json`;
- an import of product code from core that `KNOWN_PRODUCT_IMPORTS` doesn't list.

Every list is in `tests/repoShape.ts`. A pull request that needs a new entry changes that file, where a reviewer sees it.

## The imports core has today

Core imports product code in five places. They stay until each is replaced, and the list only gets shorter: the test also fails when a listed import is gone, so the entry is deleted with it.

| Core file                       | Imports                  | What replaces it                                                   |
| ------------------------------- | ------------------------ | ------------------------------------------------------------------ |
| `evals/configValidation.ts`     | `cowork/firstParty.ts`   | The client declares which server kinds and write modes it takes    |
| `evals/detach/launch.ts`        | `cowork/firstParty.ts`   | The client declares whether it can run detached                    |
| `evals/runEval.ts`              | `cowork/firstParty.ts`   | The client declares whether MST can list its servers' tools        |
| `evals/evalConfig.ts`           | `coworkSetup/options.ts` | The eval config takes a client's setup options from its definition |
| `evals/clientTelemetryTypes.ts` | `cowork/interaction.ts`  | The telemetry types move to a module no product owns               |

## Considered

- **Review alone.** `REVIEW.md` already said that new Python is a blocker and that organization code goes in a plugin. A review can be skipped, and a reviewer can miss an import in a large diff. A test can't.
- **A monorepo, with a workspace for each tool around MST.** Each workspace needs its own checks, release and docs. This repo's build, `knip`, the release and the docs site all assume one package. People who install MST would get nothing from the other workspaces.
- **ESLint's `no-restricted-imports` for the import rule.** ESLint here skips `src/cli`, and it can't see a new file in another language or a new directory. One test covers all four rules with one set of lists.
- **Moving the desktop clients to plugins.** ADR 0006 considered this. They drive public products that MST ships as built-ins, so they stay, as product code.

## Not decided here

- **Where `mstClient/` belongs.** It holds the `api` and `claude-code` clients and also the types every client returns, so the check doesn't treat it as product code. Splitting it comes later.
- **How the `cowork` client's first-party mode declares its limits.** The table above names the direction. The mode needs an ADR of its own.

## Consequences

- A tool in another language, or a second package, fails CI here and goes to its own repo.
- A product can grow inside its directory without a change to core. A product change that needs core to behave differently adds a general property, with a test for a client that sets it and one that doesn't.
- A reader can learn core without learning any product.
