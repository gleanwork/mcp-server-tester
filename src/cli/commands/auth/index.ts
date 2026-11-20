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
  MissingGrantError,
  revokeGrant,
  signIn,
  accessToken,
  type GrantTarget,
} from '../../../auth/grants/grants.js';
import {
  grantTargets,
  type ConnectorUse,
} from '../../../auth/grants/connectors.js';
import { credentialStoreFor } from '../../../auth/grants/stores.js';
import type { CredentialStore } from '../../../auth/grants/types.js';
import { loadEvalConfig } from '../../../evals/evalConfig.js';
import { resolveConfigExtends } from '../../../evals/configExtends.js';
import { loadEvalPlugins } from '../../../evals/evalPlugins.js';
import { connectorUses } from '../../../evals/connectorServers.js';
import {
  closeMCPClient,
  createMCPClientForConfig,
} from '../../../mcp/clientFactory.js';
import {
  classifyMCPConnectionFailure,
  formatMCPConnectionFailure,
  MCPHttpConnectionError,
} from '../../../mcp/connectionDiagnostics.js';

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
  // A plugin's store resolves now that the eval's plugins are loaded.
  const store = credentialStoreFor(options.store, evalConfig.settings);
  return { targets: grantTargets(uses), store, print };
}

function labels(target: Target): string {
  return target.servers.map((server) => server.label).join(', ');
}

function pad(text: string, width: number): string {
  return text.length >= width ? text : text + ' '.repeat(width - text.length);
}

/** `rejected` can be fixed by signing in again. `unverified` keeps the grant. */
type Verification =
  | { outcome: 'ok' }
  | { outcome: 'rejected'; problem: string }
  | { outcome: 'unverified'; problem: string };

function refused(label: string, error: unknown): Verification {
  const statuses =
    error instanceof MCPHttpConnectionError
      ? [error.streamableHttpFailure, error.sseFailure]
      : [classifyMCPConnectionFailure(error)];
  const problem = `${label}: ${formatMCPConnectionFailure(error)}`;
  return statuses.includes('http_401')
    ? { outcome: 'rejected', problem }
    : { outcome: 'unverified', problem };
}

/**
 * Connect once with a fresh token and list tools, so an under-scoped or
 * unapproved sign-in fails now rather than in the middle of a run.
 */
async function verify(
  target: Target,
  store: CredentialStore
): Promise<Verification> {
  let token: string;
  try {
    token = (await accessToken(target, store)).accessToken;
  } catch (error) {
    return error instanceof MissingGrantError
      ? { outcome: 'rejected', problem: error.message }
      : refused(target.name, error);
  }
  for (const server of target.servers) {
    let client: Awaited<ReturnType<typeof createMCPClientForConfig>>;
    try {
      client = await createMCPClientForConfig({
        transport: 'http',
        serverUrl: server.url,
        auth: { accessToken: token },
        connectTimeoutMs: 30_000,
        ...(server.connector.headers
          ? { headers: { ...server.connector.headers } }
          : {}),
      });
    } catch (error) {
      return refused(server.label, error);
    }
    try {
      const { tools } = await client.listTools();
      const min = server.connector.minTools ?? 1;
      if (tools.length < min)
        return {
          outcome: 'unverified',
          problem: `${server.label}: ${tools.length} tools, expected at least ${min} (missing scopes or approval?)`,
        };
    } catch (error) {
      return refused(server.label, error);
    } finally {
      await closeMCPClient(client);
    }
  }
  return { outcome: 'ok' };
}

function printNotes(target: Target, print: (line: string) => void): void {
  const notes = target.servers.find((server) => server.connector.notes)
    ?.connector.notes;
  if (notes) print(`    ${notes}`);
}

/** `mst auth`: sign in where there is no grant, or the server rejected it. */
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
  const unverified: string[] = [];
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
      const check = await verify(target, store);
      if (check.outcome === 'ok') {
        print(
          `${name}  ✓ valid${target.servers.length > 1 ? ` (one ${target.name} grant)` : ''}`
        );
        continue;
      }
      if (check.outcome === 'unverified') {
        unverified.push(target.name);
        print(`${name}  ! ${check.problem}; keeping the saved grant`);
        printNotes(target, print);
        continue;
      }
      print(`${name}  ! ${check.problem}; signing in again`);
    }
    try {
      await signIn(target, store, { print, openUrl });
      const check = await verify(target, store);
      if (check.outcome === 'ok') print(`${name}  ✓ signed in`);
      else {
        failed.push(target.name);
        print(`${name}  ✗ signed in, but ${check.problem}`);
        printNotes(target, print);
      }
    } catch (error) {
      failed.push(target.name);
      print(`${name}  ✗ ${(error as Error).message}`);
      printNotes(target, print);
    }
  }
  print(`Grants: ${store.describe()}`);
  const problems: string[] = [];
  if (failed.length) problems.push(`Sign-in failed for ${failed.join(', ')}.`);
  if (unverified.length)
    problems.push(
      `Could not verify ${unverified.join(', ')}; the saved grant was kept. Run with --force to sign in again.`
    );
  if (problems.length) throw new Error(problems.join(' '));
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
