import { constants } from 'node:fs';
import { lstat, mkdir, open } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { z } from 'zod';
import type { MCPConfig } from '../config/mcpConfig.js';

/**
 * Host plugins and host-resolved stdio eval servers: caller-supplied,
 * host-neutral declarations. MST has no plugin-specific code.
 *
 * - `plugins[]` installs a plugin (skills) from a pinned marketplace. On
 *   ChatGPT, `plugins[].mcp` can also point a plugin's own server at an eval
 *   endpoint. On Cowork, `plugins[].blockMcpServers` blocks the plugin's own
 *   servers instead.
 * - A stdio `servers[]` entry with `url` is an eval server that a host resolves
 *   (`${url}`, `${dataDir}`, `${pluginRoot:<plugin>}`) and launches under its
 *   own label, e.g. a plugin's adapter pointed at the eval endpoint.
 */

const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
/** MCP server names become host config keys and trace labels. */
const SERVER = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
/** One path segment. No separators, no `.`/`..`, no hidden or odd names. */
const FILE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
/** `${name}` or `${name:argument}`; the argument is a plugin name. */
const PLACEHOLDER = /\$\{([A-Za-z]+(?::[A-Za-z0-9._-]{1,64})?)\}/g;
/** Plugin MCP override placeholders. Any other `${...}` fails validation. */
export const HOST_PLUGIN_PLACEHOLDERS = [
  'url',
  'dataDir',
  'bearerToken',
] as const;
/**
 * Placeholders for a stdio eval server. `${pluginRoot:<plugin>}` resolves to
 * the root of a declared plugin. `${bearerToken}` is allowed only in `files`.
 */
export const HOST_STDIO_PLACEHOLDERS = [
  'url',
  'dataDir',
  'pluginRoot:<plugin>',
  'bearerToken',
] as const;
const MAX_FILE_BYTES = 64 * 1024;

function placeholders(value: string): string[] {
  return [...value.matchAll(PLACEHOLDER)].map((match) => match[1]!);
}
function onlyKnown(
  value: string,
  known: (name: string) => boolean = (name) =>
    (HOST_PLUGIN_PLACEHOLDERS as readonly string[]).includes(name)
): boolean {
  // A stray `${` that is not a well-formed placeholder is also rejected.
  return (
    placeholders(value).every(known) &&
    !value.replace(PLACEHOLDER, '').includes('${')
  );
}
function strings(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap(strings);
  if (value && typeof value === 'object')
    return Object.entries(value).flatMap(([key, entry]) => [
      key,
      ...strings(entry),
    ]);
  return [];
}
const pluginRootName = (placeholder: string) =>
  placeholder.startsWith('pluginRoot:')
    ? placeholder.slice('pluginRoot:'.length)
    : undefined;

const EvalUrlSchema = z
  .string()
  .url()
  .max(2048)
  .refine((value) => {
    const url = new URL(value);
    return (
      !url.username &&
      !url.password &&
      !url.hash &&
      (url.protocol === 'https:' ||
        (url.protocol === 'http:' &&
          ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))
    );
  }, 'Eval MCP URLs must be HTTPS (or loopback HTTP) without credentials.');

/** How MST points one of the plugin's own MCP servers at the eval endpoint. */
export const HostPluginMcpOverrideSchema = z
  .object({
    /** Eval endpoint, substituted as `${url}`. */
    url: EvalUrlSchema,
    /** Same credential plumbing as direct MCP servers; substituted as `${bearerToken}`. */
    auth: z
      .object({ accessTokenEnv: z.string().regex(ENV_NAME) })
      .strict()
      .optional(),
    /** Readiness fails closed below this many tools. */
    minTools: z.number().int().min(1).max(10_000).default(1),
    /** Merged over the plugin's declared env. `${bearerToken}` is not allowed here. */
    env: z
      .record(z.string().regex(ENV_NAME), z.string().max(4096))
      .optional()
      .refine(
        (env) =>
          Object.values(env ?? {}).every(
            (value) =>
              onlyKnown(value) && !placeholders(value).includes('bearerToken')
          ),
        'Plugin env supports only ${url} and ${dataDir}.'
      ),
    /** Private files written in the per-plugin data dir (`${dataDir}`), as JSON. */
    files: z
      .record(z.string().regex(FILE_NAME), z.unknown())
      .optional()
      .refine(
        (files) => strings(files ?? {}).every((value) => onlyKnown(value)),
        'Plugin files support only ${url}, ${dataDir}, and ${bearerToken}.'
      ),
  })
  .strict()
  .superRefine((override, context) => {
    const used = new Set(
      strings([override.env ?? {}, override.files ?? {}]).flatMap(placeholders)
    );
    if (used.has('bearerToken') && !override.auth)
      context.addIssue({
        code: 'custom',
        path: ['auth'],
        message: '${bearerToken} requires auth.accessTokenEnv.',
      });
  });

