# REVIEW.md

Rules for reviewing changes in this repository. People and review agents both follow this file.

## Always check

- **The narrowest home.** A change goes in the first of these that fits ([ADR 0016](docs/adr/0016-mst-holds-only-what-every-mst-user-needs.md)): its own repo, when it uses MST only through the `mst` command or the public exports; an organization's plugin; one client product's code; core. A change in a wider home than it needs is a blocker. So is a new contract, mode or protocol without an accepted ADR.
- **Core names no product.** Code for one client product, such as Claude Desktop or ChatGPT, stays in that product's directory and client file. Core reaches it through the client definition, and reads a property the client declares rather than asking which product or mode it is. A new import of product code from core is a blocker; `tests/repoShape.test.ts` fails on one. No product is the reference product: defaults, the run format, the report and the general docs describe clients in general.
- **Contracts.** The public exports, the `mst.run/v1` run format, eval and dataset config, the plugin shape, and the CLI's flags and output are contracts. A change to one updates its schema, the docs that describe it, and the migration guide. `npm run schema:generate` writes the run and history schemas (`schema/run/v1/`, `schema/history/v1/`); `schema/eval-config.schema.json` and `schema/eval-dataset.schema.json` are edited by hand. Both kinds are committed. The changelog comes from the pull request's title and label at release, so a change never edits CHANGELOG.md. Removing or renaming anything needs a migration note.
- **One place per job.** `evals/caseExecution.ts` is the only place a case runs. `llm/resolveLLMEndpoint()` is the only place MST's own LLM calls get a base URL and credential. A change that adds a second path for either is a blocker.
- **One language.** MST is TypeScript, with Swift only for macOS APIs that Node can't reach ([ADR 0006](docs/adr/0006-mst-is-written-in-typescript.md)). New code in any other language is a blocker unless an ADR allows it, and `tests/repoShape.test.ts` fails on it. That includes a Python or other script, a script inside a TypeScript string, and a script in an image MST ships.
- **Matchers stay thin.** A Playwright matcher adapts a validator. It returns the validator's `pass` and never negates inside the matcher.
- **Concepts stay documented.** A change that adds or changes a concept updates `CONTEXT.md`, the ADR it touches, and `docs/architecture.md` when it changes how the parts fit together.
- **Public repo.** Docs, fixtures, tests, commit messages and PR descriptions use neutral examples, such as the fictional Acme. They contain no internal ticket IDs, internal project names, or internal results.

## Flag only when

- The change behaves wrongly in a scenario you can describe, breaks a contract above, or loses an error. Name the scenario.
- A test would pass even if the change were reverted, or the test needs a mock of code this repo owns. That usually means a coupling problem, not a testing problem.
- A failure is silent, vague, or blamed on the wrong part. Errors say what failed, for which input, and what to do next.

## Skip

- Generated files: `schema/run/v1/`, `schema/history/v1/`, `dist/`, and the built report UI.
- Formatting and lint issues that `npm run format` and `npm run lint` already handle.

## Severity

- **Blocker:** wrong behavior, data loss, a security problem, or a contract change without its schema, docs and migration note.
- **Should fix:** changed behavior without a test, a second path for a single-path job, or an unclear name in a public API.
- **Nit:** anything else. Group nits together and never block on them.
