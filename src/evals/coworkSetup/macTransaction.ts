import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import {
  lstat,
  mkdir,
  open,
  readdir,
  rename,
  rmdir,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { z } from 'zod';
import type { EvalManifest } from '../evalManifest.js';
import { prepareCoworkMcpBundle } from './bundle.js';
import { createCoworkMcpPlan, resolveCoworkMcpHeaders } from './config.js';
import { resolveCoworkSetupConfig } from './options.js';

const ERROR = 'Unable to change Cowork configuration safely.';
const LOCK = '.mst-setup-lock';
const MARKER = '.mst-setup-marker';
const HELPER = 'inference-helper.sh';
const LIMIT = 1024 * 1024;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const HASH = /^[a-f0-9]{64}$/;
const MetadataSchema = z
  .object({
    appliedId: z.string().regex(UUID),
    entries: z.array(
      z.object({ id: z.string().regex(UUID), name: z.string() }).strict()
    ),
  })
  .passthrough();
const JournalSchema = z
  .object({
    version: z.literal(1),
    id: z.string().regex(UUID),
    nonce: z.string().regex(UUID),
    directory: z.string(),
    originalMeta: z.string(),
    originalHash: z.string().regex(HASH),
    installedHash: z.string().regex(HASH),
    profileHash: z.string().regex(HASH).nullable(),
    files: z.record(z.string(), z.string().regex(HASH)).nullable(),
    phase: z.enum(['preparing', 'ready', 'applied', 'restoring']),
  })
  .strict();
type Journal = z.infer<typeof JournalSchema>;

function fail(): never {
  throw new Error(ERROR);
}

function hash(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function jsonBytes(value: unknown): Buffer {
  return Buffer.from(JSON.stringify(value, null, 2) + '\n');
}

async function exists(file: string): Promise<boolean> {
  try {
    await lstat(file);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

async function checkDirectory(
  directory: string,
  privateOnly = false
): Promise<void> {
  const info = await lstat(directory);
  if (
    !info.isDirectory() ||
    info.isSymbolicLink() ||
    typeof process.getuid !== 'function' ||
    info.uid !== process.getuid() ||
    (info.mode & (privateOnly ? 0o077 : 0o022)) !== 0
  )
    fail();
}

/** Bounded fd reads: reject symlinks, special files, unsafe owners/modes and concurrent writes. */
async function readBytes(file: string, privateOnly = false): Promise<Buffer> {
  const fd = await open(
    file,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
  );
  try {
    const before = await fd.stat();
    if (
      !before.isFile() ||
      typeof process.getuid !== 'function' ||
      before.uid !== process.getuid() ||
      before.size > LIMIT ||
      (before.mode & (privateOnly ? 0o077 : 0o022)) !== 0
    )
      fail();
    const buffer = Buffer.alloc(LIMIT + 1);
    let length = 0;
    while (length < buffer.length) {
      const result = await fd.read(
        buffer,
        length,
        buffer.length - length,
        length
      );
      if (result.bytesRead === 0) break;
      length += result.bytesRead;
    }
    const after = await fd.stat();
    if (
      length > LIMIT ||
      length !== after.size ||
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      before.ctimeMs !== after.ctimeMs ||
      before.mode !== after.mode ||
      before.uid !== after.uid
    )
      fail();
    return buffer.subarray(0, length);
  } finally {
    await fd.close();
  }
}

function metadata(bytes: Buffer): z.infer<typeof MetadataSchema> {
  const result = MetadataSchema.parse(
    JSON.parse(bytes.toString('utf8')) as unknown
  );
  const ids = result.entries.map((entry) => entry.id.toLowerCase());
  if (
    new Set(ids).size !== ids.length ||
    !ids.includes(result.appliedId.toLowerCase())
  )
    fail();
  return result;
}

/** Ignore only JSON formatting whitespace outside strings, not values, key order,
 * duplicate keys, escapes, or other content. Claude may reserialize _meta.json.
 * File replacement still compares the exact bytes observed immediately before it.
 */
function metadataMatches(actual: Buffer, expected: Buffer): boolean {
  if (actual.equals(expected)) return true;
  metadata(actual);
  function compact(bytes: Buffer): string {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    let result = '';
    let quoted = false;
    let escaped = false;
    for (const character of text) {
      if (quoted) {
        result += character;
        if (escaped) escaped = false;
        else if (character === '\\') escaped = true;
        else if (character === '"') quoted = false;
      } else if (character === '"') {
        quoted = true;
        result += character;
      } else if (![' ', '\t', '\r', '\n'].includes(character)) {
        result += character;
      }
    }
    if (quoted || escaped) fail();
    return result;
  }
  return compact(actual) === compact(expected);
}

function installedMeta(journal: Journal): Buffer {
  const original = Buffer.from(journal.originalMeta, 'base64');
  if (hash(original) !== journal.originalHash) fail();
  const meta = metadata(original);
  if (
    meta.entries.some(
      (entry) => entry.id.toLowerCase() === journal.id.toLowerCase()
    )
  )
    fail();
  return jsonBytes({
    ...meta,
    appliedId: journal.id,
    entries: [...meta.entries, { id: journal.id, name: 'MST test' }],
  });
}

function validateStaging(directory: string, profileDirectory: string): void {
  createCoworkMcpPlan([], directory); // Canonical shell-safe command-path validation.
  if (
    !isAbsolute(directory) ||
    resolve(directory) !== directory ||
    directory === sep ||
    directory === profileDirectory ||
    directory.startsWith(profileDirectory + sep) ||
    profileDirectory.startsWith(directory + sep)
  )
    fail();
}

async function checkManaged(paths: string[]): Promise<void> {
  for (const file of paths) if (await exists(file)) fail();
}

async function atomicWrite(
  target: string,
  bytes: Buffer,
  lock: string
): Promise<void> {
  const temporary = join(lock, '.write-' + randomUUID());
  let created = false;
  try {
    const fd = await open(temporary, 'wx', 0o600);
    created = true;
    try {
      await fd.writeFile(bytes);
      await fd.sync();
    } finally {
      await fd.close();
    }
    await rename(temporary, target);
    created = false;
  } finally {
    if (created) await unlink(temporary);
  }
}

async function saveJournal(lock: string, journal: Journal): Promise<void> {
  await atomicWrite(join(lock, 'journal.json'), jsonBytes(journal), lock);
}

async function replaceMeta(
  profileDirectory: string,
  expected: Buffer,
  next: Buffer
): Promise<void> {
  const lock = join(profileDirectory, LOCK);
  const target = join(profileDirectory, '_meta.json');
  const temporary = join(lock, '.meta-' + randomUUID());
  let created = false;
  try {
    const fd = await open(temporary, 'wx', 0o600);
    created = true;
    try {
      await fd.writeFile(next);
      await fd.sync();
    } finally {
      await fd.close();
    }
    if (!(await readBytes(target)).equals(expected)) fail();
    await rename(temporary, target);
    created = false;
  } finally {
    if (created) await unlink(temporary);
  }
}

/** This script contains only a path; neither the script nor settings contain a key. */
function inferenceHelper(directory: string): string {
  return `#!/bin/sh
exec /usr/bin/python3 -I - <<'MST_INFERENCE_PY'
import json
import os
import re
import stat
import sys

PATH = ${JSON.stringify(join(directory, 'credentials', 'inference.json'))}
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

def validate(info):
    if (not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid()
            or info.st_mode & 0o077 or info.st_size > LIMIT):
        reject()

try:
    fd = os.open(PATH, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    try:
        before = os.fstat(fd)
        validate(before)
        content = bytearray()
        while len(content) <= LIMIT:
            chunk = os.read(fd, LIMIT + 1 - len(content))
            if not chunk:
                break
            content.extend(chunk)
        after = os.fstat(fd)
        validate(after)
        if (len(content) > LIMIT or len(content) != after.st_size
                or before.st_size != after.st_size
                or before.st_mtime_ns != after.st_mtime_ns
                or before.st_ctime_ns != after.st_ctime_ns):
            reject()
    finally:
        os.close(fd)
    data = json.loads(content.decode('utf-8'), object_pairs_hook=unique_object)
    if not isinstance(data, dict) or set(data) != {'ANTHROPIC_API_KEY'}:
        reject()
    token = data['ANTHROPIC_API_KEY']
    if not isinstance(token, str) or re.fullmatch(r'[A-Za-z0-9._~+/-]+=*', token) is None:
        reject()
except Exception:
    sys.stderr.write('Unable to read Cowork inference credential.\\n')
    sys.exit(1)
sys.stdout.write(token + '\\n')
MST_INFERENCE_PY
`;
}

function allowedFile(name: string): boolean {
  return (
    [
      MARKER,
      HELPER,
      'managed-mcp.json',
      'status.json',
      'credentials/inference.json',
    ].includes(name) ||
    /^mcp-[A-Za-z][A-Za-z0-9_-]{0,63}-headers\.sh$/.test(name) ||
    /^credentials\/[A-Za-z][A-Za-z0-9_-]{0,63}\.json$/.test(name)
  );
}

async function stageNames(directory: string): Promise<string[]> {
  await checkDirectory(directory, true);
  const names: string[] = [];
  for (const entry of await readdir(directory)) {
    if (entry === 'credentials') {
      await checkDirectory(join(directory, entry), true);
      for (const child of await readdir(join(directory, entry)))
        names.push(`${entry}/${child}`);
    } else {
      names.push(entry);
    }
  }
  if (names.some((name) => !allowedFile(name))) fail();
  return names.sort();
}

async function stageHashes(directory: string): Promise<Record<string, string>> {
  const entries: Array<[string, string]> = [];
  for (const name of await stageNames(directory)) {
    entries.push([name, hash(await readBytes(join(directory, name), true))]);
  }
  return Object.fromEntries(entries);
}

async function validateStage(
  journal: Journal,
  allowMissing: boolean
): Promise<boolean> {
  if (!(await exists(journal.directory))) {
    if (!allowMissing) fail();
    return false;
  }
  await checkDirectory(dirname(journal.directory));
  const files = journal.files;
  if (
    !files ||
    Object.keys(files).some((name) => !allowedFile(name)) ||
    files[MARKER] !== hash(Buffer.from(journal.nonce))
  )
    fail();
  if (
    !(await readBytes(join(journal.directory, MARKER), true)).equals(
      Buffer.from(journal.nonce)
    )
  )
    fail();
  const current = await stageHashes(journal.directory);
  for (const [name, digest] of Object.entries(current))
    if (files[name] !== digest) fail();
  if (
    !allowMissing &&
    Object.keys(files).some((name) => current[name] === undefined)
  )
    fail();
  return true;
}

async function removeLock(lock: string, journal: Journal): Promise<void> {
  // Unknown lock contents are never removed. Keep a recovery journal on failure.
  const names = await readdir(lock);
  if (names.length !== 1 || names[0] !== 'journal.json') fail();
  await unlink(join(lock, 'journal.json'));
  try {
    await rmdir(lock);
  } catch {
    await writeFile(join(lock, 'journal.json'), jsonBytes(journal), {
      mode: 0o600,
      flag: 'wx',
    });
    fail();
  }
}

async function restore(
  profileDirectory: string,
  journal: Journal
): Promise<void> {
  const lock = join(profileDirectory, LOCK);
  validateStaging(journal.directory, profileDirectory);
  const installed = installedMeta(journal);
  if (hash(installed) !== journal.installedHash) fail();
  const original = Buffer.from(journal.originalMeta, 'base64');
  const current = await readBytes(join(profileDirectory, '_meta.json'));
  const isInstalled = metadataMatches(current, installed);
  if (
    (!isInstalled && !metadataMatches(current, original)) ||
    (journal.phase === 'applied' && !isInstalled)
  )
    fail();
  const profile = join(profileDirectory, `${journal.id}.json`);
  const hasProfile = await exists(profile);
  if (
    hasProfile &&
    (!journal.profileHash ||
      hash(await readBytes(profile, true)) !== journal.profileHash)
  )
    fail();
  if ((isInstalled || journal.phase === 'applied') && !hasProfile) fail();

  if (journal.phase === 'preparing') {
    // The bundle may have failed its own cleanup. Without a marker+inventory,
    // ownership is uncertain: retain the lock rather than deleting that path.
    if (hasProfile || isInstalled || (await exists(journal.directory))) fail();
    await removeLock(lock, journal);
    return;
  }
  if (!journal.files || !journal.profileHash) fail();
  const stageExists = await validateStage(journal, journal.phase !== 'applied');
  if (stageExists && !hasProfile && journal.phase === 'restoring') fail();
  // An interrupted install can have staged files but no profile yet.
  if (hasProfile) journal.phase = 'restoring';
  await saveJournal(lock, journal);
  if (!current.equals(original))
    await replaceMeta(profileDirectory, current, original);
  if (stageExists) {
    // Never recursively delete. Verify all files first, then recheck each just
    // before unlink. Marker is last so partial cleanup remains recoverable.
    for (const name of Object.keys(journal.files).filter(
      (name) => name !== MARKER
    )) {
      const file = join(journal.directory, name);
      if (!(await exists(file))) continue;
      if (hash(await readBytes(file, true)) !== journal.files[name]) fail();
      await unlink(file);
    }
    if (await exists(join(journal.directory, 'credentials')))
      await rmdir(join(journal.directory, 'credentials'));
    const stageInfo = await lstat(journal.directory);
    await unlink(join(journal.directory, MARKER));
    try {
      await rmdir(journal.directory);
    } catch {
      // Keep the ownership marker retryable after a failed final rmdir. Never
      // write into a replacement directory or follow a replacement symlink.
      await checkDirectory(journal.directory, true);
      const after = await lstat(journal.directory);
      if (after.dev !== stageInfo.dev || after.ino !== stageInfo.ino) fail();
      await writeFile(join(journal.directory, MARKER), journal.nonce, {
        mode: 0o600,
        flag: 'wx',
      });
      fail();
    }
  }
  if (hasProfile) {
    if (hash(await readBytes(profile, true)) !== journal.profileHash) fail();
    await unlink(profile);
  }
  await removeLock(lock, journal);
}

/** Recover a transaction without retaining its original in-memory restore closure.
 * Parent directories must be trusted. The lock coordinates MST writers; external
 * applications do not honor it, so byte/hash CAS checks fail closed on changes.
 */
export async function restoreMacCoworkSettings(
  profileDirectory: string
): Promise<void> {
  await recover(profileDirectory);
}

async function recover(
  profileDirectory: string,
  expectedId?: string
): Promise<void> {
  try {
    const directory = resolve(profileDirectory);
    await checkDirectory(directory);
    const lock = join(directory, LOCK);
    await checkDirectory(lock, true);
    const journal = JournalSchema.parse(
      JSON.parse(
        (await readBytes(join(lock, 'journal.json'), true)).toString('utf8')
      ) as unknown
    );
    if (expectedId !== undefined && journal.id !== expectedId) fail();
    await restore(directory, journal);
  } catch {
    throw new Error(ERROR);
  }
}

type InstallOptions = {
  profileDirectory: string;
  stagingDirectory: string;
  manifest: EvalManifest;
  arm?: string;
  managedPreferencePaths: string[];
  /** Explicit runtime credentials only; never falls back to process.env. */
  env?: Record<string, string | undefined>;
};

async function validateInstall(options: InstallOptions) {
  const profileDirectory = resolve(options.profileDirectory);
  const directory = options.stagingDirectory;
  validateStaging(directory, profileDirectory);
  await checkDirectory(profileDirectory);
  await checkDirectory(dirname(directory));
  await checkManaged(options.managedPreferencePaths);
  if (await exists(join(profileDirectory, LOCK))) fail();
  if (await exists(directory)) fail();
  const env = { ...options.env };
  const key = Object.hasOwn(env, 'ANTHROPIC_API_KEY')
    ? env.ANTHROPIC_API_KEY
    : undefined;
  if (typeof key !== 'string' || !/^[A-Za-z0-9._~+/-]+=*$/.test(key)) fail();
  const inference = jsonBytes({ ANTHROPIC_API_KEY: key });
  if (inference.length > 64 * 1024) fail();
  const arms = options.manifest.arms ?? [];
  const arm = arms.find((candidate) => candidate.name === options.arm);
  if (
    new Set(arms.map((candidate) => candidate.name)).size !== arms.length ||
    (options.arm !== undefined && !arm)
  )
    fail();
  const servers = arm?.servers ?? options.manifest.servers;
  if (!servers) fail();
  const plan = createCoworkMcpPlan(
    servers,
    directory,
    resolveCoworkSetupConfig(options.manifest.coworkSetup, arm?.coworkSetup)
  );
  const headers = resolveCoworkMcpHeaders(servers, env);
  // macOS volumes are commonly case-insensitive. Reject helper/credential
  // collisions before a session stops the app, not during exclusive writes.
  const helperLabels = plan.servers
    .filter((server) => server.helperName)
    .map((server) => server.label.toLowerCase());
  if (new Set(helperLabels).size !== helperLabels.length) fail();
  for (const server of plan.servers) {
    if (!server.helperName) continue;
    if (
      server.label.toLowerCase() === 'inference' ||
      Buffer.byteLength(JSON.stringify(headers[server.label]) + '\n') >
        64 * 1024
    )
      fail();
  }
  const original = await readBytes(join(profileDirectory, '_meta.json'));
  const meta = metadata(original);
  const sourcePath = join(profileDirectory, `${meta.appliedId}.json`);
  const source = await readBytes(sourcePath);
  const sourceValue: unknown = JSON.parse(source.toString('utf8'));
  if (
    typeof sourceValue !== 'object' ||
    sourceValue === null ||
    Array.isArray(sourceValue) ||
    Object.keys(sourceValue).length !== 0
  )
    fail();
  return {
    profileDirectory,
    directory,
    env,
    inference,
    original,
    sourcePath,
    source,
  };
}

/** Read-only validation used before a session takes ownership or stops Desktop.
 * Install repeats these checks after app shutdown; this is not a reservation.
 */
export async function preflightMacCoworkSettings(
  options: InstallOptions
): Promise<void> {
  try {
    await validateInstall(options);
  } catch {
    throw new Error(ERROR);
  }
}

/** Install a new, private test profile, leaving the initially empty source intact.
 * This changes files only; it does not launch, authenticate, or verify Desktop.
 */
export async function installMacCoworkSettings(
  options: InstallOptions
): Promise<{
  id: string;
  directory: string;
  status: 'applied-not-verified';
  restore: () => Promise<void>;
}> {
  let lock: string | undefined;
  let journal: Journal | undefined;
  let journalSaved = false;
  let profileDirectory: string | undefined;
  try {
    const validated = await validateInstall(options);
    profileDirectory = validated.profileDirectory;
    const { directory, env, inference, original, sourcePath, source } =
      validated;
    const id = randomUUID();
    if (!UUID.test(id) || (await exists(join(profileDirectory, `${id}.json`))))
      fail();
    const nextLock = join(profileDirectory, LOCK);
    await mkdir(nextLock, { mode: 0o700 });
    lock = nextLock;
    journal = {
      version: 1,
      id,
      nonce: randomUUID(),
      directory,
      originalMeta: original.toString('base64'),
      originalHash: hash(original),
      installedHash: '0'.repeat(64),
      profileHash: null,
      files: null,
      phase: 'preparing',
    };
    journal.installedHash = hash(installedMeta(journal));
    await saveJournal(lock, journal);
    journalSaved = true;
    const bundle = await prepareCoworkMcpBundle({
      manifest: options.manifest,
      arm: options.arm,
      directory,
      runtimeDirectory: directory,
      env,
    });
    await writeFile(join(directory, MARKER), journal.nonce, {
      mode: 0o600,
      flag: 'wx',
    });
    const settings: unknown = JSON.parse(
      (await readBytes(bundle.settingsPath, true)).toString('utf8')
    );
    if (
      typeof settings !== 'object' ||
      settings === null ||
      Array.isArray(settings)
    )
      fail();
    const profile = jsonBytes({
      ...settings,
      inferenceProvider: 'anthropic',
      inferenceCredentialKind: 'helper-script',
      inferenceCredentialHelper: join(directory, HELPER),
    });
    journal.profileHash = hash(profile);
    journal.files = await stageHashes(directory);
    journal.phase = 'ready';
    await saveJournal(lock, journal);
    // Reserve inference.json; a conflicting MCP label fails without overwriting.
    if (Object.hasOwn(journal.files, 'credentials/inference.json')) fail();
    const helper = Buffer.from(inferenceHelper(directory));
    journal.files['credentials/inference.json'] = hash(inference);
    journal.files[HELPER] = hash(helper);
    await saveJournal(lock, journal);
    await writeFile(
      join(directory, 'credentials', 'inference.json'),
      inference,
      { mode: 0o600, flag: 'wx' }
    );
    await writeFile(join(directory, HELPER), helper, {
      mode: 0o700,
      flag: 'wx',
    });
    await writeFile(join(profileDirectory, `${id}.json`), profile, {
      mode: 0o600,
      flag: 'wx',
    });
    await checkManaged(options.managedPreferencePaths);
    if (!(await readBytes(sourcePath)).equals(source)) fail();
    await replaceMeta(profileDirectory, original, installedMeta(journal));
    journal.phase = 'applied';
    await saveJournal(lock, journal);
    const installedDirectory = profileDirectory;
    return {
      id,
      directory,
      status: 'applied-not-verified',
      restore: async () => recover(installedDirectory, id),
    };
  } catch {
    if (lock && profileDirectory) {
      try {
        if (journal && journalSaved) await restore(profileDirectory, journal);
        else await rmdir(lock);
      } catch {
        // Cleanup failure is a failure, never success. Preserve the lock and
        // journal for explicit recovery; never disclose the underlying error.
        throw new Error(ERROR);
      }
    }
    throw new Error(ERROR);
  }
}
