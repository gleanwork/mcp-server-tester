/**
 * Connector servers in a run: expand `{ "connector": "acme/connector/slack" }` entries
 * into the server entries clients launch, then keep their tokens fresh while
 * the run lasts and delete them when it ends.
 *
 * Expansion uses paths and environment variable names, never tokens, so the
 * expanded config can be validated, logged and dry-run. Tokens arrive only
 * when `startConnectorCredentials` writes them: to a private file per grant
 * (for a connector that launches a proxy reading it), or to a run-private
 * environment variable (for a direct HTTP connection).
 */
import { randomUUID } from 'node:crypto';
import { mkdir, open, realpath, rename } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { validateMCPConfig, type MCPConfig } from '../config/mcpConfig.js';
import {
  getConnector,
  grantIdentity,
  grantTargets,
  type ConnectorUse,
} from '../auth/grants/connectors.js';
import {
  MissingGrantError,
  accessToken,
  type GrantTarget,
} from '../auth/grants/grants.js';
import type { CredentialStore } from '../auth/grants/types.js';
import type { FetchFn } from '../auth/grants/oauthHttp.js';
import {
  TOKEN_DIRECTORY_PREFIX,
  claimTokenDirectory,
  releaseTokenDirectory,
  sweepStaleTokenDirectories,
} from './tokenDirectories.js';
import {
  isConnectorServer,
  type ConnectorServerConfig,
  type EvalConfig,
  type EvalServerConfig,
} from './evalConfig.js';

/** Renew a token this long before it expires. */
const RENEW_BEFORE_MS = 20 * 60_000;
const MIN_RENEW_DELAY_MS = 30_000;
const RENEW_RETRY_MS = 60_000;

/** The label a connector server has: its own, else the connector's name. */
function connectorLabel(server: ConnectorServerConfig): string {
  return (
    server.label ??
    server.connector.slice(server.connector.lastIndexOf('/') + 1)
  );
}

function envName(label: string): string {
  return `MST_CONNECTOR_TOKEN_${label.toUpperCase().replace(/[^A-Z0-9]/g, '_')}`;
}

/** One credential a run must deliver. */
interface CredentialSlot {
  target: GrantTarget;
  /** The labels of the servers that use this grant. */
  labels: string[];
  /** Private file for a launched connector (one per grant). */
  file?: string;
  /** Run-private env var for a direct HTTP connection. */
  envNames: string[];
}

/** An eval config with its connector servers expanded. */
export interface ConnectorExpansion {
  evalConfig: EvalConfig;
  /** Every connector server, across the config and its variants. */
  uses: ConnectorUse[];
  /** Grants to deliver, and where. Empty when no connector is used. */
  slots: CredentialSlot[];
  /** The grant keys each variant's servers use (`''`: the config's own servers). */
  grantsByVariant: Map<string, Set<string>>;
  /** The private directory token files go in (not yet created). */
  tokenDirectory?: string;
  /** Where the dry-run proxies record simulated writes, one file per server label. */
  simulatedWriteFiles: string[];
}

function connectorUse(server: ConnectorServerConfig): ConnectorUse {
  const connector = getConnector(server.connector);
  const url = server.url ?? connector.url;
  const parsed = new URL(url);
  if (
    parsed.protocol !== 'https:' &&
    !['127.0.0.1', 'localhost'].includes(parsed.hostname)
  )
    throw new Error(`Server "${connectorLabel(server)}": url must be https.`);
  return {
    label: connectorLabel(server),
    reference: server.connector,
    connector,
    url,
  };
}

/** Every connector server an eval config names: in `servers` and in each variant. */
export function connectorUses(evalConfig: EvalConfig): ConnectorUse[] {
  const seen = new Map<string, ConnectorUse>();
  const lists = [
    evalConfig.servers,
    ...(evalConfig.variants ?? []).map((v) => v.servers),
  ];
  for (const servers of lists)
    for (const server of servers ?? [])
      if (isConnectorServer(server)) {
        const use = connectorUse(server);
        const key = `${use.label}\0${use.reference}\0${use.url}`;
        if (!seen.has(key)) seen.set(key, use);
      }
  return [...seen.values()];
}

