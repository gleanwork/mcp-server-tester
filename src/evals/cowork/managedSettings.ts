import type { MCPConfig } from '../../config/mcpConfig.js';
import {
  coworkBlockedMcpEntries,
  coworkPluginMarketplace,
  HostPluginError,
  hostStdioServers,
  resolveHostStdioServer,
  type HostPlugin,
  type HostStdioPaths,
} from '../hostPlugins.js';

/**
 * The Cowork managed-settings contract for plugins and stdio eval servers
 * (docs/cowork.md, "Host plugins"). Pure and token-free: exported so callers
 * that write `/etc/claude-desktop/managed-settings.json` can build the same
 * entries MST checks.
 */
export interface CoworkManagedStdioServer {
  name: string;
  transport: 'stdio';
  command: string;
  args: string[];
  env: Record<string, string>;
  toolPolicy?: { '*': 'allow' };
}
export interface CoworkManagedPluginSettings {
  /** Stdio eval servers, then blocked plugin servers. Append HTTP entries. */
  managedMcpServers: Array<
    | CoworkManagedStdioServer
    | { name: string; transport: 'policy-only'; toolPolicy: { '*': 'blocked' } }
  >;
  /** One entry per stdio eval server. Append HTTP server names. */
  allowedMcpServers: Array<{ serverName: string }>;
  /** Present only with plugins. */
  allowedPluginMarketplaces?: ReturnType<typeof coworkPluginMarketplace>[];
}

export function coworkManagedPluginSettings(options: {
  servers: readonly MCPConfig[];
  plugins?: readonly HostPlugin[];
  paths?: HostStdioPaths;
  approveWriteTools?: boolean;
}): CoworkManagedPluginSettings {
  const plugins = options.plugins ?? [];
  const stdio = hostStdioServers(options.servers, plugins).map(
    (server): CoworkManagedStdioServer => {
      const launch = resolveHostStdioServer(server, options.paths ?? {});
      return {
        name: server.label,
        transport: 'stdio',
        command: launch.command,
        args: launch.args,
        env: launch.env,
        ...(options.approveWriteTools
          ? { toolPolicy: { '*': 'allow' as const } }
          : {}),
      };
    }
  );
  const blocked = coworkBlockedMcpEntries(plugins);
  // A blocked name must never shadow an eval server.
  const labels = new Set(
    options.servers.map(
      (server, index) => server.label ?? `server-${index + 1}`
    )
  );
  const clash = blocked.find((entry) => labels.has(entry.name));
  if (clash) throw new HostPluginError('mcp_server_invalid', clash.name);
  return {
    managedMcpServers: [...stdio, ...blocked],
    allowedMcpServers: stdio.map((server) => ({ serverName: server.name })),
    ...(plugins.length
      ? { allowedPluginMarketplaces: plugins.map(coworkPluginMarketplace) }
      : {}),
  };
}

/**
 * Caller contract for Linux Cowork plugins: managed settings contain exactly
 * `coworkPluginMarketplace(plugin)` for each configured plugin (extra keys such
 * as `expectedName` are allowed). With no plugins, the key must be absent or
 * empty. Read-only; exported so callers can check what they generate.
 */
export function coworkPluginSettingsMatch(
  settings: Record<string, unknown>,
  plugins: readonly HostPlugin[]
): boolean {
  const actual = settings.allowedPluginMarketplaces;
  if (actual === undefined) return plugins.length === 0;
  if (!Array.isArray(actual) || actual.length !== plugins.length) return false;
  const remaining: unknown[] = [...(actual as unknown[])];
  for (const plugin of plugins) {
    let expected: Record<string, unknown>;
    try {
      expected = coworkPluginMarketplace(plugin);
    } catch {
      return false;
    }
    // Desktop compares GitHub repos case-insensitively.
    const normalize = (entry: unknown): Record<string, unknown> | undefined =>
      entry && typeof entry === 'object'
        ? {
            ...(entry as Record<string, unknown>),
            ...(typeof (entry as { repo?: unknown }).repo === 'string'
              ? { repo: (entry as { repo: string }).repo.toLowerCase() }
              : {}),
          }
        : undefined;
    const index = remaining.findIndex((entry) => {
      const observed = normalize(entry);
      return (
        !!observed &&
        Object.entries(expected).every(
          ([key, value]) => observed[key] === value
        )
      );
    });
    if (index < 0) return false;
    remaining.splice(index, 1);
  }
  return true;
}

