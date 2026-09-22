import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import {
  chmod,
  mkdir,
  open,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { z } from 'zod';
import { parse, stringify } from 'smol-toml';

const LABEL_PATTERN = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
const ENV_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
const MAX_CONFIG_BYTES = 128 * 1024;
const LOCK_SUFFIX = '.mst-lock';

const CodexStdioServerSchema = z
  .object({
    transport: z.literal('stdio'),
    label: z.string().regex(LABEL_PATTERN),
    command: z.string().min(1),
    args: z.array(z.string()).optional(),
    cwd: z.string().optional(),
    env: z.record(z.string(), z.string()).optional(),
  })
  .strict();

const CodexHttpServerSchema = z
  .object({
    transport: z.literal('http'),
    label: z.string().regex(LABEL_PATTERN),
    url: z.string().url(),
    bearerTokenEnvVar: z.string().regex(ENV_NAME_PATTERN).optional(),
  })
  .strict();

export const CodexMcpServerConfigSchema = z.discriminatedUnion('transport', [
  CodexStdioServerSchema,
  CodexHttpServerSchema,
]);

export const CodexNamedConfigSchema = z
  .object({
    name: z.string().min(1).max(128),
    servers: z.array(CodexMcpServerConfigSchema),
  })
  .strict();

export const CodexSetupConfigSchema = z
  .object({
    configPath: z.string().optional(),
    configName: z.string().min(1).optional(),
    servers: z.array(CodexMcpServerConfigSchema).optional(),
    configs: z.array(CodexNamedConfigSchema).optional(),
  })
  .strict()
  .refine(
    (value) => value.servers !== undefined || value.configs !== undefined,
    'Codex setup requires servers or configs.'
  )
  .refine(
    (value) => !(value.servers !== undefined && value.configs !== undefined),
    'Codex setup cannot specify both servers and configs.'
  );

export type CodexMcpServerConfig = z.infer<typeof CodexMcpServerConfigSchema>;
export type CodexNamedConfig = z.infer<typeof CodexNamedConfigSchema>;
export type CodexSetupConfig = z.infer<typeof CodexSetupConfigSchema>;

export interface ResolvedCodexSetup {
  configPath: string;
  configName: string;
  servers: CodexMcpServerConfig[];
  content: string;
}

interface CodexConfigJournal {
  version: 1;
  transactionId: string;
  phase: 'installed';
  targetPath: string;
  originalPresent: boolean;
  originalSha256: string | null;
  originalMode: number | null;
  installedSha256: string;
}

export interface CodexConfigInstallation {
  readonly configPath: string;
  readonly configName: string;
  readonly serverCount: number;
  restore(options?: { archiveChanges?: boolean }): Promise<void>;
}

export function resolveCodexSetup(
  setup: CodexSetupConfig,
  configName?: string
): ResolvedCodexSetup {
  const parsed = CodexSetupConfigSchema.parse(setup);
  const selectedName = configName ?? parsed.configName;
  let name: string;
  let servers: CodexMcpServerConfig[];

  if (parsed.configs !== undefined) {
    const names = parsed.configs.map((config) => config.name);
    if (new Set(names).size !== names.length) {
      throw new Error('Codex setup config names must be unique.');
    }
    const selected =
      selectedName === undefined
        ? parsed.configs.length === 1
          ? parsed.configs[0]
          : undefined
        : parsed.configs.find((config) => config.name === selectedName);
    if (!selected) {
      throw new Error(
        selectedName === undefined
          ? 'Codex configName is required when multiple configs are provided.'
          : `Unknown Codex config: ${selectedName}`
      );
    }
    name = selected.name;
    servers = selected.servers;
  } else {
    name = selectedName ?? 'default';
    servers = parsed.servers ?? [];
  }

  const configPath = resolve(
    parsed.configPath ?? join(homedir(), '.codex', 'config.toml')
  );
  if (!isAbsolute(configPath)) {
    throw new Error('Codex configPath must be absolute.');
  }
  return {
    configPath,
    configName: name,
    servers,
    content: renderCodexConfig(servers),
  };
}

export function renderCodexConfig(
  servers: readonly CodexMcpServerConfig[]
): string {
  const labels = new Set<string>();
  const blocks = servers.map((server) => {
    if (labels.has(server.label)) {
      throw new Error(`Duplicate Codex MCP server label: ${server.label}`);
    }
    labels.add(server.label);
    return server.transport === 'stdio'
      ? renderStdioServer(server)
      : renderHttpServer(server);
  });
  const content = [
    '# Managed by MCP Server Tester. Restored after the host run.',
    ...blocks,
  ].join('\n\n');
  if (Buffer.byteLength(content, 'utf8') > MAX_CONFIG_BYTES) {
    throw new Error('Codex configuration is too large.');
  }
  return `${content}\n`;
}

export async function installCodexConfig(
  setup: CodexSetupConfig,
  options: {
    configName?: string;
    model?: string;
    reasoningEffort?: string;
  } = {}
): Promise<CodexConfigInstallation> {
  if (options.model !== undefined && !/^[A-Za-z0-9._:-]+$/.test(options.model))
    throw new Error('Invalid ChatGPT model ID.');
  if (
    options.reasoningEffort !== undefined &&
    !['low', 'medium', 'high', 'xhigh', 'max', 'ultra'].includes(
      options.reasoningEffort
    )
  )
    throw new Error('Invalid ChatGPT reasoning effort.');
  const resolved = resolveCodexSetup(setup, options.configName);
  const target = resolved.configPath;
  const lock = `${target}${LOCK_SUFFIX}`;
  const originalPath = join(lock, 'original.toml');
  const journalPath = join(lock, 'journal.json');
  const temporaryPath = join(
    dirname(target),
    `.${basename(target)}.mst-${randomUUID()}`
  );
  await mkdir(dirname(target), { recursive: true, mode: 0o700 });
  await assertSafeParent(dirname(target));
  await mkdir(lock, { mode: 0o700 });
  let originalPresent = false;
  let originalSha256: string | null = null;
  let originalMode: number | null = null;
  let committed = false;
  try {
    const original = await readOwnedFile(target);
    if (original !== undefined) {
      originalPresent = true;
      originalSha256 = sha256(original);
      originalMode = (await stat(target)).mode & 0o777;
      await writeFile(originalPath, original, { mode: 0o600, flag: 'wx' });
    }
    // Keep app preferences and startup hooks. Replacing the whole document makes
    // ChatGPT rewrite defaults during startup and loses the selected Work settings.
    const settings = original ? parse(original.toString('utf8')) : {};
    settings.mcp_servers = parse(resolved.content).mcp_servers ?? {};
    if (options.model !== undefined) settings.model = options.model;
    if (options.reasoningEffort !== undefined)
      settings.model_reasoning_effort = options.reasoningEffort;
    const installedBytes = Buffer.from(stringify(settings), 'utf8');
    if (installedBytes.length > MAX_CONFIG_BYTES)
      throw new Error('Codex configuration is too large.');
    const installedSha256 = sha256(installedBytes);
    const journal: CodexConfigJournal = {
      version: 1,
      transactionId: randomUUID(),
      phase: 'installed',
      targetPath: target,
      originalPresent,
      originalSha256,
      originalMode,
      installedSha256,
    };
    await writeFile(journalPath, `${JSON.stringify(journal)}\n`, {
      mode: 0o600,
      flag: 'wx',
    });
    await writeFile(temporaryPath, installedBytes, { mode: 0o600, flag: 'wx' });
    await chmod(temporaryPath, 0o600);
    await rename(temporaryPath, target);
    committed = true;
    return {
      configPath: target,
      configName: resolved.configName,
      serverCount: resolved.servers.length,
      async restore(options) {
        await restoreCodexConfig(lock, journal, options);
      },
    };
  } catch (error) {
    await rm(temporaryPath, { force: true }).catch(() => undefined);
    if (!committed) {
      await rm(lock, { recursive: true, force: true }).catch(() => undefined);
    }
    throw error instanceof Error
      ? error
      : new Error('Unable to install Codex configuration.');
  }
}

export async function restoreCodexConfig(
  lock: string,
  expected?: CodexConfigJournal,
  options: { archiveChanges?: boolean } = {}
): Promise<void> {
  const journal = expected ?? (await readJournal(join(lock, 'journal.json')));
  if (journal.targetPath !== lock.slice(0, -LOCK_SUFFIX.length)) {
    throw new Error('Codex configuration transaction target mismatch.');
  }
  const current = await readOwnedFile(journal.targetPath);
  if (!current || sha256(current) !== journal.installedSha256) {
    if (!current || !options.archiveChanges) {
      throw new Error(
        'Codex configuration changed during the run; transaction retained for manual recovery.'
      );
    }
    // The desktop app writes its own built-in servers and per-chat preferences.
    // Only the lifecycle owner, after stopping the app, may opt into archiving
    // those bytes. Never silently discard either user or host changes.
    const archivePath = `${journal.targetPath}.mst-runtime-${journal.transactionId}`;
    await writeFile(archivePath, current, { mode: 0o600, flag: 'wx' });
    process.stderr.write(
      `[mst:chatgpt] preserved runtime configuration at ${archivePath}\n`
    );
  }
  if (journal.originalPresent) {
    const original = await readOwnedFile(join(lock, 'original.toml'));
    if (!original || sha256(original) !== journal.originalSha256) {
      throw new Error('Codex original configuration is unavailable.');
    }
    await rename(join(lock, 'original.toml'), journal.targetPath);
    if (journal.originalMode !== null) {
      await chmod(journal.targetPath, journal.originalMode);
    }
  } else {
    await rm(journal.targetPath);
  }
  await rm(lock, { recursive: true, force: true });
}

export async function recoverCodexConfig(configPath: string): Promise<void> {
  const target = resolve(configPath);
  const lock = `${target}${LOCK_SUFFIX}`;
  await restoreCodexConfig(lock);
}

function renderStdioServer(
  server: Extract<CodexMcpServerConfig, { transport: 'stdio' }>
): string {
  const lines = [
    `[mcp_servers.${server.label}]`,
    `command = ${tomlString(server.command)}`,
    `args = ${tomlArray(server.args ?? [])}`,
  ];
  if (server.cwd !== undefined) lines.push(`cwd = ${tomlString(server.cwd)}`);
  if (server.env !== undefined) {
    const values = Object.entries(server.env).map(
      ([name, value]) => `${tomlString(name)} = ${tomlString(value)}`
    );
    lines.push(`env = { ${values.join(', ')} }`);
  }
  return lines.join('\n');
}

function renderHttpServer(
  server: Extract<CodexMcpServerConfig, { transport: 'http' }>
): string {
  const lines = [
    `[mcp_servers.${server.label}]`,
    `url = ${tomlString(server.url)}`,
  ];
  if (server.bearerTokenEnvVar !== undefined) {
    lines.push(
      `bearer_token_env_var = ${tomlString(server.bearerTokenEnvVar)}`
    );
  }
  return lines.join('\n');
}

function tomlString(value: string): string {
  return JSON.stringify(value);
}

function tomlArray(values: readonly string[]): string {
  return `[${values.map(tomlString).join(', ')}]`;
}

async function readJournal(path: string): Promise<CodexConfigJournal> {
  const value = JSON.parse(
    await readFile(path, 'utf8')
  ) as Partial<CodexConfigJournal>;
  if (
    value.version !== 1 ||
    value.phase !== 'installed' ||
    typeof value.targetPath !== 'string' ||
    typeof value.installedSha256 !== 'string' ||
    (value.originalPresent && typeof value.originalSha256 !== 'string') ||
    (value.originalPresent && typeof value.originalMode !== 'number')
  ) {
    throw new Error('Invalid Codex configuration transaction.');
  }
  return value as CodexConfigJournal;
}

async function readOwnedFile(path: string): Promise<Buffer | undefined> {
  try {
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const info = await handle.stat();
      if (
        !info.isFile() ||
        info.uid !== process.getuid?.() ||
        info.size > MAX_CONFIG_BYTES
      ) {
        throw new Error('Codex configuration must be a private regular file.');
      }
      return await handle.readFile();
    } finally {
      await handle.close();
    }
  } catch (error) {
    if (isMissing(error)) return undefined;
    throw error;
  }
}

async function assertSafeParent(path: string): Promise<void> {
  const info = await stat(path);
  if (!info.isDirectory() || info.uid !== process.getuid?.()) {
    throw new Error(
      'Codex configuration parent must be owned by the current user.'
    );
  }
}

function sha256(value: Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

function isMissing(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as NodeJS.ErrnoException).code === 'ENOENT'
  );
}