export const HostPluginSchema = z
  .object({
    name: z.string().regex(NAME),
    marketplace: z
      .object({
        /** owner/repo, HTTPS Git URL, or (ChatGPT only) an absolute local path. */
        source: z.string().min(1).max(512),
        /** Full commit SHA. Required for Git sources so runs are reproducible. */
        ref: z
          .string()
          .regex(/^[0-9a-f]{40}$/)
          .optional(),
      })
      .strict(),
    /** Keyed by the server name in the plugin's `.mcp.json`. */
    mcp: z
      .record(z.string().regex(SERVER), HostPluginMcpOverrideSchema)
      .optional()
      .refine(
        (servers) => Object.keys(servers ?? {}).length <= 8,
        'At most 8 plugin MCP overrides per plugin.'
      ),
    /**
     * The plugin's own MCP server names (from its `.mcp.json`) to block, so the
     * eval cannot call them. Cowork writes `policy-only` blocked entries.
     */
    blockMcpServers: z
      .array(z.string().regex(SERVER))
      .max(8)
      .optional()
      .refine(
        (names) => new Set(names ?? []).size === (names ?? []).length,
        'Duplicate blocked MCP server names.'
      ),
  })
  .strict()
  .refine(
    (plugin) =>
      isAbsolute(plugin.marketplace.source) ||
      plugin.marketplace.ref !== undefined,
    'Git plugin marketplaces require a full commit SHA ref.'
  )
  .refine(
    (plugin) =>
      !(plugin.blockMcpServers ?? []).some((name) =>
        Object.hasOwn(plugin.mcp ?? {}, name)
      ),
    'A plugin MCP server cannot be both overridden and blocked.'
  );

export const HostPluginsSchema = z
  .array(HostPluginSchema)
  .max(16)
  .superRefine((plugins, context) => {
    if (new Set(plugins.map((p) => p.name)).size !== plugins.length)
      context.addIssue({ code: 'custom', message: 'Duplicate plugin names.' });
    const servers = plugins.flatMap((p) => [
      ...Object.keys(p.mcp ?? {}),
      ...(p.blockMcpServers ?? []),
    ]);
    if (new Set(servers).size !== servers.length)
      context.addIssue({
        code: 'custom',
        message: 'Plugin MCP server names must be unique across plugins.',
      });
  });

/** Caller input. Helpers parse it, so defaults such as `minTools` apply. */
export type HostPlugin = z.input<typeof HostPluginSchema>;
export type HostPluginMcpOverride = z.output<
  typeof HostPluginMcpOverrideSchema
>;

/** A plugin MCP server that MST treats as an eval MCP server. */
export interface HostPluginMcpServer {
  plugin: string;
  /** The plugin's own server name; also the native label on ChatGPT. */
  server: string;
  override: HostPluginMcpOverride;
}

export function hostPluginMcpServers(
  plugins: readonly HostPlugin[]
): HostPluginMcpServer[] {
  const parsed = HostPluginsSchema.safeParse(plugins);
  if (!parsed.success) throw new HostPluginError('plugin_invalid', 'config');
  return parsed.data.flatMap((plugin) =>
    Object.entries(plugin.mcp ?? {}).map(([server, override]) => ({
      plugin: plugin.name,
      server,
      override,
    }))
  );
}

/** Resolved credentials, keyed `<plugin>/<server>`. Never logged or receipted. */
export type HostPluginCredentials = Record<string, string>;

export function hostPluginCredentialKey(plugin: string, server: string) {
  return `${plugin}/${server}`;
}