/**
 * Expand every connector server into the entry its connector launches. Calls
 * each connector's `launch` with the path its token file will have; writes
 * nothing.
 */
export async function expandConnectorServers(
  evalConfig: EvalConfig,
  options: {
    tokenDirectory?: string;
    platform?: NodeJS.Platform;
    /** With `simulateWrites`: the private directory proxies record writes in. */
    simulatedWritesDirectory?: string;
  } = {}
): Promise<ConnectorExpansion> {
  const uses = connectorUses(evalConfig);
  if (uses.length === 0)
    return {
      evalConfig,
      uses,
      slots: [],
      grantsByVariant: new Map(),
      simulatedWriteFiles: [],
    };
  const simulatedWriteFiles = new Set<string>();
  const tokenDirectory =
    options.tokenDirectory ??
    join(await realpath(tmpdir()), `${TOKEN_DIRECTORY_PREFIX}${randomUUID()}`);
  const targets = new Map(grantTargets(uses).map((t) => [t.key, t]));
  const slots = new Map<string, CredentialSlot>();
  const slotFor = (use: ConnectorUse): CredentialSlot | undefined => {
    if (use.connector.auth.type === 'none') return undefined;
    const { key } = grantIdentity(use);
    let slot = slots.get(key);
    if (!slot) {
      slot = { target: targets.get(key)!, labels: [], envNames: [] };
      slots.set(key, slot);
    }
    if (!slot.labels.includes(use.label)) slot.labels.push(use.label);
    return slot;
  };

  const grantsByVariant = new Map<string, Set<string>>();
  // The grant each top-level server's label needs, for variants that name servers by label.
  const grantByLabel = new Map<string, string>();
  async function expand(
    server: EvalServerConfig,
    variant: string
  ): Promise<MCPConfig> {
    if (!isConnectorServer(server)) return server;
    const use = connectorUse(server);
    const slot = slotFor(use);
    if (slot) {
      const keys = grantsByVariant.get(variant) ?? new Set<string>();
      keys.add(slot.target.key);
      grantsByVariant.set(variant, keys);
      if (variant === '') grantByLabel.set(use.label, slot.target.key);
    }
    if (use.connector.launch) {
      let tokenFile: string | undefined;
      if (slot) {
        slot.file ??= join(tokenDirectory, `${slot.target.key}.json`);
        tokenFile = slot.file;
      }
      const writesFile = options.simulatedWritesDirectory
        ? join(
            options.simulatedWritesDirectory,
            `${encodeURIComponent(use.label)}.jsonl`
          )
        : undefined;
      const launched = await use.connector.launch({
        url: use.url,
        label: use.label,
        ...(tokenFile ? { tokenFile } : {}),
        platform: options.platform ?? process.platform,
        ...(writesFile ? { simulateWrites: { file: writesFile } } : {}),
      });
      const entry = validateMCPConfig({ ...launched, label: use.label });
      if (writesFile) {
        if (entry.transport === 'stdio' && entry.args?.includes(writesFile))
          simulatedWriteFiles.add(writesFile);
        else
          console.warn(
            `[mst] Connector server "${use.label}" doesn't pass simulateWrites to its dry-run proxy, so its writes get planned-write results.`
          );
      }
      if (
        entry.transport === 'stdio' &&
        entry.minTools === undefined &&
        use.connector.minTools !== undefined
      )
        return { ...entry, minTools: use.connector.minTools };
      return entry;
    }
    const name = envName(use.label);
    if (slot && !slot.envNames.includes(name)) slot.envNames.push(name);
    return {
      transport: 'http',
      label: use.label,
      serverUrl: use.url,
      ...(slot ? { auth: { accessTokenEnv: name } } : {}),
    };
  }

  const expandAll = async (variant: string, servers?: EvalServerConfig[]) =>
    servers === undefined
      ? undefined
      : Promise.all(servers.map((server) => expand(server, variant)));
  const expanded: EvalConfig = {
    ...evalConfig,
    ...(evalConfig.servers
      ? { servers: await expandAll('', evalConfig.servers) }
      : {}),
    ...(evalConfig.variants
      ? {
          variants: await Promise.all(
            evalConfig.variants.map(async (variant) => ({
              ...variant,
              ...(variant.servers
                ? { servers: await expandAll(variant.name, variant.servers) }
                : {}),
            }))
          ),
        }
      : {}),
  };
  // A variant that names servers by label needs only those servers' grants.
  for (const variant of evalConfig.variants ?? []) {
    if (variant.serverLabels === undefined || variant.servers !== undefined)
      continue;
    const keys = new Set<string>();
    for (const label of variant.serverLabels) {
      const key = grantByLabel.get(label);
      if (key) keys.add(key);
    }
    grantsByVariant.set(variant.name, keys);
  }
  return {
    evalConfig: expanded,
    uses,
    slots: [...slots.values()],
    grantsByVariant,
    tokenDirectory,
    simulatedWriteFiles: [...simulatedWriteFiles],
  };
}

