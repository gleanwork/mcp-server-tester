import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import {
  chmod,
  lstat,
  mkdir,
  open,
  realpath,
  rename,
  rm,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { createRequire } from 'node:module';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import {
  validateMCPConfig,
  usesHostResolvedFields,
  type MCPConfig,
} from '../../config/mcpConfig.js';
import { resolveCoworkMcpHeaders, toCoworkServers } from './config.js';

const ERROR = 'Unable to manage local Cowork MCP servers safely.';
const LABEL = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
const LIMIT = 4 * 1024 * 1024;
const Journal = z
  .object({
    version: z.literal(1),
    original: z.string().nullable(),
    mode: z
      .number()
      .int()
      .min(0)
      .max(0o777)
      .refine((mode) => (mode & 0o022) === 0),
    originalHash: z.string(),
    installedHash: z.string(),
  })
  .strict();

function target(): string {
  return join(
    homedir(),
    'Library/Application Support/Claude-3p/claude_desktop_config.json'
  );
}
function hash(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object')
    return `{${Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`)
      .join(',')}}`;
  return JSON.stringify(value) ?? 'null';
}
function object(bytes: Buffer): Record<string, unknown> {
  const value: unknown = JSON.parse(bytes.toString('utf8'));
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error(ERROR);
  return value as Record<string, unknown>;
}
async function bytes(
  path: string,
  privateOnly = false
): Promise<{ data: Buffer; mode: number } | undefined> {
  let fd;
  try {
    fd = await open(
      path,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw new Error(ERROR);
  }
  try {
    const before = await fd.stat();
    if (
      !before.isFile() ||
      before.uid !== process.getuid?.() ||
      before.size > LIMIT ||
      before.mode & (privateOnly ? 0o077 : 0o022)
    )
      throw new Error(ERROR);
    const buffer = Buffer.alloc(before.size + 1);
    let count = 0;
    while (count < buffer.length) {
      const { bytesRead } = await fd.read(
        buffer,
        count,
        buffer.length - count,
        count
      );
      if (!bytesRead) break;
      count += bytesRead;
    }
    const after = await fd.stat();
    if (
      count !== before.size ||
      after.mtimeMs !== before.mtimeMs ||
      after.ctimeMs !== before.ctimeMs
    )
      throw new Error(ERROR);
    return { data: buffer.subarray(0, count), mode: before.mode & 0o777 };
  } finally {
    await fd.close();
  }
}
async function validateDirectory(
  directory: string,
  present: boolean
): Promise<void> {
  if (
    dirname(directory) !== (await realpath(tmpdir())) ||
    !/^mst-cowork-session-[a-f0-9-]{36}-mcp$/.test(
      directory.split('/').at(-1) ?? ''
    )
  )
    throw new Error(ERROR);
  if (present) {
    const info = await lstat(directory);
    if (
      !info.isDirectory() ||
      info.isSymbolicLink() ||
      info.uid !== process.getuid?.() ||
      info.mode & 0o077
    )
      throw new Error(ERROR);
  }
}

export function validateMacLocalServers(servers: MCPConfig[]): void {
  const names = new Set<string>();
  for (const server of servers) {
    validateMCPConfig(server);
    if (
      !server.label ||
      !LABEL.test(server.label) ||
      ['journal', 'inference'].includes(server.label.toLowerCase()) ||
      names.has(server.label.toLowerCase()) ||
      (server.transport === 'stdio' && usesHostResolvedFields(server))
    )
      throw new Error(ERROR);
    names.add(server.label.toLowerCase());
  }
}

// These launchers contain no credential values. Per-server runtime JSON is 0600
// inside a private session directory; the public app config contains paths only.
const STDIO_LAUNCHER = `
const fs = require('node:fs');
const {spawn} = require('node:child_process');
const config = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const child = spawn(config.command, config.args || [], {cwd:config.cwd,env:config.env,stdio:['pipe','pipe','ignore']});
process.stdin.pipe(child.stdin); child.stdout.pipe(process.stdout);
child.stdin.on('error',()=>{}); child.on('error',()=>process.exit(1));
child.on('exit',code=>process.exit(code ?? 1));
process.stdin.on('end',()=>child.kill('SIGTERM'));
for(const signal of ['SIGTERM','SIGINT']) process.on(signal,()=>child.kill(signal));
`;
function httpLauncher(): string {
  const require = createRequire(
    typeof __filename === 'string' ? __filename : import.meta.url
  );
  const dependency = (name: string) => JSON.stringify(require.resolve(name));
  return `
