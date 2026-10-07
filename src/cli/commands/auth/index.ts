/**
 * `mst auth`: sign in once to every connector server an eval config uses.
 *
 *   mst auth --config <file> [--server <label>...] [--force]
 *   mst auth status --config <file>
 *   mst auth revoke --config <file> --server <label>...
 */
import path from 'node:path';
import {
  grantState,
  revokeGrant,
  signIn,
  accessToken,
  type GrantTarget,
} from '../../../auth/grants/grants.js';
import {
  grantTargets,
  type ConnectorUse,
} from '../../../auth/grants/connectors.js';
import {
  defaultGrantsDirectory,
  localCredentialStore,
} from '../../../auth/grants/localStore.js';
import type { CredentialStore } from '../../../auth/grants/types.js';
import { loadEvalConfig } from '../../../evals/evalConfig.js';
import { resolveConfigExtends } from '../../../evals/configExtends.js';
import { loadEvalPlugins } from '../../../evals/evalPlugins.js';
import { connectorUses } from '../../../evals/connectorServers.js';
import {
  closeMCPClient,
  createMCPClientForConfig,
} from '../../../mcp/clientFactory.js';

export interface AuthOptions {
  config: string;
  plugins?: string[];
  rootDir?: string;
  server?: string[];
  force?: boolean;
  /** A credential store directory (default ~/.mcp-server-tester/grants). */
  store?: string;
}

type Target = GrantTarget & { servers: ConnectorUse[] };

interface AuthContext {
  targets: Target[];
  store: CredentialStore;
  print: (line: string) => void;
}

async function context(
  options: AuthOptions,
  print: (line: string) => void
): Promise<AuthContext> {
  const rootDir = path.resolve(options.rootDir ?? '.');
  const loaded = loadEvalConfig(options.config, {
    rootDir,
    skipDatasetValidation: true,
  });
  const namespaces = await loadEvalPlugins({
    configPath: options.config,
    evalConfig: loaded,
    rootDir,
    pluginPaths: options.plugins,
  });
  const evalConfig = resolveConfigExtends(loaded, namespaces);
  let uses = connectorUses(evalConfig);
  if (options.server?.length) {
    const wanted = new Set(options.server);
    const unknown = [...wanted].filter(
      (label) => !uses.some((use) => use.label === label)
    );
    if (unknown.length)
      throw new Error(
        `No connector server labelled ${unknown.join(', ')} in ${options.config}. Servers: ${uses.map((use) => use.label).join(', ') || 'none'}.`
      );
    uses = uses.filter((use) => wanted.has(use.label));
  }
  const store = localCredentialStore(
    options.store ? path.resolve(options.store) : defaultGrantsDirectory()
  );
  return { targets: grantTargets(uses), store, print };
}

function labels(target: Target): string {
  return target.servers.map((server) => server.label).join(', ');
}

function pad(text: string, width: number): string {
  return text.length >= width ? text : text + ' '.repeat(width - text.length);
}

/**
 * Connect once with a fresh token and list tools, so an under-scoped or
 * unapproved sign-in fails now rather than in the middle of a run.
 */
async function verify(
  target: Target,
  store: CredentialStore
): Promise<string | undefined> {
  const { accessToken: token } = await accessToken(target, store);
  for (const server of target.servers) {
    const client = await createMCPClientForConfig({
      transport: 'http',
      serverUrl: server.url,
      auth: { accessToken: token },
      connectTimeoutMs: 30_000,
    }).catch(() => undefined);
    if (!client) return `${server.label}: cannot connect with the new token`;
    try {
      const { tools } = await client.listTools();
      const min = server.connector.minTools ?? 1;
      if (tools.length < min)
        return `${server.label}: ${tools.length} tools, expected at least ${min} (missing scopes or approval?)`;
    } finally {
      await closeMCPClient(client);
    }
  }
  return undefined;
}