/** Credentials delivered for a run. */
export interface ConnectorCredentials {
  /** Run-private env vars for direct HTTP connectors. Contains tokens. */
  env: Record<string, string>;
  /** Every token delivered, for redaction. */
  secrets(): string[];
  /** Stop renewing and delete the token files. Safe to call twice. */
  stop(): Promise<void>;
}

/** Writes a token where a launched connector reads it: `{ version, accessToken }`, mode 0600. */
export async function writeTokenFile(
  file: string,
  token: string
): Promise<void> {
  const temporary = `${file}.${randomUUID()}.tmp`;
  const handle = await open(temporary, 'wx', 0o600);
  try {
    await handle.writeFile(JSON.stringify({ version: 1, accessToken: token }));
  } finally {
    await handle.close();
  }
  await rename(temporary, file);
}

/** Thrown before a run starts when it needs a sign-in it doesn't have. */
export class ConnectorSignInRequiredError extends Error {
  constructor(
    readonly missing: MissingGrantError[],
    configPath?: string
  ) {
    const lines = missing.map((error) => `  ${error.message}`);
    super(
      [
        'The run needs servers it is not signed in to:',
        ...lines,
        `Run: mst auth${configPath ? ` --config ${configPath}` : ''}`,
      ].join('\n')
    );
    this.name = 'ConnectorSignInRequiredError';
  }
}

/**
 * Fetch a fresh token for every grant, deliver it, and keep it fresh until
 * `stop()`. Fails before anything starts if any grant is missing.
 */