function equal(a: unknown, b: unknown): boolean {
  if (Array.isArray(a) || Array.isArray(b))
    return (
      Array.isArray(a) &&
      Array.isArray(b) &&
      a.length === b.length &&
      a.every((value, index) => equal(value, b[index]))
    );
  if (a && b && typeof a === 'object' && typeof b === 'object') {
    const keys = Object.keys(a);
    return (
      keys.length === Object.keys(b).length &&
      keys.every(
        (key) =>
          Object.hasOwn(b, key) &&
          equal(
            (a as Record<string, unknown>)[key],
            (b as Record<string, unknown>)[key]
          )
      )
    );
  }
  return a === b;
}
export { equal as coworkJsonEqual };

type Managed = {
  name?: unknown;
  transport?: unknown;
  url?: unknown;
  toolPolicy?: Record<string, unknown>;
} & Record<string, unknown>;

/**
 * Check `managedMcpServers`, `allowedMcpServers`, and
 * `allowManagedMcpServersOnly` against the manifest servers and plugins:
 *
 * - HTTP servers: `{name: label, transport: "http", url}` as before.
 * - Stdio eval servers: exactly `coworkManagedPluginSettings(...)` entries
 *   (resolved command/args/env; only `toolPolicy` may be added) and listed
 *   in `allowedMcpServers`.
 * - Every `blockMcpServers` name as a `policy-only` `{"*": "blocked"}` entry.
 *   Other `policy-only` entries must also block everything.
 * - `toolPolicy: {"*": "allow"}` only with `approveWriteTools`.
 */
export function coworkMcpSettingsMatch(
  settings: Record<string, unknown>,
  options: {
    servers: readonly MCPConfig[];
    plugins?: readonly HostPlugin[];
    paths?: HostStdioPaths;
    approveWriteTools?: boolean;
  }
): boolean {
  let expected: CoworkManagedPluginSettings;
  try {
    expected = coworkManagedPluginSettings({
      ...options,
      approveWriteTools: false,
    });
  } catch {
    return false;
  }
  const managed = settings.managedMcpServers as Managed[] | undefined;
  if (
    !Array.isArray(managed) ||
    settings.allowManagedMcpServersOnly !== true ||
    managed.some((entry) => !entry || typeof entry !== 'object')
  )
    return false;
  const policies = managed.filter((s) => s.transport === 'policy-only');
  if (
    policies.some(
      (s) =>
        Object.keys(s.toolPolicy ?? {}).join() !== '*' ||
        s.toolPolicy?.['*'] !== 'blocked'
    )
  )
    return false;
  const blocked = expected.managedMcpServers.filter(
    (s) => s.transport === 'policy-only'
  );
  if (
    blocked.some(
      (entry) =>
        !policies.some(
          (s) =>
            s.name === entry.name &&
            Object.keys(s).every((key) =>
              ['name', 'transport', 'toolPolicy'].includes(key)
            )
        )
    )
  )
    return false;
  const actual = managed.filter((s) => s.transport !== 'policy-only');
  const http = options.servers.filter((s) => s.transport !== 'stdio');
  const stdio = expected.managedMcpServers.filter(
    (s): s is CoworkManagedStdioServer => s.transport === 'stdio'
  );
  if (actual.length !== http.length + stdio.length) return false;
  const names = actual.map((s) => s.name);
  if (new Set(names).size !== names.length) return false;
  const allowPolicy = (entry: Managed) =>
    entry.toolPolicy?.['*'] !== 'allow' || options.approveWriteTools === true;
  for (const [index, server] of options.servers.entries()) {
    if (server.transport !== 'http') continue;
    const observed = actual.find(
      (s) => s.name === (server.label ?? `server-${index + 1}`)
    );
    if (
      !observed ||
      observed.transport !== 'http' ||
      observed.url !== server.serverUrl ||
      !allowPolicy(observed)
    )
      return false;
  }
  const allowed = settings.allowedMcpServers;
  for (const entry of stdio) {
    const observed = actual.find((s) => s.name === entry.name);
    if (
      !observed ||
      Object.keys(observed).some(
        (key) =>
          ![
            'name',
            'transport',
            'command',
            'args',
            'env',
            'toolPolicy',
          ].includes(key)
      ) ||
      observed.transport !== 'stdio' ||
      observed.command !== entry.command ||
      !equal(observed.args ?? [], entry.args) ||
      !equal(observed.env ?? {}, entry.env) ||
      (observed.toolPolicy !== undefined &&
        !equal(observed.toolPolicy, { '*': 'allow' })) ||
      !allowPolicy(observed) ||
      !Array.isArray(allowed) ||
      !allowed.some(
        (item) =>
          !!item &&
          typeof item === 'object' &&
          (item as { serverName?: unknown }).serverName === entry.name
      )
    )
      return false;
  }
  return true;
}
