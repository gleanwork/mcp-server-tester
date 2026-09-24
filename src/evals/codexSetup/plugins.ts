import { constants } from 'node:fs';
import {
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
  realpath,
  rename,
  writeFile,
} from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { parse, stringify } from 'smol-toml';
import { z } from 'zod';
import { runBounded } from './native.js';

const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const COMMAND_TIMEOUT_MS = 180_000;
const COMMAND_OUTPUT_BYTES = 256 * 1024;

/**
 * A host plugin that MST installs into a fresh native profile. `mcp` points
 * the plugin's own MCP server at an eval server: the plugin's server replaces
 * the direct server with that label, so traces and readiness keep the label.
 */
export const HostPluginSchema = z
  .object({
    name: z.string().regex(NAME),
    marketplace: z
      .object({
        /** owner/repo, HTTPS Git URL, or an absolute local path. */
        source: z.string().min(1).max(512),
        /** Full commit SHA. Required for Git sources so runs are reproducible. */
        ref: z
          .string()
          .regex(/^[0-9a-f]{40}$/)
          .optional(),
      })
      .strict(),
    mcp: z
      .object({
        /** Server name in the plugin's .mcp.json. */
        server: z.string().regex(NAME),
        /** Label of the direct eval server that this plugin server replaces. */
        replaces: z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,63}$/),
        /** How to point the plugin server at the replaced URL and credential. */
        adapter: z.literal('glean'),
      })
      .strict()
      .optional(),
  })
  .strict()
  .refine(
    (plugin) =>
      isAbsolute(plugin.marketplace.source) ||
      plugin.marketplace.ref !== undefined,
    'Git plugin marketplaces require a full commit SHA ref.'
  );

export type HostPlugin = z.infer<typeof HostPluginSchema>;

/** Sanitized install receipt. No paths, URLs, or credentials. */
export interface HostPluginReceipt {
  name: string;
  marketplace: string;
  version: string;
  ref?: string;
  mcpServer?: string;
  replaces?: string;
}

export class HostPluginError extends Error {
  constructor(
    readonly code:
      | 'plugin_invalid'
      | 'plugin_marketplace_failed'
      | 'plugin_install_failed'
      | 'plugin_mcp_invalid',
    readonly plugin: string
  ) {
    super(
      `Host plugin setup failed (${code}: ${plugin}); no prompt was sent and nothing was retried.`
    );
    this.name = 'HostPluginError';
  }
}

export interface ReplacedServer {
  label: string;
  url: string;
  /** Resolved bearer token for the replaced server. */
  token: string;
}

/**
 * Install plugins with the packaged Codex CLI into CODEX_HOME, then rewrite
 * config.toml so each `mcp` plugin server runs under the replaced label with
 * the eval URL and credential. The plugin's own server entry is disabled.
 */
export async function installCodexPlugins(options: {
  codexPath: string;
  env: Record<string, string>;
  codexHome: string;
  plugins: readonly HostPlugin[];
  replaced: readonly ReplacedServer[];
}): Promise<HostPluginReceipt[]> {
  const { codexPath, env, codexHome } = options;
  const plugins = options.plugins.map((plugin) => {
    const parsed = HostPluginSchema.safeParse(plugin);
    if (!parsed.success)
      throw new HostPluginError('plugin_invalid', String(plugin?.name));
    return parsed.data;
  });
  if (new Set(plugins.map((p) => p.name)).size !== plugins.length)
    throw new HostPluginError('plugin_invalid', 'duplicate');
  const run = async (
    args: string[],
    code: HostPluginError['code'],
    name: string
  ) => {
    const result = await runBounded(codexPath, args, {
      env,
      cwd: codexHome,
      timeoutMs: COMMAND_TIMEOUT_MS,
      maxOutputBytes: COMMAND_OUTPUT_BYTES,
    });
    if (result.failure || result.exitCode !== 0)
      throw new HostPluginError(code, name);
    return lastJsonObject(result.output.toString('utf8'), code, name);
  };
  const receipts: HostPluginReceipt[] = [];
  const servers: Record<string, Record<string, unknown>> = {};
  for (const plugin of plugins) {
    const { source, ref } = plugin.marketplace;
    const added = await run(
      [
        'plugin',
        'marketplace',
        'add',
        source,
        ...(ref ? ['--ref', ref] : []),
        '--json',
      ],
      'plugin_marketplace_failed',
      plugin.name
    );
    const marketplace = added.marketplaceName;
    if (typeof marketplace !== 'string' || !NAME.test(marketplace))
      throw new HostPluginError('plugin_marketplace_failed', plugin.name);
    const installed = await run(
      ['plugin', 'add', `${plugin.name}@${marketplace}`, '--json'],
      'plugin_install_failed',
      plugin.name
    );
    const root = await ownedDirectoryInside(
      codexHome,
      installed.installedPath,
      plugin.name
    );
    const manifest = await readJson(
      join(root, '.codex-plugin', 'plugin.json'),
      plugin.name
    );
    const version =
      typeof manifest.version === 'string' ? manifest.version : 'unknown';
    const receipt: HostPluginReceipt = {
      name: plugin.name,
      marketplace,
      version,
      ref,
    };
    if (plugin.mcp) {
      const target = options.replaced.find(
        (s) => s.label === plugin.mcp!.replaces
      );
      if (!target) throw new HostPluginError('plugin_mcp_invalid', plugin.name);
      const declared = await readJson(join(root, '.mcp.json'), plugin.name);
      const server = (
        declared.mcpServers as Record<string, unknown> | undefined
      )?.[plugin.mcp.server];
      if (!isStdio(server))
        throw new HostPluginError('plugin_mcp_invalid', plugin.name);
      const cwd = resolve(
        root,
        typeof server.cwd === 'string' ? server.cwd : '.'
      );
      if (!inside(root, cwd, true))
        throw new HostPluginError('plugin_mcp_invalid', plugin.name);
      const base = {
        command: server.command,
        args: (server.args ?? []).map((arg) =>
          arg.startsWith('./') ? resolve(root, arg) : arg
        ),
        cwd,
      };
      // Disable the plugin's own entry; a full table keeps the transport valid.
      servers[plugin.mcp.server] = { ...base, enabled: false };
      servers[target.label] = {
        ...base,
        env: {
          ...(server.env ?? {}),
          ...(await gleanAdapter(codexHome, plugin.name, target)),
        },
      };
      receipt.mcpServer = plugin.mcp.server;
      receipt.replaces = target.label;
    }
    receipts.push(receipt);
  }
  if (Object.keys(servers).length) {
    const configPath = join(codexHome, 'config.toml');
    const settings = parse(await readFile(configPath, 'utf8'));
    const current = (settings.mcp_servers ?? {}) as Record<string, unknown>;
    settings.mcp_servers = { ...current, ...servers } as typeof settings;
    const temporary = `${configPath}.mst-plugins`;
    await writeFile(temporary, stringify(settings), {
      mode: 0o600,
      flag: 'wx',
    });
    await rename(temporary, configPath);
  }
  return receipts;
}