export class HostPluginError extends Error {
  constructor(
    readonly code:
      | 'plugin_invalid'
      | 'plugin_credential_missing'
      | 'plugin_marketplace_failed'
      | 'plugin_install_failed'
      | 'plugin_mcp_invalid'
      | 'plugin_data_unsafe'
      | 'plugin_unsupported'
      | 'mcp_server_invalid'
      | 'mcp_server_unsupported',
    readonly plugin: string
  ) {
    super(
      `Host plugin setup failed (${code}: ${plugin}); no prompt was sent and nothing was retried.`
    );
    this.name = 'HostPluginError';
  }
}

/**
 * Resolve each `auth.accessTokenEnv` from the same merged environment that
 * direct MCP credentials use. Missing or multi-line values fail closed.
 */
export function resolveHostPluginCredentials(
  plugins: readonly HostPlugin[],
  env: Record<string, string | undefined>
): HostPluginCredentials {
  const credentials: HostPluginCredentials = {};
  for (const { plugin, server, override } of hostPluginMcpServers(plugins)) {
    const name = override.auth?.accessTokenEnv;
    if (!name) continue;
    const token = Object.hasOwn(env, name) ? env[name] : undefined;
    if (!token || /[\s\0]/.test(token))
      throw new HostPluginError('plugin_credential_missing', plugin);
    credentials[hostPluginCredentialKey(plugin, server)] = token;
  }
  return credentials;
}

function substitute(value: string, values: Record<string, string>): string {
  return value.replace(PLACEHOLDER, (_all, name: string) => {
    if (!Object.hasOwn(values, name)) throw new Error('placeholder');
    return values[name]!;
  });
}
function substituteJson(
  value: unknown,
  values: Record<string, string>
): unknown {
  if (typeof value === 'string') return substitute(value, values);
  if (Array.isArray(value)) return value.map((v) => substituteJson(v, values));
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [
        substitute(k, values),
        substituteJson(v, values),
      ])
    );
  return value;
}

/**
 * Create `<dataRoot>/<segments...>` (each 0700, owned by us, no symlinks) and
 * write each file (0600, exclusive, O_NOFOLLOW). Returns the data dir.
 */
async function writePrivateFiles(options: {
  dataRoot: string;
  segments: string[];
  files: Record<string, unknown>;
  owner: string;
  code: 'plugin_data_unsafe';
}): Promise<string> {
  const paths = options.segments.reduce<string[]>(
    (all, segment) => [...all, join(all.at(-1)!, segment)],
    [options.dataRoot]
  );
  const dataDir = paths.at(-1)!;
  try {
    for (const path of paths) {
      await mkdir(path, { mode: 0o700 }).catch((error: unknown) => {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      });
      const info = await lstat(path);
      if (
        !info.isDirectory() ||
        info.isSymbolicLink() ||
        info.uid !== process.getuid?.() ||
        (info.mode & 0o077) !== 0
      )
        throw new Error('unsafe');
    }
  } catch {
    throw new HostPluginError(options.code, options.owner);
  }
  for (const [name, content] of Object.entries(options.files)) {
    const bytes = Buffer.from(JSON.stringify(content), 'utf8');
    if (bytes.length > MAX_FILE_BYTES)
      throw new HostPluginError('plugin_invalid', options.owner);
    let handle;
    try {
      handle = await open(
        join(dataDir, name),
        constants.O_WRONLY |
          constants.O_CREAT |
          constants.O_EXCL |
          constants.O_NOFOLLOW,
        0o600
      );
      await handle.writeFile(bytes);
    } catch {
      throw new HostPluginError(options.code, options.owner);
    } finally {
      await handle?.close();
    }
  }
  return dataDir;
}

/**
 * Apply one override: create the private data dir `<dataRoot>/<plugin>/<server>`
 * (0700, no symlinks), write its files (0600, exclusive, O_NOFOLLOW), and return
 * the substituted env. The data root must already exist and be owned by us.
 */
