import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import {
  link,
  lstat,
  mkdir,
  open,
  realpath,
  rename,
  rmdir,
  unlink,
  type FileHandle,
} from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { z } from 'zod';
import type { MCPConfig } from '../../config/mcpConfig.js';
import {
  assertCodexProfileOwner,
  lockCodexProfileOperation,
  prepareCodexProfile,
  profileStateExists,
  saveCodexProfileOwner,
  type CodexProfile,
  type CodexProfileOwner,
} from './profile.js';

const MAX_CONFIG_BYTES = 128 * 1024;
const StdioBlock = z
  .object({
    transport: z.literal('stdio'),
    label: z.string().regex(/^[a-z][a-z0-9_]{0,63}$/),
    command: z.string().refine(isAbsolute),
    args: z.array(z.string()).optional(),
    cwd: z.string().refine(isAbsolute).optional(),
  })
  .strict();

type FixtureConfigPhase =
  | 'locked'
  | 'original-staged'
  | 'installed'
  | 'restore-started'
  | 'installed-staged'
  | 'temporary-archived'
  | 'restored';

interface FixtureConfigRecord {
  readonly version: 1;
  readonly transactionId: string;
  readonly phase: FixtureConfigPhase;
  readonly originalPresent: boolean;
  readonly originalSha256: string | null;
  readonly installedSha256: string;
}

interface TemporaryConfigIdentity {
  readonly sha256: string;
  readonly rewritten: boolean;
}

interface OpaqueOriginal {
  readonly handle: FileHandle;
  readonly dev: number;
  readonly ino: number;
  readonly mode: number;
  readonly size: number;
  readonly sha256: string;
}

interface InstalledIdentity {
  readonly dev: number;
  readonly ino: number;
}

export interface CodexFixtureInstallation {
  /** Call only after verified control settlement and clean owned app exit. */
  restore(): Promise<void>;
}

