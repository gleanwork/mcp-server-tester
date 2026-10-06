import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join, posix, resolve } from 'node:path';
import { mcpServerLabel, type MCPConfig } from '../../config/mcpConfig.js';
import {
  hostStdioFileContents,
  hostStdioServers,
  resolveHostStdioCredentials,
  resolveHostStdioServer,
  type MarketplacePlugin,
} from '../hostPlugins.js';
import type { EvalManifest } from '../evalManifest.js';
import {
  createCoworkMcpPlan,
  resolveCoworkMcpHeaders,
  toCoworkServers,
} from './config.js';
import { resolveCoworkSetupConfig, type CoworkSetupConfig } from './options.js';

const ERROR_MESSAGE = 'Unable to prepare Cowork MCP bundle.';
const MAX_CREDENTIAL_BYTES = 64 * 1024;
/** Generated settings must remain readable by the Mac transaction. */
export const COWORK_SETTINGS_MAX_BYTES = 1024 * 1024;

function selectSetup(
  manifest: EvalManifest,
  armName?: string
): { servers: MCPConfig[]; setup: CoworkSetupConfig } {
  const arms = manifest.arms ?? [];
  if (new Set(arms.map((arm) => arm.name)).size !== arms.length) {
    throw new Error(ERROR_MESSAGE);
  }
  const arm =
    armName === undefined
      ? undefined
      : arms.find((arm) => arm.name === armName);
  if (armName !== undefined && !arm) throw new Error(ERROR_MESSAGE);
  const servers = arm?.servers === undefined ? manifest.servers : arm.servers;
  if (servers === undefined) throw new Error(ERROR_MESSAGE);
  return {
    servers,
    setup: resolveCoworkSetupConfig(manifest.coworkSetup, arm?.coworkSetup),
  };
}

/** The generated executable contains metadata only, never credential values. */
function headersHelper(
  filePath: string,
  names: string[],
  bearer: boolean
): string {
  // Config validation limits paths to shell-safe ASCII. JSON string/array
  // literals here are also valid Python literals (no JSON booleans or null).
  return `#!/bin/sh
exec /usr/bin/python3 -I - <<'COWORK_HEADERS_PY'
import json
import os
import re
import stat
import sys

PATH = ${JSON.stringify(filePath)}
NAMES = ${JSON.stringify(names)}
BEARER = ${bearer ? 'True' : 'False'}
LIMIT = 65536

def reject():
    raise ValueError()

def unique_object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            reject()
        result[key] = value
    return result

def validate_file(info):
    if (not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid()
            or info.st_mode & 0o077 or info.st_size > LIMIT):
        reject()

try:
    fd = os.open(PATH, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    try:
        before = os.fstat(fd)
        validate_file(before)
        content = bytearray()
        while len(content) <= LIMIT:
            chunk = os.read(fd, LIMIT + 1 - len(content))
            if not chunk:
                break
            content.extend(chunk)
        if len(content) > LIMIT:
            reject()
        after = os.fstat(fd)
        validate_file(after)
        if (after.st_size != len(content) or before.st_size != after.st_size
                or before.st_mtime_ns != after.st_mtime_ns
                or before.st_ctime_ns != after.st_ctime_ns):
            reject()
    finally:
        os.close(fd)
    headers = json.loads(content.decode('utf-8'), object_pairs_hook=unique_object)
    if not isinstance(headers, dict) or set(headers) != set(NAMES):
        reject()
    normalized = set()
    for name, value in headers.items():
        if (not isinstance(name, str)
                or re.fullmatch(r"[!#$%&'*+.^_\x60|~0-9A-Za-z-]+", name) is None
                or name.lower() in normalized):
            reject()
        normalized.add(name.lower())
        if (not isinstance(value, str)
                or any(not (32 <= ord(c) <= 126 or 160 <= ord(c) <= 255) for c in value)):
            reject()
    if BEARER and re.fullmatch(r'Bearer [A-Za-z0-9._~+/-]+=*', headers['Authorization']) is None:
        reject()
    output = json.dumps(headers, ensure_ascii=True) + '\\n'
except Exception:
    sys.stderr.write('Unable to read Cowork MCP runtime headers.\\n')
    sys.exit(1)
sys.stdout.write(output)
COWORK_HEADERS_PY
`;
}

type BundlePlanOptions = {
  manifest: EvalManifest;
  arm?: string;
  runtimeDirectory: string;
  env?: Record<string, string | undefined>;
  plugins?: readonly MarketplacePlugin[];
};

/** Read-only preflight shared by the bundle writer and the Mac app lifecycle.
 * Contains resolved credentials: never log or attach the returned plan.
 */