export async function materializeHostPluginMcp(options: {
  dataRoot: string;
  server: HostPluginMcpServer;
  credentials: HostPluginCredentials;
}): Promise<{ env: Record<string, string>; dataDir: string }> {
  const { plugin, server, override } = options.server;
  const token = override.auth
    ? options.credentials[hostPluginCredentialKey(plugin, server)]
    : '';
  if (token === undefined)
    throw new HostPluginError('plugin_credential_missing', plugin);
  const dataDir = join(options.dataRoot, plugin, server);
  const values = { url: override.url, dataDir, bearerToken: token };
  await writePrivateFiles({
    dataRoot: options.dataRoot,
    segments: [plugin, server],
    files: Object.fromEntries(
      Object.entries(override.files ?? {}).map(([name, content]) => [
        name,
        substituteJson(content, values),
      ])
    ),
    owner: plugin,
    code: 'plugin_data_unsafe',
  });
  const env = Object.fromEntries(
    Object.entries(override.env ?? {}).map(([k, v]) => [
      k,
      substitute(v, values),
    ])
  );
  return { env, dataDir };
}

// ---------------------------------------------------------------------------
// Host-resolved stdio eval servers (`servers[]` entries with `url`).
// ---------------------------------------------------------------------------

const stdioKnown = (name: string) =>
  name === 'url' ||
  name === 'dataDir' ||
  (pluginRootName(name) !== undefined && NAME.test(pluginRootName(name)!));

/** Strict shape of a stdio eval server. Unknown keys (including `cwd`) fail. */
const HostStdioServerSchema = z
  .object({
    transport: z.literal('stdio'),
    label: z.string().regex(SERVER),
    command: z.string().min(1).max(4096),
    args: z.array(z.string().max(4096)).max(64).optional(),
    env: z.record(z.string().regex(ENV_NAME), z.string().max(4096)).optional(),
    /** The eval endpoint; substituted as `${url}` and recorded for receipts. */
    url: EvalUrlSchema,
    auth: z
      .object({ accessTokenEnv: z.string().regex(ENV_NAME) })
      .strict()
      .optional(),
    minTools: z.number().int().min(1).max(10_000).default(1),
    files: z.record(z.string().regex(FILE_NAME), z.unknown()).optional(),
    // Client-only options for MST's own readiness connection.
    connectTimeoutMs: z.number().positive().optional(),
    requestTimeoutMs: z.number().positive().optional(),
    callTimeoutMs: z.number().positive().optional(),
    quiet: z.boolean().optional(),
  })
  .strict()
  .superRefine((server, context) => {
    const launch = [server.command, ...(server.args ?? [])];
    const env = Object.values(server.env ?? {});
    if (![...launch, ...env].every((value) => onlyKnown(value, stdioKnown)))
      context.addIssue({
        code: 'custom',
        message:
          'command, args, and env support only ${url}, ${dataDir}, and ${pluginRoot:<plugin>}.',
      });
    const fileStrings = strings(server.files ?? {});
    if (
      !fileStrings.every((value) =>
        onlyKnown(value, (name) => name === 'bearerToken' || stdioKnown(name))
      )
    )
      context.addIssue({
        code: 'custom',
        path: ['files'],
        message:
          'files support only ${url}, ${dataDir}, ${pluginRoot:<plugin>}, and ${bearerToken}.',
      });
    if (
      fileStrings.flatMap(placeholders).includes('bearerToken') &&
      !server.auth
    )
      context.addIssue({
        code: 'custom',
        path: ['auth'],
        message: '${bearerToken} requires auth.accessTokenEnv.',
      });
    // The host verifies the endpoint it launches; it must appear in the launch.
    if (
      ![...launch, ...env].some((value) => placeholders(value).includes('url'))
    )
      context.addIssue({
        code: 'custom',
        message: '${url} must appear in args or env.',
      });
    if (Object.keys(server.files ?? {}).length > 8)
      context.addIssue({ code: 'custom', message: 'At most 8 files.' });
  });

export type HostStdioServer = z.output<typeof HostStdioServerSchema> & {
  /** Plugin names referenced as `${pluginRoot:<plugin>}`. */
  pluginRoots: string[];
  /** True when `${dataDir}` or `files` are used. */
  usesDataDir: boolean;
};

/** Host-provided runtime paths used to resolve stdio eval servers. */
export interface HostStdioPaths {
  /** Absolute plugin root per plugin name, for `${pluginRoot:<plugin>}`. */
  pluginRoots?: Record<string, string>;
  /** Absolute private root; each server's `${dataDir}` is `<dataRoot>/<label>`. */
  dataRoot?: string;
}

/**
 * Parse every stdio `servers[]` entry as a host-resolved eval server. Each must
 * declare `url` and reference only declared plugins. Fails closed.
 */