/** `mst auth`: sign in to every grant that has none (or all, with --force). */
export async function auth(
  options: AuthOptions,
  io: {
    print?: (line: string) => void;
    openUrl?: (url: string) => Promise<void>;
  } = {}
): Promise<void> {
  const print = io.print ?? ((line: string) => console.log(line));
  const openUrl =
    io.openUrl ??
    (async (url: string) => {
      const { default: open } = await import('open');
      await open(url);
    });
  const { targets, store } = await context(options, print);
  if (targets.length === 0) {
    print(`${options.config} uses no connector servers.`);
    return;
  }
  const width = Math.max(...targets.map((target) => labels(target).length));
  const failed: string[] = [];
  for (const target of targets) {
    const name = pad(labels(target), width);
    const state = await grantState(target, store);
    if (state.state === 'none') {
      print(`${name}  – no auth`);
      continue;
    }
    if (state.state === 'plugin') {
      try {
        await accessToken(target, store);
        print(`${name}  ✓ ${target.auth.type} (from the plugin)`);
      } catch (error) {
        failed.push(target.name);
        print(`${name}  ✗ ${(error as Error).message}`);
      }
      continue;
    }
    if (state.state === 'valid' && !options.force) {
      const problem = await verify(target, store).catch(
        (error: unknown) => (error as Error).message
      );
      if (!problem) {
        print(
          `${name}  ✓ valid${target.servers.length > 1 ? ` (one ${target.name} grant)` : ''}`
        );
        continue;
      }
      print(`${name}  ! ${problem}; signing in again`);
    }
    try {
      await signIn(target, store, { print, openUrl });
      const problem = await verify(target, store);
      if (problem) {
        failed.push(target.name);
        print(`${name}  ✗ signed in, but ${problem}`);
        const notes = target.servers.find((s) => s.connector.notes)?.connector
          .notes;
        if (notes) print(`    ${notes}`);
      } else print(`${name}  ✓ signed in`);
    } catch (error) {
      failed.push(target.name);
      print(`${name}  ✗ ${(error as Error).message}`);
      const notes = target.servers.find((s) => s.connector.notes)?.connector
        .notes;
      if (notes) print(`    ${notes}`);
    }
  }
  print(`Grants: ${store.describe()}`);
  if (failed.length)
    throw new Error(`Sign-in failed for ${failed.join(', ')}.`);
}

/** `mst auth status`: what is signed in. Exits non-zero when anything is missing. */
export async function authStatus(
  options: AuthOptions,
  io: { print?: (line: string) => void } = {}
): Promise<void> {
  const print = io.print ?? ((line: string) => console.log(line));
  const { targets, store } = await context(options, print);
  const width = Math.max(0, ...targets.map((target) => labels(target).length));
  const missing: string[] = [];
  for (const target of targets) {
    const name = pad(labels(target), width);
    const state = await grantState(target, store);
    switch (state.state) {
      case 'none':
        print(`${name}  – no auth`);
        break;
      case 'plugin':
        print(`${name}  ✓ ${target.auth.type} (from the plugin)`);
        break;
      case 'missing':
        missing.push(...target.servers.map((server) => server.label));
        print(`${name}  ✗ not signed in`);
        break;
      case 'valid':
        print(
          `${name}  ✓ ${state.refreshable ? 'refreshable' : 'long-lived token'} · signed in ${state.grant.signedInAt.slice(0, 10)}`
        );
        break;
    }
  }
  if (missing.length)
    throw new Error(
      `Not signed in: ${missing.join(', ')}. Run: mst auth --config ${options.config}`
    );
}

/** `mst auth revoke`: revoke and delete grants. */
export async function authRevoke(
  options: AuthOptions,
  io: { print?: (line: string) => void } = {}
): Promise<void> {
  const print = io.print ?? ((line: string) => console.log(line));
  if (!options.server?.length)
    throw new Error('Name the servers to revoke: --server <label>...');
  const { targets, store } = await context(options, print);
  for (const target of targets) {
    const removed = await revokeGrant(target, store);
    print(
      `${labels(target)}  ${removed ? `✓ revoked ${target.name}` : '– not signed in'}`
    );
  }
}
