# Codex desktop first host

This experimental host controls signed macOS `com.openai.codex` build
`26.903.71938` (TeamIdentifier `2DC432GLL2`) through Playwright. It does not use an
external desktop-control runtime, Codex CLI, app-server, selectors supplied at
runtime, clipboard input, or inherited environment variables.

The host declares `evidence: 'structured'` only after a version-gated, read-only
SQLite adapter correlates the exact workspace, prompt hash, thread, completed turn,
terminal answer, MCP calls, and complete results/errors. The runner then reconciles
the native events with the independent fixture ledger before scoring.

## Dedicated profile setup

Use only a dedicated evaluation profile outside tracked source. Never point this
host at a normal Codex profile or its `CODEX_HOME`. Use the exact pinned app binary
supplied for this evaluation. Do not substitute an installed or auto-updated app.
Setup launches no model task and does not inspect sign-in state.

Each case makes a temporary whole-file config swap. It takes a durable private
`.fixture-config` lock, moves any existing `CODEX_HOME/config.toml` into that lock
without decoding, parsing, logging, or copying its values, and installs a fresh
`config.toml` containing only the fixture's exact two nonsecret stdio servers. The
case does not inherit MCP servers or other TOML settings and does not set model,
approval, sandbox, or other security policy. This is not a TOML merge. After the
fresh owned workspace is verified, the neutral approval driver may switch the
current task from exact `Ask for approval` mode to exact `Approve for me` mode. It
uses a max-one policy, a write-ahead receipt, the existing owned Playwright renderer,
and positive post-action verification. It rejects `Full access` and every unknown or
ambiguous mode.

After qualified evidence, settled control, and a clean app exit, restoration puts
the opaque original back with its exact inode, bytes, and mode. If no original
existed, restoration removes the temporary config. If the app rewrote the temporary
config, restoration first archives those rewritten bytes under
`.fixture-config-history/<transaction-id>/temporary.toml` with hash-only metadata,
then restores the original or removes the temporary config. The archive is never
merged into or reused as profile configuration. An uncertain lifecycle does not
archive or restore automatically; it retains the active lock and both config states
for manual review.

An existing config must be a single owner-only regular file with one link and a
maximum size of 128 KiB. Symlinks, hard links, permissive modes, and larger files
are refused before the config changes.

```sh
npx tsx tests/manual/codex/setup.ts \
  --executable /absolute/pinned/ChatGPT.app/Contents/MacOS/ChatGPT \
  --profile /absolute/dedicated/codex-profile
```

Complete sign-in yourself, including password or MFA steps, then quit the app
normally. The command waits for the owned process and helper inventory to exit.
A clean exit permits profile reuse. Any abnormal or incomplete lifecycle keeps the
profile lease quarantined. Never delete a lease to bypass this guard.

## Optional no-submit Electron probe

The probe creates one unique workspace, verifies the owned renderer/window IDs and
fresh home composer, writes bounded shape facts, then requests normal app quit. It
does not fill or submit the composer.

```sh
npx tsx tests/manual/codex/probe-electron.ts \
  --attempt probe-20260914-01 \
  --executable /absolute/pinned/ChatGPT.app/Contents/MacOS/ChatGPT \
  --profile /absolute/dedicated/codex-profile \
  --output /absolute/new-probe-output
```

## Source-checkout three-case suite

This shared CLI is the only supported Codex evaluation runner. Build and run it
only from a repository source checkout. The build includes
the validated `tests/fixtures/desktop-evals` dataset, fixture, ledger checker, and
server. The config contains only a suite attempt ID, pinned executable, dedicated
profile, and new output directory. `configure` and `check` are offline.

```sh
npm run build:codex-shared

node build/codex-shared/tests/manual/codex/cli-shared.js configure \
  /absolute/codex-run.json \
  codex-shared-20260914-01 \
  /absolute/pinned/ChatGPT.app/Contents/MacOS/ChatGPT \
  /absolute/dedicated/codex-profile \
  /absolute/new-suite-output

node build/codex-shared/tests/manual/codex/cli-shared.js check \
  /absolute/codex-run.json
node build/codex-shared/tests/manual/codex/cli-shared.js run \
  /absolute/codex-run.json
```

