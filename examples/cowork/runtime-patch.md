# Qualified local Cua runtime

The experimental Cowork host needs two capabilities absent from the public Cua
0.28.0 release:

- Native `AXURL` in `get_window_state` results. This proves the fresh-task route
  without guessing from a window title.
- A native `paste_text` operation that preserves clipboard items and formats,
  selects all and pastes without pressing Return, then restores the clipboard.

[The local source patch](./cua-driver-0.28.0.patch) is included for reproducibility.
It applies to public [trycua/cua](https://github.com/trycua/cua), tag
`cua-driver-rs-v0.28.0`, commit
`1b50c02e2d34734f64d2d22f54eb76cc97b4a663`. Cua is MIT-licensed. The patch is
**not an upstream release** and is not part of the tester's npm runtime bundle.
Apply the zero-context patch only to the pinned commit, using `--unidiff-zero`.

## Build the experimental runtime

Use a separate Cua checkout. For example:

```bash
git clone --depth 1 --filter=blob:none --sparse \
  --branch cua-driver-rs-v0.28.0 https://github.com/trycua/cua.git cua-cowork
cd cua-cowork
git sparse-checkout set libs/cua-driver
git apply --check --unidiff-zero /absolute/path/to/mcp-server-tester/examples/cowork/cua-driver-0.28.0.patch
git apply --unidiff-zero /absolute/path/to/mcp-server-tester/examples/cowork/cua-driver-0.28.0.patch
cd libs/cua-driver/rust
```

The local experiment used Rust **1.96.0** with locked dependency resolution.
The upstream checkout requests 1.97.1; that toolchain was not installed or changed
for the experiment. If 1.96.0 is installed through rustup:

```bash
rustup run 1.96.0 cargo build --locked -p cua-driver
```

With a directly installed Rust 1.96.0 toolchain, use `cargo build --locked -p
cua-driver`. Supply the resulting **absolute** `target/debug/cua-driver` path to
`connectCoworkCua` or `runCoworkExample`. Do not replace a user's globally installed
Cua runtime or weaken OS permission checks.

This is a local development build, not the notarized public release.
Accessibility and Screen Recording consent must already belong to the invoking
host or runtime. Any OS consent remains user-controlled. The tested connection
uses standard permission mode, local MCP stdio, and explicit `mcp --direct`.

## Scope and prior validation

The observations below describe an earlier local build, not a new live
qualification of the current source. Requalify changed runtime/app pairs manually;
the example's offline checks do not exercise the desktop or clipboard.

The patch adds the optional shared URL field and macOS extraction. The paste
operation is explicitly macOS-only. It uses existing desktop/clipboard
permission enforcement and excludes clipboard payloads from output and history.
It keeps backup data in native memory, refuses unreadable or oversized data,
and recognizes AppKit's derived legacy text/HTML aliases.

Focused Rust checks covered contracts, URL extraction, input authorization,
restoration on failure, and clipboard ownership changes. An isolated named
pasteboard test exercised real AppKit HTML/text/custom-format round trips without
using the user's general clipboard. A live Claude Desktop **1.52386.3** run on
macOS **26.5.1 arm64** passed the tester's canonical nonce evaluation.

The current patch also retains desktop and recording exclusion through native
worker completion after cancellation. Those changes have headless regression
coverage, but have not had another live GUI run. Use the nonce example to test
the rebuilt runtime before relying on it.

AppKit provides no interprocess clipboard compare-and-swap, and synchronous
native providers cannot be forcibly canceled safely. Generation checks and RAII
reduce risk but do not prove absolute race-free restoration. Run on an exclusive
GUI worker; do not copy/paste or control the desktop concurrently.

Before a production release, upstream or independently qualify these runtime
capabilities and the intended packaging/signing route. Windows, Linux, remote
workers, unattended provisioning, and isolated profiles are not qualified by
this local experiment.
