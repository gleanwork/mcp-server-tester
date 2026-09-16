import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join, posix, resolve } from 'node:path';
import type { MCPConfig } from '../../config/mcpConfig.js';
import type { EvalManifest } from '../evalManifest.js';
import { createCoworkMcpPlan, resolveCoworkMcpHeaders } from './config.js';
import { resolveCoworkSetupConfig, type CoworkSetupConfig } from './options.js';

const ERROR_MESSAGE = 'Unable to prepare Cowork MCP bundle.';
const MAX_CREDENTIAL_BYTES = 64 * 1024;

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

/**
 * Prepare private, ephemeral staging input, NOT a shareable report. Copying or
 * applying it to runtimeDirectory is caller-owned; this does not verify Desktop.
 * Only the supplied runtime environment is read, never ambient process.env.
 * Runtime and staging use the same relative file layout.
 * Parent directories must be trusted; helpers use O_NOFOLLOW on the final file.
 */
export async function prepareCoworkMcpBundle(options: {
  manifest: EvalManifest;
  arm?: string;
  directory: string;
  runtimeDirectory: string;
  env?: Record<string, string | undefined>;
}): Promise<{ directory: string; settingsPath: string; serverCount: number }> {
  let createdDirectory: string | undefined;
  try {
    const { servers, setup } = selectSetup(options.manifest, options.arm);
    const plan = createCoworkMcpPlan(servers, options.runtimeDirectory, setup);
    const headers = resolveCoworkMcpHeaders(servers, options.env ?? {});
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
    await writeFile(
      settingsPath,
      JSON.stringify(plan.settings, null, 2) + '\n',
      {
        mode: 0o600,
        flag: 'wx',
      }
    );
    await writeFile(
      join(directory, 'status.json'),
      JSON.stringify(
        {
          status: 'prepared-not-applied',
          desktopVerified: false,
          serverCount: servers.length,
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
    return { directory, settingsPath, serverCount: servers.length };
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