The suite runs `direct-lookup`, `dependent-lookup`, and `missing-recovery`
sequentially through `runEvalDataset`. Every case gets a fresh derived attempt ID
and output directory. After each host return, it waits at most one second for every
native event's exact wire request/response pair and for the complete case slice to
remain unchanged before strict reconciliation. It requires a qualified structured
host trace, reconciles the independent case-only ledger slice and complete native
result/error witnesses, then writes `fixture-ledger.jsonl`, `runner-result.json`, and
`completion-manifest.json` in that order with exclusive synced writes. The fixture
is disposed only after all attempted lifecycle checkpoints are `closed`. A
`quarantined` or unverified checkpoint retains the fixture and stops later cases.

Only the complete scenario and the fixture's two exact stdio server configs enter
`HostDefinition.run`; no evaluator oracle or environment does.

The host starts one execution deadline before preflight and creates one
`launchCodexElectron` handle. After `ready`, it snapshots only the owned workspace's native SQLite thread IDs
before opening the fresh workspace. It then uses one Playwright `fill()`, verifies exact
plain-text DOM readback, syncs a submit receipt, and performs one root-scoped Send
click. The receipt binds:

- attempt and profile IDs
- process, BrowserWindow, and webContents IDs
- unique generated workspace
- SHA-256 of the full scenario plus unique correlation marker
- `playwright-fill` input mode and exact readback

No operation retries. Cleanup has a separate allowance and awaits handle settlement
and cooperative quit; it never cancels, closes, signals, or kills the app. Only a
verified clean app exit and settled control permit config restoration. Restoration
verifies whether the temporary config still has the installed identity and bytes.
It stages an unchanged temporary file or archives a rewritten one, then restores the
opaque original without changing its inode and bytes. If no original existed, it
removes the temporary config. A clean profile can therefore run repeatably with new
attempt IDs.

A safe pre-submit failure plus normal exit closes a failed attempt. Unknown submit
state, pending work, abnormal or incomplete exit, incomplete submitted evidence, or
a crash phase keeps the attempt, durable config lock, opaque original, current
config, launch resources, receipt, and native evidence state quarantined. A clean
app rewrite of the temporary config is archived and restored as described above; it
does not by itself quarantine the case. A later run refuses a profile with an active
or uncertain transaction and never recovers it automatically. Do not delete or edit
guard files for manual cleanup; retire the quarantined profile and create a new
dedicated profile.

Every prior checkpoint and receipt remains immutable; an attempt ID cannot replay.
Output directories must be new.

## Live qualification

The current source was qualified against the signed pinned build on macOS
**26.5.1 arm64**:

- `codex-probe-live-013`: no-submit owned-renderer, fresh-workspace, and clean-exit proof
- `codex-shared-005`: max-one `Ask for approval` → `Approve for me` transition was armed, applied, and positively verified
- `codex-shared-008`, `codex-shared-010`, and final safety-architecture run `codex-shared-011`: 3/3 canonical cases passed with 1/2/3 native calls, complete result/error pairing, independent-ledger reconciliation, canonical scoring, and clean teardown
- `codex-shared-009`: a duplicate wire-session anomaly was rejected by strict ledger reconciliation; no extra call was accepted as evidence

## Review artifacts

For each clean submitted case under `<suite-output>/cases/<index>-<case-id>/`,
inspect:

- `request.json` and `submit-receipt.json`
- `owned-window.json` and `baseline.json`
- `native-evidence.json` and the native database-format record
- `fixture-ledger.jsonl`, `runner-result.json`, and `completion-manifest.json`
- `host-result.json`
- `<profile>/.host-attempts/<case-attempt>/checkpoint.json`

The suite root also contains `suite-result.json` followed by its own
`completion-manifest.json`.

The independent ledger checker validates wire provenance, call order, arguments,
complete results, and error status against native events. It never creates host
events from the ledger. Do not accept a matching final answer without native MCP
provenance, complete result/error equality, and normal cleanup.

## Offline checks

```sh
npm test -- \
  tests/unit/evals/codex/sharedSuite.test.ts \
  tests/fixtures/desktop-evals/desktopDataset.test.ts \
  tests/fixtures/desktop-evals/desktopFixture.test.ts \
  tests/fixtures/desktop-evals/desktopLedger.test.ts \
  tests/unit/evals/codex/host.test.ts \
  tests/unit/evals/codex/nativeEvidence.test.ts \
  tests/unit/evals/codex/fixtureConfig.test.ts
npm run typecheck
npm run build:codex-shared
npm run lint
npm run format:check
```

Offline tests inject Electron, process, filesystem, and renderer boundaries. They
do not launch a GUI, run a model, access a network, inspect credentials, or write
Git state.