export async function startConnectorCredentials(
  expansion: ConnectorExpansion,
  store: CredentialStore,
  options: {
    configPath?: string;
    fetch?: FetchFn;
    now?: () => number;
    renewBeforeMs?: number;
    /** Shortest wait before a renewal (default 30 s). For tests. */
    minRenewDelayMs?: number;
    /** Deliver only what these variants use (by name). Default: every variant. */
    variants?: readonly string[];
    log?: (line: string) => void;
  } = {}
): Promise<ConnectorCredentials> {
  const env: Record<string, string> = {};
  const delivered = new Set<string>();
  const timers = new Set<NodeJS.Timeout>();
  /** Renewals under way: stop() waits for them, so none writes a file after it. */
  const renewing = new Set<Promise<void>>();
  let stopped = false;
  const now = options.now ?? Date.now;
  const renewBefore = options.renewBeforeMs ?? RENEW_BEFORE_MS;
  const minDelay = options.minRenewDelayMs ?? MIN_RENEW_DELAY_MS;
  const log = options.log ?? (() => {});

  const stop = async () => {
    stopped = true;
    for (const timer of timers) clearTimeout(timer);
    timers.clear();
    await Promise.allSettled([...renewing]);
    if (expansion.tokenDirectory)
      await releaseTokenDirectory(expansion.tokenDirectory);
  };

  // A variant without servers of its own uses the config's (key '').
  const ownServers = new Set(
    (expansion.evalConfig.variants ?? [])
      .filter(
        (variant) =>
          variant.servers !== undefined || variant.serverLabels !== undefined
      )
      .map((variant) => variant.name)
  );
  const needed = options.variants
    ? new Set(
        options.variants.flatMap((name) => [
          ...(expansion.grantsByVariant.get(ownServers.has(name) ? name : '') ??
            []),
        ])
      )
    : undefined;
  const slots = needed
    ? expansion.slots.filter((slot) => needed.has(slot.target.key))
    : expansion.slots;
  if (slots.length === 0) return { env, secrets: () => [], stop };

  // Every token first, so a missing sign-in fails before any client starts.
  const tokens = await Promise.allSettled(
    slots.map((slot) =>
      accessToken(slot.target, store, {
        fetch: options.fetch,
        now,
        minValidityMs: renewBefore + minDelay,
      })
    )
  );
  const missing = tokens.flatMap((result) =>
    result.status === 'rejected' && result.reason instanceof MissingGrantError
      ? [result.reason]
      : []
  );
  if (missing.length)
    throw new ConnectorSignInRequiredError(missing, options.configPath);
  const failed = tokens.find((result) => result.status === 'rejected');
  if (failed?.status === 'rejected') throw failed.reason;

  // A fresh private directory at the path the expanded servers name. Not
  // recursive: the random name must not exist yet.
  if (slots.some((slot) => slot.file)) {
    const directory = expansion.tokenDirectory!;
    // Token files from runs that were killed before they could remove them.
    for (const stale of await sweepStaleTokenDirectories(dirname(directory)))
      log(`Removed token files left by an earlier run: ${stale}`);
    await mkdir(directory, { mode: 0o700 });
    // Removed on Ctrl-C, SIGTERM or exit even if stop() is never reached.
    await claimTokenDirectory(directory);
  }

  async function deliver(slot: CredentialSlot, token: string): Promise<void> {
    delivered.add(token);
    if (slot.file) await writeTokenFile(slot.file, token);
    for (const name of slot.envNames) env[name] = token;
  }

  function schedule(slot: CredentialSlot, expiresAt: number | undefined): void {
    // Only a file can carry a renewed token to a running client.
    if (stopped || expiresAt === undefined || !slot.file) return;
    const delay = Math.max(minDelay, expiresAt - renewBefore - now());
    const timer = setTimeout(() => {
      timers.delete(timer);
      const renewal = accessToken(slot.target, store, {
        fetch: options.fetch,
        now,
        force: true,
      })
        .then(async (fresh) => {
          if (stopped) return;
          await deliver(slot, fresh.accessToken);
          log(`${slot.target.name}: renewed the access token.`);
          schedule(slot, fresh.expiresAt);
        })
        .catch(() => {
          if (stopped) return;
          log(
            `${slot.target.name}: renewing the access token failed; retrying.`
          );
          // Try again shortly; a token that expires meanwhile fails its trials.
          schedule(
            slot,
            now() + renewBefore + Math.max(minDelay, RENEW_RETRY_MS)
          );
        })
        .finally(() => renewing.delete(renewal));
      renewing.add(renewal);
    }, delay);
    timer.unref();
    timers.add(timer);
  }

  try {
    for (const [index, slot] of slots.entries()) {
      const token = (
        tokens[index] as PromiseFulfilledResult<{
          accessToken: string;
          expiresAt?: number;
        }>
      ).value;
      await deliver(slot, token.accessToken);
      schedule(slot, token.expiresAt);
    }
  } catch (error) {
    await stop();
    throw error;
  }
  return { env, secrets: () => [...delivered], stop };
}

/**
 * Connector servers as a shard's worker gets them (ADR 0004), by label: the
 * declaration, not the entry it expands to on this machine, whose paths only
 * this machine has. The worker expands them itself
 * ({@link expandWorkerConnectors}).
 */