export function createCoworkBundlePlan(options: BundlePlanOptions) {
  const { servers: declarations, setup } = selectSetup(
    options.manifest,
    options.arm
  );
  const labeled = declarations.map((server, index) => ({
    ...server,
    label: mcpServerLabel(server, index),
  }));
  const labels = labeled.map((server) => server.label.toLowerCase());
  if (new Set(labels).size !== labels.length) throw new Error(ERROR_MESSAGE);
  const servers = toCoworkServers(
    labeled.filter((server) => server.transport === 'http')
  );
  const plan = createCoworkMcpPlan(servers, options.runtimeDirectory, setup);
  const headers = resolveCoworkMcpHeaders(servers, options.env ?? {});
  for (const server of plan.servers) {
    if (
      server.helperName &&
      Buffer.byteLength(JSON.stringify(headers[server.label]) + '\n') >
        MAX_CREDENTIAL_BYTES
    )
      throw new Error(ERROR_MESSAGE);
  }
  const stdio = hostStdioServers(labeled, options.plugins ?? []);
  if (servers.length + stdio.length !== declarations.length)
    throw new Error(ERROR_MESSAGE);
  const tokens = resolveHostStdioCredentials(stdio, options.env ?? {});
  // Mac marketplace installation roots are not known before Desktop starts.
  const paths = { dataRoot: join(options.runtimeDirectory, 'stdio') };
  const privateFiles: Array<{ name: string; content: string }> = [];
  const stdioDirectories: string[] = [];
  const launches = stdio.map((server) => {
    const launch = resolveHostStdioServer(server, paths);
    const files = hostStdioFileContents(server, paths, tokens[server.label]);
    const names = Object.keys(files).map((name) => name.toLowerCase());
    if (new Set(names).size !== names.length) throw new Error(ERROR_MESSAGE);
    if (server.usesDataDir) stdioDirectories.push(`stdio/${server.label}`);
    for (const [name, value] of Object.entries(files)) {
      const serialized = JSON.stringify(value, null, 2);
      if (serialized === undefined) throw new Error(ERROR_MESSAGE);
      const content = serialized + '\n';
      if (Buffer.byteLength(content) > MAX_CREDENTIAL_BYTES)
        throw new Error(ERROR_MESSAGE);
      privateFiles.push({ name: `stdio/${server.label}/${name}`, content });
    }
    return launch;
  });
  // Stdio is launched only through localDeveloperMCP, never managed settings.
  // Keep its resolved launch bound even though it is no longer in that file.
  const settings = plan.settings;
  const settingsBytes = Buffer.from(JSON.stringify(settings, null, 2) + '\n');
  if (
    settingsBytes.length + Buffer.byteLength(JSON.stringify(launches)) >
    COWORK_SETTINGS_MAX_BYTES
  )
    throw new Error(ERROR_MESSAGE);
  return {
    servers,
    plan,
    headers,
    privateFiles,
    stdioDirectories,
    serverCount: declarations.length,
    serverLabels: labels,
    settings,
    settingsBytes,
  };
}

/**
 * Prepare private, ephemeral staging input, NOT a shareable report. Copying or
 * applying it to runtimeDirectory is caller-owned; this does not verify Desktop.
 * Only the supplied runtime environment is read, never ambient process.env.
 * Runtime and staging use the same relative file layout.
 * Parent directories must be trusted; helpers use O_NOFOLLOW on the final file.
 */
export async function prepareCoworkMcpBundle(
  options: BundlePlanOptions & {
    directory: string;
  }
): Promise<{ directory: string; settingsPath: string; serverCount: number }> {
  let createdDirectory: string | undefined;
  try {
    const {
      servers,
      plan,
      headers,
      settingsBytes,
      privateFiles,
      stdioDirectories,
      serverCount,
    } = createCoworkBundlePlan(options);
    const credentials = plan.servers.flatMap((server, index) => {
      if (!server.helperName) return [];
      const values = headers[server.label]!;
      const content = JSON.stringify(values) + '\n';
      if (Buffer.byteLength(content) > MAX_CREDENTIAL_BYTES) {
        throw new Error(ERROR_MESSAGE);
      }
      const config = servers[index]!;
      const bearer =
        config.transport === 'http' &&
        Object.keys(config.auth ?? {}).length > 0;
      const fileName = `${server.label}.json`;
      return [
        {
          fileName,
          content,
          helperName: server.helperName,
          helper: headersHelper(
            posix.join(options.runtimeDirectory, 'credentials', fileName),
            Object.keys(values),
            bearer
          ),
        },
      ];
    });

    // All configuration and credential validation precedes the first write.
    const directory = resolve(options.directory);
    await mkdir(directory, { mode: 0o700, recursive: false });
    createdDirectory = directory;
    await mkdir(join(directory, 'credentials'), {
      mode: 0o700,
      recursive: false,
    });
    const settingsPath = join(directory, 'managed-mcp.json');
    await writeFile(settingsPath, settingsBytes, {
      mode: 0o600,
      flag: 'wx',
    });
    await writeFile(
      join(directory, 'status.json'),
      JSON.stringify(
        {
          status: 'prepared-not-applied',
          desktopVerified: false,
          serverCount,
        },
        null,
        2
      ) + '\n',
      { mode: 0o600, flag: 'wx' }
    );
    for (const credential of credentials) {
      await writeFile(
        join(directory, 'credentials', credential.fileName),
        credential.content,
        {
          mode: 0o600,
          flag: 'wx',
        }
      );
      await writeFile(
        join(directory, credential.helperName),
        credential.helper,
        {
          mode: 0o700,
          flag: 'wx',
        }
      );
    }
    if (stdioDirectories.length) {
      await mkdir(join(directory, 'stdio'), { mode: 0o700 });
      for (const name of stdioDirectories)
        await mkdir(join(directory, name), { mode: 0o700 });
      for (const file of privateFiles)
        await writeFile(join(directory, file.name), file.content, {
          mode: 0o600,
          flag: 'wx',
        });
    }
    return { directory, settingsPath, serverCount };
  } catch {
    if (createdDirectory !== undefined) {
      try {
        await rm(createdDirectory, { recursive: true, force: true });
      } catch {
        // Cleanup failures must not disclose paths or credential values either.
      }
    }
    throw new Error(ERROR_MESSAGE);
  }
}
