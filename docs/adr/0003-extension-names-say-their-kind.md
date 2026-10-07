---
status: accepted
---

# Extension names say their kind

ADR 0001 named plugin extensions `namespace/name`. A name alone did not say what it was, so `acme/correctness` could be a judge, a metric or a dataset, and using it in the wrong place failed with "not available" instead of saying why. The 2.0 design (`docs/design/README.md`) names every extension `<namespace>/<kind>/<name>`, so `acme/judge/correctness` is a judge wherever it appears.

## Decision

- An extension's name is `<namespace>/<kind>/<name>`. The kinds are `dataset`, `client`, `judge`, `pairwise-judge`, `metric`, `result-store`, `connector` and `config`; later kinds (`setup`, `env`, `credential-store`) join the same scheme.
- MST checks the kind against where a name is used. `acme/judge/x` under `datasets` fails at load time with what it is (`"acme/judge/x" is a judge, not a dataset source`). A two-part `acme/x` fails with its full name (`needs its kind: use "acme/judge/x"`).
- Plugin objects keep their keys (`judges`, `datasetSources`, ...); the kind comes from the key an extension is declared under.
- Built-ins are the `mst` namespace. They keep their short names (`file`, `rubric`, `cowork`) and may be written in full (`mst/judge/rubric`). Plugins can't use the `mst` namespace, and plugin extensions have no short form: a bare name that only a plugin has fails with the plugin's full name.
- A scoped namespace (`@scope/pkg`) is read first, so `@scope/pkg/judge/x` is the judge `x` of `@scope/pkg`.

## Consequences

This amends ADR 0001's naming; the rest of 0001 stands. Every plugin reference in eval configs, datasets, shared configs, matcher options and plugin schemas (a `type` literal) gains its kind. Result keys built from a plugin's name, such as a plugin metric's aggregate (`acme/metric/x_rate`), include the kind too.
