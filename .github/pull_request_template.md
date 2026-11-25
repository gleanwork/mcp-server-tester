## Summary

<!-- What changes, and why. Link the issue it addresses: Fixes #123 -->

## Breaking changes

<!-- None, or what changes for users and where it is documented (docs/migrations/). -->

## Untested

<!-- Delete this section when every line the PR changes in src/ runs in a test. Otherwise list each path no test can run, with the reason, one line each: - `src/path.ts:40-52`: reason. CI's diff-coverage job reads it. -->

## Checks

<!-- What CI runs; note anything you couldn't run. -->

- [ ] `npm run format:check`, `npm run build:check`, `npm run typecheck`, `npm run lint`, `npm run knip`, `npm run docs:check`
- [ ] `npm run test:eval-foundation`, `npm run test:eval-review`, `npm run test:coverage`, `npm run coverage:diff`, `npm run test:playwright`
- [ ] For `docs/`, `skills/` or `website/` changes, the site checks in the pre-push checklist in AGENTS.md
- [ ] The change is in its narrowest home: its own repo, a plugin, one product's code, or core (REVIEW.md); a new contract, mode or protocol has an accepted ADR
- [ ] Tests cover the change
- [ ] Docs updated
- [ ] Labeled `breaking`, `enhancement`, `bug`, `documentation` or `internal` (the changelog is generated from labels and titles; don't edit CHANGELOG.md)
