## Summary

<!-- What changes, and why. Link the issue it addresses: Fixes #123 -->

## Breaking changes

<!-- None, or what changes for users and where it is documented (docs/migrations/). -->

## Checks

<!-- What CI runs; note anything you couldn't run. -->

- [ ] `npm run format:check`, `npm run build:check`, `npm run typecheck`, `npm run lint`, `npm run knip`, `npm run docs:check`
- [ ] `npm run test:eval-foundation`, `npm run test:eval-review`, `npm run test:usecases`, `npm test`, `npm run test:playwright`
- [ ] For `docs/`, `skills/` or `website/` changes, the site checks in the pre-push checklist in AGENTS.md
- [ ] Tests cover the change
- [ ] Docs updated
- [ ] Labeled `breaking`, `enhancement`, `bug`, `documentation` or `internal` (the changelog is generated from labels and titles; don't edit CHANGELOG.md)