export function hostStdioServers(
  servers: readonly MCPConfig[],
  plugins: readonly HostPlugin[] = []
): HostStdioServer[] {
  const names = new Set(plugins.map((plugin) => plugin.name));
  const labels = new Set<string>();
  return servers.flatMap((server): HostStdioServer[] => {
    if (server.transport !== 'stdio') return [];
    const parsed = HostStdioServerSchema.safeParse(server);
    if (!parsed.success || labels.has(parsed.data.label))
      throw new HostPluginError('mcp_server_invalid', server.label ?? 'stdio');
    labels.add(parsed.data.label);
    const all = strings([
      parsed.data.command,
      parsed.data.args ?? [],
      parsed.data.env ?? {},
      parsed.data.files ?? {},
    ]).flatMap(placeholders);
    const roots = [
      ...new Set(all.flatMap((name) => pluginRootName(name) ?? [])),
    ];
    if (roots.some((name) => !names.has(name)))
      throw new HostPluginError('mcp_server_invalid', parsed.data.label);
    return [
      {
        ...parsed.data,
        pluginRoots: roots,
        usesDataDir:
          all.includes('dataDir') ||
          Object.keys(parsed.data.files ?? {}).length > 0,
      },
    ];
  });
}

function safeAbsolute(path: string | undefined): path is string {
  return (
    typeof path === 'string' &&
    isAbsolute(path) &&
    resolve(path) === path &&
    path !== '/' &&
    !Array.from(path).some((c) => c.charCodeAt(0) < 32 || c === '\x7f') &&
    !path.includes('${')
  );
}

/** Placeholder values for one server. Never includes a token. */
function stdioValues(
  server: HostStdioServer,
  paths: HostStdioPaths
): Record<string, string> {
  const values: Record<string, string> = { url: server.url };
  if (server.usesDataDir) {
    if (!safeAbsolute(paths.dataRoot))
      throw new HostPluginError('mcp_server_invalid', server.label);
    values.dataDir = join(paths.dataRoot, server.label);
  }
  for (const plugin of server.pluginRoots) {
    const root = paths.pluginRoots?.[plugin];
    if (!safeAbsolute(root))
      throw new HostPluginError('mcp_server_invalid', server.label);
    values[`pluginRoot:${plugin}`] = root;
  }
  return values;
}

/** The resolved launch: exactly what the host must run. Contains no token. */
export function resolveHostStdioServer(
  server: HostStdioServer,
  paths: HostStdioPaths
): {
  command: string;
  args: string[];
  env: Record<string, string>;
  dataDir?: string;
} {
  const values = stdioValues(server, paths);
  return {
    command: substitute(server.command, values),
    args: (server.args ?? []).map((arg) => substitute(arg, values)),
    env: Object.fromEntries(
      Object.entries(server.env ?? {}).map(([k, v]) => [
        k,
        substitute(v, values),
      ])
    ),
    ...(values.dataDir ? { dataDir: values.dataDir } : {}),
  };
}

/**
 * Expected file contents in `${dataDir}`, with `${bearerToken}` substituted.
 * Contains the credential: never log or receipt the result.
 */
export function hostStdioFileContents(
  server: HostStdioServer,
  paths: HostStdioPaths,
  token: string | undefined
): Record<string, unknown> {
  if (server.auth && !token)
    throw new HostPluginError('plugin_credential_missing', server.label);
  const values = {
    ...stdioValues(server, paths),
    ...(server.auth ? { bearerToken: token! } : {}),
  };
  return Object.fromEntries(
    Object.entries(server.files ?? {}).map(([name, content]) => [
      name,
      substituteJson(content, values),
    ])
  );
}

/** Resolve each stdio server's `auth.accessTokenEnv`, keyed by label. */
export function resolveHostStdioCredentials(
  servers: readonly HostStdioServer[],
  env: Record<string, string | undefined>
): Record<string, string> {
  const credentials: Record<string, string> = {};
  for (const server of servers) {
    const name = server.auth?.accessTokenEnv;
    if (!name) continue;
    const token = Object.hasOwn(env, name) ? env[name] : undefined;
    if (!token || /[\s\0]/.test(token))
      throw new HostPluginError('plugin_credential_missing', server.label);
    credentials[server.label] = token;
  }
  return credentials;
}

