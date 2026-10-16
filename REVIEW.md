# REVIEW.md

Rules for reviewing changes in this repository. People and review agents both follow this file.

## Always check

- **Contracts.** The public exports, the `mst.run/v1` run format, eval and dataset config, the plugin shape, and the CLI's flags and output are contracts. A change to one updates the schema (`npm run schema:generate`, committed), the docs that describe it, and the changelog. Removing or renaming anything needs a migration note.
- **One place per job.** `evals/caseExecution.ts` is the only place a case runs. `llm/resolveLLMEndpoint()` is the only place MST's own LLM calls get a base URL and credential. A change that adds a second path for either is a blocker.
- **One language.** MST is TypeScript, with Swift only for macOS APIs that Node can't reach ([ADR 0006](docs/adr/0006-mst-is-written-in-typescript.md)). New code in any other language is a blocker unless an ADR allows it. That includes a Python or other script, a script inside a TypeScript string, and a script in an image MST ships. Fixes to the existing Python that ADR 0006 lists are fine until it is ported.
- **Matchers stay thin.** A Playwright matcher adapts a validator. It returns the validator's `pass` and never negates inside the matcher.
- **Concepts stay documented.** A change that adds or changes a concept updates `CONTEXT.md`, the ADR it touches, and the status table in `docs/design/explainer.md`.
- **Public repo.** Docs, fixtures, tests, commit messages and PR descriptions use neutral examples, such as the fictional Acme. They contain no internal ticket IDs, internal project names, or internal results.

## Flag only when

- The change behaves wrongly in a scenario you can describe, breaks a contract above, or loses an error. Name the scenario.
- A test would pass even if the change were reverted, or the test needs a mock of code this repo owns. That usually means a coupling problem, not a testing problem.
- A failure is silent, vague, or blamed on the wrong part. Errors say what failed, for which input, and what to do next.

## Skip

- Generated files: `schema/run/v1/`, `dist/`, and the built report UI.
- Formatting and lint issues that `npm run format` and `npm run lint` already handle.

## Severity

- **Blocker:** wrong behavior, data loss, a security problem, or a contract change without its schema, docs and migration note.
- **Should fix:** changed behavior without a test, a second path for a single-path job, or an unclear name in a public API.
- **Nit:** anything else. Group nits together and never block on them.
