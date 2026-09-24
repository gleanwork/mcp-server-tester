import { constants } from 'node:fs';
import { lstat, mkdir, open } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { z } from 'zod';

/**
 * Host plugins: a caller-supplied, host-neutral declaration. MST has no
 * plugin-specific code. Each plugin names a pinned marketplace and, optionally,
 * declarative overrides that point the plugin's own MCP servers at an eval
 * endpoint. Hosts own validation of what they can apply (`host.plugins`).
 */

const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
/** Plugin MCP server names become host config keys and trace labels. */
const SERVER = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
/** One path segment. No separators, no `.`/`..`, no hidden or odd names. */
const FILE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const PLACEHOLDER = /\$\{([A-Za-z]+)\}/g;
/** The only substituted placeholders. Any other `${...}` fails validation. */
export const HOST_PLUGIN_PLACEHOLDERS = [
  'url',
  'dataDir',
  'bearerToken',
] as const;
type Placeholder = (typeof HOST_PLUGIN_PLACEHOLDERS)[number];
const MAX_FILE_BYTES = 64 * 1024;

function placeholders(value: string): string[] {
  return [...value.matchAll(PLACEHOLDER)].map((match) => match[1]!);
}
function onlyKnown(value: string): boolean {
  const known = new Set<string>(HOST_PLUGIN_PLACEHOLDERS);
  // A stray `${` that is not a well-formed placeholder is also rejected.
  return (
    placeholders(value).every((name) => known.has(name)) &&
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
  }, 'Plugin MCP URLs must be HTTPS (or loopback HTTP) without credentials.');

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
        (files) => strings(files ?? {}).every(onlyKnown),
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
  })
  .strict()
  .refine(
    (plugin) =>
      isAbsolute(plugin.marketplace.source) ||
      plugin.marketplace.ref !== undefined,
    'Git plugin marketplaces require a full commit SHA ref.'
  );

export const HostPluginsSchema = z
  .array(HostPluginSchema)
  .max(16)
  .superRefine((plugins, context) => {
    if (new Set(plugins.map((p) => p.name)).size !== plugins.length)
      context.addIssue({ code: 'custom', message: 'Duplicate plugin names.' });
    const servers = plugins.flatMap((p) => Object.keys(p.mcp ?? {}));
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
      | 'plugin_unsupported',
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

function substitute(value: string, values: Record<Placeholder, string>) {
  return value.replace(PLACEHOLDER, (_all, name: string) => {
    if (!(name in values)) throw new Error('placeholder');
    return values[name as Placeholder];
  });
}
function substituteJson(
  value: unknown,
  values: Record<Placeholder, string>
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
  try {
    for (const path of [
      options.dataRoot,
      join(options.dataRoot, plugin),
      dataDir,
    ]) {
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
    throw new HostPluginError('plugin_data_unsafe', plugin);
  }
  const values = { url: override.url, dataDir, bearerToken: token };
  for (const [name, content] of Object.entries(override.files ?? {})) {
    const bytes = Buffer.from(
      JSON.stringify(substituteJson(content, values)),
      'utf8'
    );
    if (bytes.length > MAX_FILE_BYTES)
      throw new HostPluginError('plugin_invalid', plugin);
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
      throw new HostPluginError('plugin_data_unsafe', plugin);
    } finally {
      await handle?.close();
    }
  }
  const env = Object.fromEntries(
    Object.entries(override.env ?? {}).map(([k, v]) => [
      k,
      substitute(v, values),
    ])
  );
  return { env, dataDir };
}

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
 * endpoint. Reject overrides rather than run the plugin against another target.
 */
export function assertCoworkHostPlugins(plugins: readonly HostPlugin[]): void {
  for (const plugin of plugins) {
    if (Object.keys(plugin.mcp ?? {}).length)
      throw new HostPluginError('plugin_unsupported', plugin.name);
    coworkPluginMarketplace(plugin);
  }
}