/**
 * Write a stdio server's private files: `<dataRoot>` must exist (0700, ours);
 * creates `<dataRoot>/<label>` (0700) and each file (0600, exclusive). For TS
 * callers that prepare a host, and tests. Returns the data dir.
 */
export async function materializeHostStdioFiles(options: {
  server: HostStdioServer;
  paths: HostStdioPaths;
  token?: string;
}): Promise<string | undefined> {
  const { server, paths } = options;
  if (!server.usesDataDir) return undefined;
  const files = hostStdioFileContents(server, paths, options.token);
  const bytes = Buffer.byteLength(JSON.stringify(files));
  if (bytes > MAX_FILE_BYTES * 8)
    throw new HostPluginError('plugin_invalid', server.label);
  return writePrivateFiles({
    dataRoot: paths.dataRoot!,
    segments: [server.label],
    files,
    owner: server.label,
    code: 'plugin_data_unsafe',
  });
}

/**
 * MST's own readiness connection to a resolved stdio eval server. It gets
 * only the declared env (plus the SDK's minimal default), never process.env.
 */
export function hostStdioReadinessConfig(
  server: HostStdioServer,
  paths: HostStdioPaths
): MCPConfig {
  const launch = resolveHostStdioServer(server, paths);
  return {
    transport: 'stdio',
    label: server.label,
    command: launch.command,
    args: launch.args,
    env: launch.env,
    inheritEnv: false,
    minTools: server.minTools,
    ...(server.connectTimeoutMs !== undefined
      ? { connectTimeoutMs: server.connectTimeoutMs }
      : {}),
    ...(server.requestTimeoutMs !== undefined
      ? { requestTimeoutMs: server.requestTimeoutMs }
      : {}),
    ...(server.callTimeoutMs !== undefined
      ? { callTimeoutMs: server.callTimeoutMs }
      : {}),
    quiet: server.quiet ?? true,
  };
}

// ---------------------------------------------------------------------------
// Cowork
// ---------------------------------------------------------------------------

/**
 * Cowork `allowedPluginMarketplaces` entry for one plugin: pinned and
 * `required`, so Desktop installs it on every sync. Cowork cannot read local
 * marketplace paths, so only owner/repo and HTTPS Git URLs are accepted.
 */
export function coworkPluginMarketplace(plugin: HostPlugin): {
  source: 'github' | 'git';
  repo?: string;
  url?: string;
  ref: string;
  installationPreference: 'required';
} {
  const { source, ref } = plugin.marketplace;
  if (!ref || isAbsolute(source))
    throw new HostPluginError('plugin_unsupported', plugin.name);
  if (/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(source))
    return {
      source: 'github',
      repo: source.toLowerCase(),
      ref,
      installationPreference: 'required',
    };
  let url: URL;
  try {
    url = new URL(source);
  } catch {
    throw new HostPluginError('plugin_unsupported', plugin.name);
  }
  if (url.protocol !== 'https:' || url.username || url.password)
    throw new HostPluginError('plugin_unsupported', plugin.name);
  return {
    source: 'git',
    url: source,
    ref,
    installationPreference: 'required',
  };
}

/**
 * Cowork has no managed per-plugin MCP env, data dir, or user_config (see
 * docs/cowork.md), so it cannot point a plugin's own MCP server at an eval
 * endpoint. Reject `plugins[].mcp`; use a stdio `servers[]` entry and
 * `blockMcpServers` instead.
 */
export function assertCoworkHostPlugins(plugins: readonly HostPlugin[]): void {
  const parsed = HostPluginsSchema.safeParse(plugins);
  if (!parsed.success) throw new HostPluginError('plugin_invalid', 'config');
  for (const plugin of plugins) {
    if (Object.keys(plugin.mcp ?? {}).length)
      throw new HostPluginError('plugin_unsupported', plugin.name);
    coworkPluginMarketplace(plugin);
  }
}

/** Managed `policy-only` entries that block each plugin's own servers. */
export function coworkBlockedMcpEntries(plugins: readonly HostPlugin[]): Array<{
  name: string;
  transport: 'policy-only';
  toolPolicy: { '*': 'blocked' };
}> {
  return plugins.flatMap((plugin) =>
    (plugin.blockMcpServers ?? []).map((name) => ({
      name,
      transport: 'policy-only' as const,
      toolPolicy: { '*': 'blocked' as const },
    }))
  );
}