const fs = require('node:fs');
const {Client,StreamableHTTPClientTransport,ProtocolError,ProtocolErrorCode} = require(${dependency('@modelcontextprotocol/client')});
const {Server} = require(${dependency('@modelcontextprotocol/server')});
const {StdioServerTransport} = require(${dependency('@modelcontextprotocol/server/stdio')});
const {z} = require(${dependency('zod')});
const ResultSchema = z.looseObject({});
(async()=>{
  const config=JSON.parse(fs.readFileSync(process.argv[2],'utf8'));
  const client=new Client({name:'mst-cowork-bridge',version:'1.0'});
  await client.connect(new StreamableHTTPClientTransport(new URL(config.url),{requestInit:{headers:config.headers}}));
  const caps=client.getServerCapabilities() || {};
  const capabilities=Object.fromEntries(['tools','resources','prompts','logging','completions'].filter(k=>k in caps).map(k=>[k,caps[k]]));
  const server=new Server({name:config.name,version:'1.0'},{capabilities});
  server.fallbackRequestHandler=async request=>{try{return await client.request({method:request.method,params:request.params},ResultSchema,{timeout:120000});}catch{throw new ProtocolError(ProtocolErrorCode.InternalError,'Upstream MCP request failed.');}};
  server.fallbackNotificationHandler=async notice=>{try{await client.notification(notice);}catch{}};
  client.fallbackNotificationHandler=async notice=>{try{await server.notification(notice);}catch{}};
  const close=()=>{Promise.allSettled([server.close(),client.close()]).finally(()=>process.exit(0));};
  process.stdin.on('end',close); process.on('SIGTERM',close); process.on('SIGINT',close);
  await server.connect(new StdioServerTransport());
})().catch(()=>{process.stderr.write('Cowork MCP bridge failed.\\n');process.exit(1);});
`;
}

/** Read-only preflight; called before stopping the user application. */
export async function preflightMacLocalMcp(
  servers: MCPConfig[],
  env: Record<string, string | undefined> = {}
): Promise<void> {
  validateMacLocalServers(servers);
  const headers = resolveCoworkMcpHeaders(
    toCoworkServers(servers.filter((server) => server.transport === 'http')),
    env
  );
  if (
    Object.values(headers).some(
      (value) => Buffer.byteLength(JSON.stringify(value)) > 64 * 1024
    )
  )
    throw new Error(ERROR);
  const parent = await lstat(dirname(target()));
  if (
    !parent.isDirectory() ||
    parent.isSymbolicLink() ||
    parent.uid !== process.getuid?.() ||
    parent.mode & 0o022
  )
    throw new Error(ERROR);
  const original = await bytes(target());
  if (original) object(original.data);
}

/** Caller owns the session lease and has stopped Claude. Replaces only the
 * developer MCP list for the evaluation; exact original bytes are journaled.
 */
export async function installMacLocalMcp(
  directory: string,
  servers: MCPConfig[],
  env: Record<string, string | undefined>
): Promise<void> {
  await preflightMacLocalMcp(servers, env);
  await validateDirectory(directory, false);
  const original = await bytes(target());
  const value = original ? object(original.data) : {};
  await mkdir(directory, { mode: 0o700 });
  // The journal precedes any target write. A failure before it exists leaves
  // only owned staging files, which recovery can discard without touching config.
  const entries: Record<string, unknown> = {};
  const http = toCoworkServers(servers.filter((s) => s.transport === 'http'));
  const headers = resolveCoworkMcpHeaders(http, env);
  for (const server of servers) {
    const label = server.label!;
    const launcher = join(directory, `${label}.cjs`);
    const config = join(directory, `${label}.json`);
    const runtime =
      server.transport === 'http'
        ? { name: label, url: server.serverUrl, headers: headers[label] ?? {} }
        : {
            command: server.command,
            args: server.args,
            cwd: server.cwd,
            env: {
              ...(server.inheritEnv === false
                ? {}
                : Object.fromEntries(
                    Object.entries(env).filter(
                      (entry): entry is [string, string] =>
                        typeof entry[1] === 'string'
                    )
                  )),
              ...server.env,
            },
          };
    await writeFile(
      launcher,
      server.transport === 'http' ? httpLauncher() : STDIO_LAUNCHER,
      { mode: 0o600, flag: 'wx' }
    );
    await writeFile(config, JSON.stringify(runtime), {
      mode: 0o600,
      flag: 'wx',
    });
    entries[label] = { command: process.execPath, args: [launcher, config] };
  }
  const installed = { ...value, mcpServers: entries };
  const journal = {
    version: 1,
    original: original?.data.toString('base64') ?? null,
    mode: original?.mode ?? 0o600,
    originalHash: original ? hash(original.data) : '',
    installedHash: hash(Buffer.from(canonical(installed))),
  };
  await writeFile(join(directory, 'journal.json'), JSON.stringify(journal), {
    mode: 0o600,
    flag: 'wx',
  });
  const current = await bytes(target());
  if (original ? !current?.data.equals(original.data) : current !== undefined)
    throw new Error(ERROR);
  const staged = join(directory, 'config.next');
  await writeFile(staged, JSON.stringify(installed, null, 2) + '\n', {
    mode: 0o600,
    flag: 'wx',
  });
  await rename(staged, target());
}

/** Claude must be stopped. Semantic equality tolerates its whitespace rewrite,
 * but any actual concurrent change retains the journal rather than clobbering it.
 */
export async function restoreMacLocalMcp(directory: string): Promise<void> {
  try {
    await lstat(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  await validateDirectory(directory, true);
  const receipt = await bytes(join(directory, 'journal.json'), true);
  if (receipt) {
    const journal = Journal.parse(JSON.parse(receipt.data.toString('utf8')));
    const original =
      journal.original === null
        ? undefined
        : Buffer.from(journal.original, 'base64');
    if (original && hash(original) !== journal.originalHash)
      throw new Error(ERROR);
    const current = await bytes(target());
    const unchanged = original
      ? current?.data.equals(original)
      : current === undefined;
    if (!unchanged) {
      if (
        !current ||
        hash(Buffer.from(canonical(object(current.data)))) !==
          journal.installedHash
      )
        throw new Error(ERROR);
      if (original) {
        const staged = join(directory, 'config.restore');
        await writeFile(staged, original, { mode: 0o600, flag: 'wx' });
        await chmod(staged, journal.mode & 0o777);
        await rename(staged, target());
      } else await unlink(target());
    }
  }
  await rm(directory, { recursive: true });
}
