# Connector contract: connectors and `mst auth`

> **The connector contract.** It specifies step 4 of the [walkthrough](./README.md) ("Authenticate once"), the `connectors` extension kind and the credential store. It extends the [explainer](./explainer.md). Terms follow [`CONTEXT.md`](../../CONTEXT.md).
>
> **Built:** connectors, `mst auth` / `status` / `revoke`, `mst/credential-store/local`, run preflight, delivery, renewal and cleanup, the [dry-run proxy](../cowork.md#dry-run-proxy) and its [simulated writes](../cowork.md#simulated-writes). **Not yet:** plugin credential stores (`--store` takes a directory; remote stores are planned), and connector servers in an environment other than `local`.

## Goal

An author runs `mst auth` once. After that, every local `mst run` on any client reaches every server in every variant with a fresh token. The author doesn't edit `.env` or copy tokens, and no secret ever goes into a config or a result.

The connector contract is done when the walkthrough's three variants (`aggregated`, `vendor-mcp`, `aggregated-plus-vendor-mcp`) authenticate and run one case each in local Cowork on macOS.

## Who owns what

| Concern                                                              | Owner                                         |
| -------------------------------------------------------------------- | --------------------------------------------- |
| OAuth engine: discovery, PKCE, DCR, device flow, refresh, revocation | MST                                           |
| `mst auth`, `mst auth status`, `mst auth revoke`                     | MST                                           |
| Run lifecycle: preflight, staging, renewal, teardown                 | MST                                           |
| Local credential store                                               | MST (`mst/credential-store/local`)            |
| Vendor facts: URL, client ID and secret, scopes, flow, quirks        | Plugin `connector` extension                  |
| How the client reaches the server (direct, or through a proxy)       | Plugin `connector` extension                  |
| Tool policy (read-only allowlist, writes blocked)                    | Plugin `connector` extension (its proxy)      |
| Remote credential stores (cloud secret managers)                     | Plugin `credential-store` extension (planned) |

MST has no vendor names in its code. Without a plugin, a server with a plain `serverUrl` uses generic MCP OAuth (discovery and DCR), as `mst login` does today.

## New extension kind: `connector`

A connector is one vendor MCP server as an organization uses it. It is referenced as `<namespace>/connector/<name>`, for example `acme/connector/slack`.

```ts
interface ConnectorDefinition {
  /** Default endpoint. An eval config may override it per server. */
  url: string;

  /** Connectors with the same grant share one consent and one refresh grant. Default: the connector's name. */
  grant?: string;

  auth: ConnectorAuth;

  /** How the client reaches the server. Default: the client connects to `url` directly with a bearer token. */
  launch?(ctx: LaunchContext): MCPServerEntry | Promise<MCPServerEntry>;

  /** Fewest tools a working credential must expose. Catches under-scoped grants. Default: 1. */
  minTools?: number;

  /** Shown in errors and in `mst auth status`. */
  notes?: string;
}

type ConnectorAuth =
  | { type: 'none' }
  | { type: 'static'; token(): Promise<string> } // long-lived token from the plugin
  | {
      type: 'client-credentials';
      tokenEndpoint: string;
      scopes?: string[];
      client(): Promise<OAuthClient>;
    }
  | {
      type: 'oauth';
      flow: 'authorization-code' | 'device';
      scopes?: string[]; // empty = what the server advertises
      issuer?: string; // when the server does not publish RFC 8414 metadata
      client?(): Promise<OAuthClient>; // omit to use DCR
      redirectPort?: number; // when the vendor pre-registers the redirect URI
      refreshScope?: string | null; // default 'offline_access'; null = do not request one
      authorizationParams?: Record<string, string>;
    };

interface OAuthClient {
  clientId: string;
  clientSecret?: string;
}

interface LaunchContext {
  url: string; // the resolved endpoint
  tokenFile?: string; // private 0600 file MST keeps current; absent for auth: none
  dataDir: string; // private per-server directory
  label: string; // the server's label in the eval config
  platform: 'darwin' | 'linux';
}
```

The rules:

- **Secrets stay in the plugin.** `client()` and `token()` run at call time. For example, a plugin can read a client secret from a cloud secret manager. MST never stores client secrets.
- **Shared grants.** `mst auth` asks for consent once for each `grant`, using the union of every member's scopes. Gmail, Drive and Calendar can share one Google grant.
- **`launch` is optional.** Without it, MST passes the client `url` and the current access token. With it, the plugin returns a server entry, for example a stdio proxy that reads `tokenFile`. This is where a plugin adds a dry-run proxy that blocks writes, with no MST interceptor kind needed.
- **Tool policy belongs to the connector.** MST doesn't know which tools are writes. A connector that wants writes blocked must launch a proxy that blocks them.

## Referencing connectors in an eval config

A server entry names a connector instead of a transport. `servers` is a map keyed by label, and the key is the connector server's label.

```json
"servers": {
  "acme":  { "transport": "http", "serverUrl": "https://mcp.acme.example/mcp" },
  "slack": { "connector": "acme/connector/slack" },
  "jira":  { "connector": "acme/connector/jira", "url": "https://staging.jira.example/mcp" }
}
```

- `connector` and `transport` are mutually exclusive.
- `url` overrides the connector's default endpoint.
- The connector's plugin must be listed in `plugins`. This is the existing rule for namespaced references.
- A plugin can put these entries in a shared config (`extends`), so an eval config only picks labels.

## `mst auth`

```text
mst auth --config <file> [--server <label>...] [--force] [--store <ref>]
mst auth status --config <file> [--store <ref>]
mst auth revoke --config <file> --server <label> [--store <ref>]
```

`mst auth` takes every server in every variant, resolves connectors, and groups them by grant. For each grant:

| State                             | Action                                                                    | Output                         |
| --------------------------------- | ------------------------------------------------------------------------- | ------------------------------ |
| Valid refresh grant in store      | Nothing                                                                   | `✓ valid`                      |
| Valid, shared with another server | Nothing                                                                   | `✓ valid (shares gmail grant)` |
| Missing, expired or `--force`     | `authorization-code`: open the browser. `device`: print the code and URL. | `→ opening browser… ✓ saved`   |
| `client-credentials`              | Mint one token to prove the client works                                  | `✓ client credentials`         |
| `static` / `none`                 | Call `token()` once / nothing                                             | `✓ static` / `– no auth`       |

After consent, MST connects once and checks `minTools`, so an under-scoped grant fails here and not halfway through a run.

`status` changes nothing and exits non-zero if any grant is missing, so CI can check it. `revoke` calls the vendor's revocation endpoint when it has one, then deletes the grant.

`mst auth` never prints a token. `mst login` and `mst token` stay as per-URL tools on the same OAuth engine.

## What a run does

```text
preflight ─► stage ─► collect (renew as needed) ─► teardown
```

1. **Preflight**, before any client starts: every grant the selected variants need is in the store. Otherwise, stop and print what fixes it:
   `gmail: no grant. Run: mst auth --config evals/x.json --server gmail`
2. **Stage**: refresh each grant once (under the store's lock, because rotating grants must never be redeemed twice). For a connector with `launch`, write the access token to `tokenFile`: one file per grant in a new 0700 directory for the run (outside the client's setup transaction, so renewal can rewrite it). For a connector without `launch`, the client connects over HTTP with the token from a run-private environment variable (`MST_CONNECTOR_TOKEN_<LABEL>`).
3. **Renew**: for each token file whose token expires before the run can end, MST refreshes it `renewBefore` ahead of expiry (default 20 minutes) and atomically rewrites it. The proxy reads the new token on its next request; MCP sessions don't restart. A direct HTTP connection can't be renewed mid-run: use `launch` for servers whose tokens are short-lived. If renewal keeps failing and the token expires, the proxy logs `CONNECTOR_AUTH_EXPIRED` and the affected calls fail.
4. **Teardown**, also on failure: the run removes the token directory when it stops. On Ctrl-C, SIGTERM, SIGHUP or exit without stopping, a process-wide guard removes it synchronously, then lets the signal stop the process as before. A run killed outright (SIGKILL, a crash) can't clean up: each directory records its owner's pid, and the next run removes directories whose owner is gone. Refresh grants stay in the store.

Staging happens before any client starts and is the same for every client: expanded connector servers are plain `stdio` or `http` entries, so Cowork, Claude Code and the `mst` client need no changes.

## The credential store

```ts
interface CredentialStore {
  get(key: string): Promise<StoredGrant | undefined>;
  put(key: string, value: StoredGrant): Promise<void>;
  delete(key: string): Promise<void>;
  /** Serializes refreshes of one grant across processes. */
  withLock<T>(key: string, fn: () => Promise<T>): Promise<T>;
  describe(): string;
}

interface StoredGrant {
  version: 1;
  type: 'oauth' | 'client-credentials';
  refreshToken?: string;
  clientId?: string; // DCR-registered client; never a client secret
  scopes: string[]; // as granted
  issuedAt: string;
  expiresAt?: string; // the refresh grant's own expiry, if any
  serverUrl: string;
}
```

MST ships `mst/credential-store/local`. It stores files at `~/.mcp-server-tester/grants/<namespace>.<grant>.json` (or `$MST_CREDENTIALS_DIR`, or `--store <dir>`), with a 0700 directory, 0600 files and a lock file. The key is per user, not per eval config, so one sign-in serves every config that uses the connector. Plugin stores, such as a cloud secret manager with per-user scoping, implement the same interface; they aren't built yet, so there is no `credentialStores` plugin kind yet.

## Security rules

- Refresh grants exist only in the store and in MST's process memory.
- Access tokens exist only in `tokenFile` (0600, in a 0700 directory the run deletes), in a run-private environment variable, and in process memory.
- Neither may appear in eval configs, `run.json`, traces, results, reports, logs, stdout or the client's MCP settings. Every staged token goes on the run's redaction list.
- Client secrets come from the plugin at call time. MST never writes them anywhere.

## How we test it

| Layer          | What                                                                                                                                                                                                                                                                                                                                                         |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Unit (MST)     | A fake authorization server covering authorization code with PKCE, DCR, device flow, client credentials, rotating refresh, revocation and under-scoped grants. Also: grant grouping and scope union, a lock that allows one redemption under concurrency, renewal rewriting `tokenFile`, expiry becoming an infrastructure error, and the preflight message. |
| Contract (MST) | A fixture plugin with connectors and a fake vendor MCP server. `mst auth`, `status`, `revoke`, then `mst run` on the `mst` client: the token reaches the server and renews. A scan of the run directory and the logs finds no token.                                                                                                                         |
| Cowork (MST)   | Platform doubles: token files staged in the transaction, removed on success, on failure and on cancel.                                                                                                                                                                                                                                                       |
| Plugin (acme)  | Connectors for 7 vendor servers and one direct HTTP server. `launch` returns the dry-run proxy. Writes are blocked: zero write calls reach a fake vendor.                                                                                                                                                                                                    |
| Live (manual)  | `mst auth` against all 8 servers. Then 1 case × 3 variants in local Cowork. Then one run longer than an hour, to show Google renewal.                                                                                                                                                                                                                        |

## Out of scope

- Remote credential stores.
- Token staging in environments: delivering connector tokens into VMs and containers. The environment contract must carry `tokenFile` renewal across the boundary. The `mst.shard/v1` protocol carries tokens ([ADR 0004](../adr/0004-environments-run-shards-over-a-channel.md)), but today a run refuses connector servers in any environment other than `local`.
- An MST-owned interceptor kind.

## Decisions

1. **A server that guards its own writes** is a plugin connector like any other (`acme/connector/search`), without `launch`: the client connects to it directly over HTTP.
2. **Store key** is per user (`<namespace>.<grant>`), so one sign-in serves every eval config.
3. **Proxy runtime** is Node, built into MST (`dryRunProxyServer()`), so a Mac needs nothing beyond what MST needs.
4. **`mst auth` with several missing grants** signs in to each in turn, and reports every failure at the end.