export function connectorDeclarations(
  expansion: ConnectorExpansion
): Map<string, ConnectorServerConfig> {
  return new Map(
    expansion.uses.map((use) => [
      use.label,
      { connector: use.reference, label: use.label, url: use.url },
    ])
  );
}

/** A worker's access token for one server. */
export interface WorkerToken {
  accessToken: string;
  /** Epoch milliseconds. */
  expiresAt?: number;
}

/**
 * Fresh access tokens by server label, for the workers that ask for them
 * (`need-tokens`). Refresh grants stay on this machine. A grant that several
 * shards ask for at once is refreshed once.
 */
export function connectorTokenSource(
  expansion: ConnectorExpansion,
  store: CredentialStore,
  options: {
    fetch?: FetchFn;
    now?: () => number;
    renewBeforeMs?: number;
    minRenewDelayMs?: number;
  } = {}
): {
  /** The labels whose servers need a token. */
  labels: string[];
  tokens(labels: readonly string[]): Promise<Record<string, WorkerToken>>;
} {
  const byLabel = new Map<string, CredentialSlot>();
  for (const slot of expansion.slots)
    for (const label of slot.labels) byLabel.set(label, slot);
  const minValidityMs =
    (options.renewBeforeMs ?? RENEW_BEFORE_MS) +
    (options.minRenewDelayMs ?? MIN_RENEW_DELAY_MS);
  const pending = new Map<string, Promise<WorkerToken>>();
  const tokenFor = (slot: CredentialSlot): Promise<WorkerToken> => {
    const key = slot.target.key;
    let token = pending.get(key);
    if (!token) {
      token = accessToken(slot.target, store, {
        fetch: options.fetch,
        now: options.now,
        minValidityMs,
      }).finally(() => pending.delete(key));
      pending.set(key, token);
    }
    return token;
  };
  return {
    labels: [...byLabel.keys()],
    async tokens(labels) {
      const tokens: Record<string, WorkerToken> = {};
      for (const label of labels) {
        const slot = byLabel.get(label);
        if (!slot) continue;
        const { accessToken: token, expiresAt } = await tokenFor(slot);
        tokens[label] = {
          accessToken: token,
          ...(expiresAt !== undefined ? { expiresAt } : {}),
        };
      }
      return tokens;
    },
  };
}

/** A worker's connector servers, expanded on its own machine. */
export interface WorkerConnectors {
  /** The entry each connector server launches, by label. */
  servers: Map<string, MCPConfig>;
  /** Where each label's token goes: a launched connector's file, or env vars. */
  deliveries: Map<string, { file?: string; envNames: string[] }>;
  /** Where the dry-run proxies record simulated writes. */
  simulatedWriteFiles: string[];
}

/**
 * Expands the connector servers a shard was given, with this machine's
 * paths: token files in `tokenDirectory`, simulated writes in
 * `simulatedWritesDirectory`. Writes nothing; the tokens arrive later.
 */
export async function expandWorkerConnectors(
  declarations: readonly ConnectorServerConfig[],
  options: { tokenDirectory: string; simulatedWritesDirectory?: string }
): Promise<WorkerConnectors> {
  const expansion = await expandConnectorServers(
    {
      name: 'shard',
      datasets: [],
      servers: [...declarations],
    } as EvalConfig,
    options
  );
  const servers = new Map<string, MCPConfig>();
  for (const server of (expansion.evalConfig.servers ?? []) as MCPConfig[])
    servers.set(server.label!, server);
  const deliveries = new Map<string, { file?: string; envNames: string[] }>();
  for (const slot of expansion.slots)
    for (const label of slot.labels)
      deliveries.set(label, {
        ...(slot.file ? { file: slot.file } : {}),
        envNames: slot.envNames,
      });
  return {
    servers,
    deliveries,
    simulatedWriteFiles: expansion.simulatedWriteFiles,
  };
}
