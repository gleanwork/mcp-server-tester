import { lstat, readFile, realpath, rename, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { parse, stringify } from 'smol-toml';
import {
  HostPluginError,
  HostPluginsSchema,
  hostPluginMcpServers,
  materializeHostPluginMcp,
  type HostPlugin,
  type HostPluginCredentials,
} from '../hostPlugins.js';
import { runBounded } from './native.js';

export { HostPluginError, type HostPlugin } from '../hostPlugins.js';

const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const COMMAND_TIMEOUT_MS = 180_000;
const COMMAND_OUTPUT_BYTES = 256 * 1024;

/** Sanitized install receipt. No paths, URLs, or credentials. */
export interface HostPluginReceipt {
  name: string;
  marketplace: string;
  version: string;
  ref?: string;
  /** The plugin's own MCP servers that now target the eval endpoint. */
  mcpServers?: string[];
}

/** A plugin MCP server that must pass readiness under its own label. */
export interface HostPluginReadinessTarget {
  label: string;
  minTools: number;
}

/**
 * Install plugins with the packaged Codex CLI into CODEX_HOME. For each
 * declared MCP override, write a complete `[mcp_servers.<server>]` table under
 * the plugin's own server name: command/args/cwd from the plugin's `.mcp.json`,
 * env merged with the substituted override. A partial env-only table would
 * make the app reject the transport. Override files go in a private data dir.
 */
export async function installCodexPlugins(options: {
  codexPath: string;
  env: Record<string, string>;
  codexHome: string;
  plugins: readonly HostPlugin[];
  credentials: HostPluginCredentials;
  /** Direct MCP labels; a plugin server must not shadow one. */
  reservedLabels?: readonly string[];
}): Promise<HostPluginReceipt[]> {
  const { codexPath, env, codexHome } = options;
  const parsed = HostPluginsSchema.safeParse(options.plugins);
  if (!parsed.success) throw new HostPluginError('plugin_invalid', 'config');
  const plugins = parsed.data;
  const reserved = new Set(options.reservedLabels ?? []);
  for (const { plugin, server } of hostPluginMcpServers(plugins))
    if (reserved.has(server))
      throw new HostPluginError('plugin_invalid', plugin);
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
        // A local source is already the pinned checkout; its ref is recorded only.
        ...(ref && !isAbsolute(source) ? ['--ref', ref] : []),
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
    const overrides = hostPluginMcpServers([plugin]);
    if (overrides.length) {
      const declared = await readJson(join(root, '.mcp.json'), plugin.name);
      for (const target of overrides) {
        const server = (
          declared.mcpServers as Record<string, unknown> | undefined
        )?.[target.server];
        if (!isStdio(server))
          throw new HostPluginError('plugin_mcp_invalid', plugin.name);
        const cwd = resolve(
          root,
          typeof server.cwd === 'string' ? server.cwd : '.'
        );
        const args = (server.args ?? []).map((arg) =>
          arg.startsWith('./') ? resolve(root, arg) : arg
        );
        // Codex does not expand host placeholders in config.toml.
        if (
          !inside(root, cwd, true) ||
          [server.command, ...args].some((value) => value.includes('${'))
        )
          throw new HostPluginError('plugin_mcp_invalid', plugin.name);
        const { env: overrideEnv } = await materializeHostPluginMcp({
          dataRoot: join(codexHome, 'mst-plugin-data'),
          server: target,
          credentials: options.credentials,
        });
        servers[target.server] = {
          command: server.command,
          args,
          cwd,
          env: { ...(server.env ?? {}), ...overrideEnv },
        };
      }
      receipt.mcpServers = overrides.map((target) => target.server);
    }
    receipts.push(receipt);
  }
  if (Object.keys(servers).length) {
    const configPath = join(codexHome, 'config.toml');
    const settings = parse(await readFile(configPath, 'utf8'));
    const current = (settings.mcp_servers ?? {}) as Record<string, unknown>;
    if (Object.keys(servers).some((name) => Object.hasOwn(current, name)))
      throw new HostPluginError('plugin_invalid', 'label');
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

/** Readiness targets: every overridden plugin server, under its own name. */
export function codexPluginReadinessTargets(
  plugins: readonly HostPlugin[]
): HostPluginReadinessTarget[] {
  return hostPluginMcpServers(plugins).map(({ server, override }) => ({
    label: server,
    minTools: override.minTools,
  }));
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