/** Intentionally narrow: exactly two nonsecret stdio fixtures and no policy. */
export function renderCodexFixtureBlocks(servers: MCPConfig[]): string {
  if (servers.length !== 2)
    throw new Error('Exactly two explicit MCP servers are required.');
  const labels = new Set<string>();
  const blocks = servers.map((server) => {
    const parsed = StdioBlock.safeParse(server);
    if (!parsed.success)
      throw new Error(
        'Unsupported MCP config; only nonsecret stdio blocks are allowed.'
      );
    const value = parsed.data;
    if (labels.has(value.label)) throw new Error('MCP server label collision.');
    labels.add(value.label);
    // Fixture argv is intentionally narrower than arbitrary stdio MCP config.
    if (
      (value.args ?? []).some((arg) => arg !== '--import' && !isAbsolute(arg))
    )
      throw new Error(
        'Unsupported fixture argument; only --import and absolute paths are allowed.'
      );
    for (const text of [
      value.command,
      value.cwd ?? '',
      ...(value.args ?? []),
    ]) {
      if (
        [...text].some(
          (char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127
        ) ||
        /[$`]|%[A-Za-z_][A-Za-z0-9_]*%|^~|(?:token|password|secret|authorization|api[_-]?key)\s*[=:]/i.test(
          text
        )
      )
        throw new Error('Secret or environment references are not supported.');
      if (
        /^--?(?:token|password|secret|authorization|api[_-]?key)$/i.test(text)
      )
        throw new Error('Credential arguments are not supported.');
    }
    return `[mcp_servers.${value.label}]\ncommand = ${JSON.stringify(value.command)}\nargs = ${JSON.stringify(value.args ?? [])}\n${value.cwd ? `cwd = ${JSON.stringify(value.cwd)}\n` : ''}`;
  });
  return `# Temporary owned desktop-eval MCP configuration\n${blocks.join('\n')}`;
}

/** Never decodes, parses, logs, or copies values from an existing config. */
export async function installCodexFixtureConfig(
  requested: CodexProfile,
  servers: MCPConfig[],
  owner?: CodexProfileOwner
): Promise<CodexFixtureInstallation> {
  const installedBytes = Buffer.from(renderCodexFixtureBlocks(servers), 'utf8');
  const installedSha256 = sha256(installedBytes);
  const profile = await prepareCodexProfile(requested.root);
  if (JSON.stringify(profile) !== JSON.stringify(requested))
    throw new Error('Codex profile identity mismatch.');
  const operation = await lockCodexProfileOperation(profile);
  try {
    await assertFixtureOperationAllowed(profile, owner);

    const transactionId = randomUUID();
    const lock = join(profile.root, '.fixture-config');
    const history = join(profile.root, '.fixture-config-history');
    const configPath = join(profile.paths.codex, 'config.toml');
    const originalPath = join(lock, 'original.toml');
    const stagedInstalledPath = join(lock, 'installed.toml');
    try {
      await mkdir(lock, { mode: 0o700 });
    } catch {
      throw new Error(
        'Fixture configuration is held or quarantined; it is never reclaimed automatically.'
      );
    }
    await syncDirectory(profile.root);
    if (owner) await saveCodexProfileOwner(lock, profile, owner);

    let original: OpaqueOriginal | null = null;
    let transactionStarted = false;
    let stateWritten = false;
    try {
      await assertPrivateDirectory(lock);
      original = await openOpaqueOriginal(configPath);
      let record: FixtureConfigRecord = {
        version: 1,
        transactionId,
        phase: 'locked',
        originalPresent: original !== null,
        originalSha256: original?.sha256 ?? null,
        installedSha256,
      };
      await saveState(lock, record);
      stateWritten = true;
      await assertFixtureOperationAllowed(profile, owner);

      if (original) {
        await rename(configPath, originalPath);
        transactionStarted = true;
        await syncDirectory(lock);
        await syncDirectory(profile.paths.codex);
        await verifyOpaqueOriginal(originalPath, original);
      }
      record = { ...record, phase: 'original-staged' };
      await saveState(lock, record);

      const installedIdentity = await writeFreshConfig(
        configPath,
        installedBytes,
        profile.paths.codex,
        () => {
          transactionStarted = true;
        }
      );
      await verifyInstalledConfig(
        configPath,
        installedBytes,
        installedIdentity
      );
      record = { ...record, phase: 'installed' };
      await saveState(lock, record);
      await verifyInstalledConfig(
        configPath,
        installedBytes,
        installedIdentity
      );
      await original?.handle.close();

      let restored = false;
      return {
        async restore() {
          if (restored) throw new Error('Fixture config was already restored.');
          const restoreOperation = await lockCodexProfileOperation(profile);
          try {
            await assertFixtureOperationAllowed(profile, owner);
            await assertPrivateDirectory(lock);
            if (owner) await assertCodexProfileOwner(lock, profile, owner);
            const temporary = await inspectTemporaryConfig(
              configPath,
              record.installedSha256,
              installedIdentity
            );
            if (record.originalPresent) {
              await verifyOpaqueOriginalPath(
                originalPath,
                record.originalSha256,
                original ?? undefined
              );
            }

            record = { ...record, phase: 'restore-started' };
            await saveState(lock, record);
            if (temporary.rewritten) {
              const archive = await reserveArchive(
                profile.root,
                history,
                transactionId,
                record.installedSha256,
                temporary.sha256
              );
              await rename(configPath, join(archive, 'temporary.toml'));
              await syncDirectory(archive);
              await syncDirectory(profile.paths.codex);
              await verifyArchivedTemporary(
                join(archive, 'temporary.toml'),
                temporary.sha256
              );
              record = { ...record, phase: 'temporary-archived' };
              await saveState(lock, record);
            } else if (record.originalPresent) {
              await link(configPath, stagedInstalledPath);
              await syncDirectory(lock);
              await unlink(configPath);
              await syncDirectory(profile.paths.codex);
              await verifyInstalledConfig(
                stagedInstalledPath,
                installedBytes,
                installedIdentity
              );
              record = { ...record, phase: 'installed-staged' };
              await saveState(lock, record);
            } else {
              await unlink(configPath);
              await syncDirectory(profile.paths.codex);
            }

            if (record.originalPresent) {
              await link(originalPath, configPath);
              await syncDirectory(profile.paths.codex);
              await unlink(originalPath);
              await syncDirectory(lock);
              await verifyOpaqueOriginalPath(
                configPath,
                record.originalSha256,
                original ?? undefined
              );
            }
            record = { ...record, phase: 'restored' };
            await saveState(lock, record);
            if (!temporary.rewritten && record.originalPresent) {
              await unlink(stagedInstalledPath);
              await syncDirectory(lock);
            }
            await unlink(join(lock, 'state.json'));
            await syncDirectory(lock);
            if (owner) {
              await unlink(join(lock, 'owner.json'));
              await syncDirectory(lock);
            }
            await rmdir(lock);
            await syncDirectory(profile.root);
            restored = true;
          } finally {
            await restoreOperation.release();
          }
        },
      };
    } catch (error) {
      await original?.handle.close().catch(() => {});
      if (!transactionStarted) {
        await discardUnusedLock(
          lock,
          profile.root,
          stateWritten,
          owner !== undefined
        ).catch(() => {});
      }
      throw error;
    }
  } finally {
    await operation.release();
  }
}

async function assertFixtureOperationAllowed(
  profile: CodexProfile,
  owner: CodexProfileOwner | undefined
): Promise<void> {
  if (await profileStateExists(join(profile.root, '.lease')))
    throw new Error('Codex profile is leased or quarantined.');
  const active = join(profile.root, '.host-active');
  if (await profileStateExists(active))
    await assertCodexProfileOwner(active, profile, owner);
}

async function assertPrivateDirectory(directory: string): Promise<void> {
  try {
    const info = await lstat(directory);
    if (
      !info.isDirectory() ||
      info.uid !== currentUid() ||
      (info.mode & 0o777) !== 0o700 ||
      (await realpath(directory)) !== directory
    )
      throw new Error('unsafe');
  } catch {
    throw new Error('Fixture lock must be private, owned, and canonical.');
  }
}

async function openOpaqueOriginal(
  path: string
): Promise<OpaqueOriginal | null> {
  let handle: FileHandle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    if (isMissing(error)) return null;
    throw new Error('Unsafe dedicated profile config.');
  }
  try {
    const info = await handle.stat();
    if (
      !info.isFile() ||
      info.uid !== currentUid() ||
      info.nlink !== 1 ||
      (info.mode & 0o077) !== 0 ||
      info.size > MAX_CONFIG_BYTES
    )
      throw new Error('Unsafe or oversized dedicated profile config.');
    const originalSha256 = await hashFile(handle);
    await handle.sync();
    return {
      handle,
      dev: info.dev,
      ino: info.ino,
      mode: info.mode & 0o777,
      size: info.size,
      sha256: originalSha256,
    };
  } catch (error) {
    await handle.close().catch(() => {});
    throw error;
  }
}

async function verifyOpaqueOriginal(
  path: string,
  original: OpaqueOriginal
): Promise<void> {
  await verifyOpaqueOriginalPath(path, original.sha256, original);
}

async function verifyOpaqueOriginalPath(
  path: string,
  expectedSha256: string | null,
  expectedIdentity: OpaqueOriginal | undefined
): Promise<void> {
  if (!expectedSha256)
    throw new Error('Original config transaction record is invalid.');
  let handle: FileHandle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch {
    throw new Error('Original config backup cannot be verified.');
  }
  try {
    const info = await handle.stat();
    if (
      !info.isFile() ||
      info.uid !== currentUid() ||
      info.nlink !== 1 ||
      (info.mode & 0o077) !== 0 ||
      info.size > MAX_CONFIG_BYTES ||
      (expectedIdentity !== undefined &&
        (info.dev !== expectedIdentity.dev ||
          info.ino !== expectedIdentity.ino ||
          (info.mode & 0o777) !== expectedIdentity.mode ||
          info.size !== expectedIdentity.size)) ||
      (await hashFile(handle)) !== expectedSha256
    )
      throw new Error('Original config backup cannot be verified.');
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function writeFreshConfig(
  path: string,
  bytes: Buffer,
  directory: string,
  onInstall: () => void
): Promise<InstalledIdentity> {
  const temporary = join(directory, `.fixture-${randomUUID()}.tmp`);
  const file = await open(temporary, 'wx', 0o600);
  let installed = false;
  try {
    await file.writeFile(bytes);
    await file.sync();
  } finally {
    await file.close();
  }
  try {
    // link() is an atomic no-replace install. It cannot overwrite a config
    // created after preflight, unlike rename() on POSIX.
    await link(temporary, path);
    installed = true;
    onInstall();
    await unlink(temporary);
    await syncDirectory(directory);
    const info = await lstat(path);
    return { dev: info.dev, ino: info.ino };
  } finally {
    if (!installed) await unlink(temporary).catch(() => {});
  }
}

async function verifyInstalledConfig(
  path: string,
  expected: Buffer,
  identity: InstalledIdentity
): Promise<void> {
  let handle: FileHandle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch {
    throw new Error(
      'Installed fixture config changed; transaction retained for quarantine.'
    );
  }
  try {
    const info = await handle.stat();
    const actual =
      info.size === expected.length ? await handle.readFile() : Buffer.alloc(0);
    if (
      !info.isFile() ||
      info.uid !== currentUid() ||
      info.nlink !== 1 ||
      (info.mode & 0o777) !== 0o600 ||
      info.dev !== identity.dev ||
      info.ino !== identity.ino ||
      !actual.equals(expected)
    )
      throw new Error(
        'Installed fixture config changed; transaction retained for quarantine.'
      );
  } finally {
    await handle.close();
  }
}

async function inspectTemporaryConfig(
  path: string,
  installedSha256: string,
  installedIdentity: InstalledIdentity
): Promise<TemporaryConfigIdentity> {
  let handle: FileHandle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch {
    throw new Error(
      'Temporary fixture config cannot be archived; transaction retained.'
    );
  }
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.uid !== currentUid() || info.nlink !== 1)
      throw new Error(
        'Temporary fixture config cannot be archived; transaction retained.'
      );
    const currentSha256 = await hashFile(handle);
    await handle.sync();
    return {
      sha256: currentSha256,
      rewritten:
        currentSha256 !== installedSha256 ||
        info.dev !== installedIdentity.dev ||
        info.ino !== installedIdentity.ino,
    };
  } finally {
    await handle.close();
  }
}

async function reserveArchive(
  root: string,
  history: string,
  transactionId: string,
  installedSha256: string,
  temporarySha256: string
): Promise<string> {
  try {
    await mkdir(history, { mode: 0o700 });
    await syncDirectory(root);
  } catch (error) {
    if (!isFileExists(error))
      throw new Error('Fixture config history cannot be prepared safely.');
  }
  await assertPrivateDirectory(history);

  const archive = join(history, transactionId);
  try {
    await mkdir(archive, { mode: 0o700 });
  } catch {
    throw new Error('Fixture config archive collision; nothing was replaced.');
  }
  await syncDirectory(history);
  await assertPrivateDirectory(archive);
  await saveArchiveMetadata(archive, {
    version: 1,
    installedSha256,
    temporarySha256,
  });
  return archive;
}

async function verifyArchivedTemporary(
  path: string,
  expectedSha256: string
): Promise<void> {
  let handle: FileHandle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch {
    throw new Error('Archived fixture config cannot be verified.');
  }
  try {
    const info = await handle.stat();
    if (
      !info.isFile() ||
      info.uid !== currentUid() ||
      info.nlink !== 1 ||
      (await hashFile(handle)) !== expectedSha256
    )
      throw new Error('Archived fixture config cannot be verified.');
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function hashFile(file: FileHandle): Promise<string> {
  const hash = createHash('sha256');
  const buffer = Buffer.allocUnsafe(64 * 1024);
  let position = 0;
  for (;;) {
    const { bytesRead } = await file.read(buffer, 0, buffer.length, position);
    if (bytesRead === 0) break;
    hash.update(buffer.subarray(0, bytesRead));
    position += bytesRead;
  }
  return hash.digest('hex');
}

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

async function saveState(
  lock: string,
  record: FixtureConfigRecord
): Promise<void> {
  await saveRecord(lock, 'state.json', `.state-${randomUUID()}.tmp`, record);
}

async function saveArchiveMetadata(
  archive: string,
  record: {
    readonly version: 1;
    readonly installedSha256: string;
    readonly temporarySha256: string;
  }
): Promise<void> {
  const temporary = join(archive, `.metadata-${randomUUID()}.tmp`);
  const metadata = join(archive, 'metadata.json');
  const file = await open(temporary, 'wx', 0o600);
  let installed = false;
  try {
    await file.writeFile(JSON.stringify(record));
    await file.sync();
  } finally {
    await file.close();
  }
  try {
    await link(temporary, metadata);
    installed = true;
    await unlink(temporary);
    await syncDirectory(archive);
  } catch {
    throw new Error('Fixture config archive metadata collision.');
  } finally {
    if (!installed) {
      await unlink(temporary).catch(() => {});
      await syncDirectory(archive).catch(() => {});
    }
  }
}

async function saveRecord(
  directory: string,
  name: string,
  temporaryName: string,
  record: object
): Promise<void> {
  const temporary = join(directory, temporaryName);
  const file = await open(temporary, 'wx', 0o600);
  try {
    await file.writeFile(JSON.stringify(record));
    await file.sync();
  } finally {
    await file.close();
  }
  await rename(temporary, join(directory, name));
  await syncDirectory(directory);
}

async function discardUnusedLock(
  lock: string,
  root: string,
  stateWritten: boolean,
  ownerWritten: boolean
): Promise<void> {
  if (stateWritten) {
    await unlink(join(lock, 'state.json'));
    await syncDirectory(lock);
  }
  if (ownerWritten) {
    await unlink(join(lock, 'owner.json'));
    await syncDirectory(lock);
  }
  await rmdir(lock);
  await syncDirectory(root);
}

async function syncDirectory(path: string): Promise<void> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    await file.sync();
  } finally {
    await file.close();
  }
}

function currentUid(): number {
  const uid = process.getuid?.();
  if (uid === undefined) throw new Error('File ownership cannot be verified.');
  return uid;
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}

function isFileExists(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'EEXIST';
}