/**
 * The Glean plugin adapter reads its endpoint from GLEAN_MCP_SERVER_URL and
 * its credential from $CLAUDE_PLUGIN_DATA/mcp-credentials.json. Seed both in a
 * private directory; approval prompts are off because nobody can answer them.
 */
async function gleanAdapter(
  codexHome: string,
  plugin: string,
  target: ReplacedServer
): Promise<Record<string, string>> {
  if (!target.token || /[\r\n]/.test(target.token))
    throw new HostPluginError('plugin_mcp_invalid', plugin);
  const data = join(codexHome, 'mst-plugin-data', plugin);
  await mkdir(data, { recursive: true, mode: 0o700 });
  await chmod(join(codexHome, 'mst-plugin-data'), 0o700);
  await chmod(data, 0o700);
  const handle = await open(
    join(data, 'mcp-credentials.json'),
    constants.O_WRONLY |
      constants.O_CREAT |
      constants.O_EXCL |
      constants.O_NOFOLLOW,
    0o600
  );
  try {
    await handle.writeFile(
      JSON.stringify({
        tokens: { access_token: target.token, token_type: 'Bearer' },
      })
    );
  } finally {
    await handle.close();
  }
  return {
    ENABLE_HITL: 'false',
    GLEAN_MCP_SERVER_URL: target.url,
    CLAUDE_PLUGIN_DATA: data,
  };
}

function isStdio(value: unknown): value is {
  command: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
} {
  if (typeof value !== 'object' || value === null) return false;
  const server = value as Record<string, unknown>;
  return (
    typeof server.command === 'string' &&
    server.command.length > 0 &&
    server.url === undefined &&
    (server.args === undefined ||
      (Array.isArray(server.args) &&
        server.args.every((a) => typeof a === 'string'))) &&
    (server.cwd === undefined || typeof server.cwd === 'string') &&
    (server.env === undefined ||
      (typeof server.env === 'object' &&
        server.env !== null &&
        Object.values(server.env).every((v) => typeof v === 'string')))
  );
}

async function ownedDirectoryInside(
  parent: string,
  path: unknown,
  plugin: string
): Promise<string> {
  if (typeof path !== 'string' || !isAbsolute(path))
    throw new HostPluginError('plugin_install_failed', plugin);
  try {
    const [real, realParent, info] = await Promise.all([
      realpath(path),
      realpath(parent),
      lstat(path),
    ]);
    if (
      !info.isDirectory() ||
      info.uid !== process.getuid?.() ||
      !inside(realParent, real)
    )
      throw new Error();
    return real;
  } catch {
    throw new HostPluginError('plugin_install_failed', plugin);
  }
}

async function readJson(
  path: string,
  plugin: string
): Promise<Record<string, unknown>> {
  try {
    const value: unknown = JSON.parse(await readFile(path, 'utf8'));
    if (typeof value !== 'object' || value === null || Array.isArray(value))
      throw new Error();
    return value as Record<string, unknown>;
  } catch {
    throw new HostPluginError('plugin_mcp_invalid', plugin);
  }
}

/** The CLI prints diagnostics before its --json object on the shared stream. */
function lastJsonObject(
  output: string,
  code: HostPluginError['code'],
  plugin: string
): Record<string, unknown> {
  const end = output.lastIndexOf('}');
  for (
    let start = output.lastIndexOf('{', end);
    start >= 0;
    start = output.lastIndexOf('{', start - 1)
  ) {
    try {
      const value: unknown = JSON.parse(output.slice(start, end + 1));
      if (typeof value === 'object' && value !== null && !Array.isArray(value))
        return value as Record<string, unknown>;
    } catch {
      /* keep scanning back to the enclosing object */
    }
  }
  throw new HostPluginError(code, plugin);
}

function inside(parent: string, child: string, allowEqual = false): boolean {
  const path = relative(parent, child);
  if (path === '') return allowEqual;
  return path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path);
}
