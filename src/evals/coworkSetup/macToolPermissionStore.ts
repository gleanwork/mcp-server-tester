import { createHash, randomUUID } from 'node:crypto';
import { constants, type Stats } from 'node:fs';
import {
  lstat,
  open,
  readdir,
  realpath,
  rename,
  unlink,
} from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';

const ERROR = 'Unable to manage Cowork tool permissions safely.';
const LIMIT = 1024 * 1024;
const UUID = '[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}';
const ACCOUNT = new RegExp(`^(?:[a-f0-9]{8}|${UUID})$(?![\\s\\S])`);
const SESSION = new RegExp(`^mst-cowork-session-${UUID}-mcp$(?![\\s\\S])`);
const TOOL =
  /^(?:local:)?([A-Za-z][A-Za-z0-9_-]{0,63}):([A-Za-z0-9_.-]{1,128})$(?![\s\S])/;
const APPROVAL_SUFFIX = /-[a-f0-9]{32}$(?![\s\S])/;
const UNSAFE = new Set(['__proto__', 'prototype', 'constructor']);
const FIELD = 'enabled_mcp_tools';
const Previous = z.discriminatedUnion('present', [
  z.object({ present: z.literal(false) }).strict(),
  z.object({ present: z.literal(true), value: z.boolean() }).strict(),
]);
const Journal = z
  .object({
    version: z.literal(1),
    target: z.string(),
    original: z.string(),
    originalHash: z.string().regex(/^[a-f0-9]{64}$/),
    mode: z
      .number()
      .int()
      .min(0)
      .max(0o777)
      .refine((mode) => !(mode & 0o022)),
    mapPresent: z.boolean(),
    previous: z.record(z.string(), Previous),
    grants: z.record(z.string(), z.literal(true)),
  })
  .strict();
type PermissionJournal = z.infer<typeof Journal>;
type Snapshot = { data: Buffer; info: Stats };
type Guard = { path: string; info: Stats; privateOnly: boolean };

function fail(): never {
  throw new Error(ERROR);
}
function hash(data: Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}
function json(data: Buffer): Record<string, unknown> {
  const value: unknown = JSON.parse(
    new TextDecoder('utf-8', { fatal: true }).decode(data),
    (key, value: unknown) => {
      if (UNSAFE.has(key)) fail();
      return value;
    }
  );
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail();
  return value as Record<string, unknown>;
}
function encode(value: unknown): Buffer {
  const data = Buffer.from(JSON.stringify(value, null, 2) + '\n');
  if (data.length > LIMIT) fail();
  return data;
}
function tools(value: Record<string, unknown>): Record<string, boolean> {
  if (!Object.hasOwn(value, FIELD)) return {};
  const map = value[FIELD];
  if (
    !map ||
    typeof map !== 'object' ||
    Array.isArray(map) ||
    Object.values(map).some((v) => typeof v !== 'boolean')
  )
    fail();
  return map as Record<string, boolean>;
}
function validateGrants(
  grants: Record<string, boolean>
): asserts grants is Record<string, true> {
  const prototype: unknown = grants ? Object.getPrototypeOf(grants) : undefined;
  if (
    !grants ||
    (prototype !== Object.prototype && prototype !== null) ||
    Reflect.ownKeys(grants).length !== Object.keys(grants).length
  )
    fail();
  for (const key of Object.keys(grants)) {
    const descriptor = Object.getOwnPropertyDescriptor(grants, key)!;
    // Parse the suffix first: tool names can themselves contain hyphens.
    const approval = APPROVAL_SUFFIX.exec(key);
    const enabledKey = approval ? key.slice(0, approval.index) : key;
    const match = TOOL.exec(enabledKey);
    if (
      descriptor.value !== true ||
      descriptor.get ||
      !match ||
      UNSAFE.has(match[1]!) ||
      UNSAFE.has(match[2]!)
    )
      fail();
    // A hash-specific permission must accompany its explicit unversioned tool.
    if (approval && !Object.hasOwn(grants, enabledKey)) fail();
  }
}
function safe(info: Stats, directory: boolean, privateOnly: boolean): void {
  if (
    (directory ? !info.isDirectory() : !info.isFile()) ||
    info.isSymbolicLink() ||
    info.uid !== process.getuid?.() ||
    info.mode & (privateOnly ? 0o7077 : 0o7022) ||
    (!directory && info.nlink !== 1)
  )
    fail();
}
function sameIdentity(a: Stats, b: Stats): boolean {
  return a.dev === b.dev && a.ino === b.ino;
}
function sameFile(a: Stats, b: Stats): boolean {
  return (
    sameIdentity(a, b) &&
    a.size === b.size &&
    a.mode === b.mode &&
    a.uid === b.uid &&
    a.nlink === b.nlink &&
    a.mtimeMs === b.mtimeMs &&
    a.ctimeMs === b.ctimeMs
  );
}
async function guard(path: string, privateOnly = false): Promise<Guard> {
  const info = await lstat(path);
  safe(info, true, privateOnly);
  if ((await realpath(path)) !== path) fail();
  return { path, info, privateOnly };
}
async function check(guards: Guard[]): Promise<void> {
  for (const saved of guards) {
    const current = await guard(saved.path, saved.privateOnly);
    if (!sameIdentity(current.info, saved.info)) fail();
  }
}
async function context(
  directory: string
): Promise<{ guards: Guard[]; root: string }> {
  if (
    resolve(directory) !== directory ||
    dirname(directory) !== (await realpath(tmpdir())) ||
    !SESSION.test(basename(directory))
  )
    fail();
  const guards = [await guard(directory, true)];
  let path = homedir();
  if (resolve(path) !== path) fail();
  guards.push(await guard(path));
  for (const component of [
    'Library',
    'Application Support',
    'Claude-3p',
    'local-agent-mode-sessions',
  ]) {
    path = join(path, component);
    guards.push(await guard(path));
  }
  return { guards, root: path };
}
async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}
/** Enumerate only account/org names; do not open settings until uniqueness is known. */
async function discover(root: string, guards: Guard[]): Promise<string> {
  const candidates: string[] = [];
  for (const account of await readdir(root)) {
    if (!ACCOUNT.test(account)) continue;
    const accountPath = join(root, account);
    guards.push(await guard(accountPath));
    for (const org of await readdir(accountPath)) {
      if (!ACCOUNT.test(org)) continue;
      const orgPath = join(accountPath, org);
      guards.push(await guard(orgPath));
      const target = join(orgPath, 'cowork_account_settings.json');
      if (await exists(target)) candidates.push(target);
    }
  }
  await check(guards);
  if (candidates.length !== 1) fail();
  return candidates[0]!;
}
async function read(
  path: string,
  guards: Guard[],
  privateOnly = false
): Promise<Snapshot> {
  await check(guards);
  const fd = await open(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
  );
  try {
    const info = await fd.stat();
    safe(info, false, privateOnly);
    if (info.size > LIMIT) fail();
    const buffer = Buffer.alloc(info.size + 1);
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
    if (
      count !== info.size ||
      !sameFile(info, await fd.stat()) ||
      !sameFile(info, await lstat(path))
    )
      fail();
    await check(guards);
    return { data: buffer.subarray(0, count), info };
  } finally {
    await fd.close();
  }
}
async function syncDirectory(path: string): Promise<void> {
  const fd = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    await fd.sync();
  } finally {
    await fd.close();
  }
}
/** The caller owns the session lease and stops Claude. Node has no rename CAS;
 * recheck both inode metadata and exact bytes immediately before replacement. */
async function replace(
  path: string,
  data: Buffer,
  mode: number,
  guards: Guard[],
  expected?: Snapshot
): Promise<void> {
  if (data.length > LIMIT) fail();
  await check(guards);
  const staged = join(dirname(path), `.mst-permissions-${randomUUID()}`);
  let created = false;
  try {
    const fd = await open(
      staged,
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        constants.O_NOFOLLOW,
      0o600
    );
    created = true;
    try {
      await fd.writeFile(data);
      await fd.chmod(mode);
      await fd.sync();
    } finally {
      await fd.close();
    }
    await check(guards);
    if (expected) {
      const current = await read(path, guards);
      if (
        !sameFile(current.info, expected.info) ||
        !current.data.equals(expected.data)
      )
        fail();
    } else if (await exists(path)) fail();
    await rename(staged, path);
    created = false;
    await syncDirectory(dirname(path));
    const written = await read(path, guards);
    if (!written.data.equals(data) || (written.info.mode & 0o777) !== mode)
      fail();
  } finally {
    if (created) {
      await check(guards);
      await unlink(staged);
    }
  }
}
function previous(
  map: Record<string, boolean>,
  key: string
): z.infer<typeof Previous> {
  return Object.hasOwn(map, key)
    ? { present: true, value: map[key]! }
    : { present: false };
}
function validateJournal(
  data: Buffer,
  target: string
): {
  journal: PermissionJournal;
  original: Buffer;
  value: Record<string, unknown>;
} {
  const journal = Journal.parse(json(data));
  validateGrants(journal.grants);
  const original = Buffer.from(journal.original, 'base64');
  if (
    journal.target !== target ||
    original.length > LIMIT ||
    original.toString('base64') !== journal.original ||
    hash(original) !== journal.originalHash
  )
    fail();
  const value = json(original);
  const map = tools(value);
  if (
    Object.hasOwn(value, FIELD) !== journal.mapPresent ||
    !isDeepStrictEqual(
      Object.keys(journal.previous).sort(),
      Object.keys(journal.grants).sort()
    )
  )
    fail();
  for (const key of Object.keys(journal.grants))
    if (!isDeepStrictEqual(journal.previous[key], previous(map, key))) fail();
  return { journal, original, value };
}

/** Claude 1.52386.6 3P connector defaults. Caller holds the session lease and
 * has stopped the app; this function neither inspects nor launches processes. */
export async function installMacToolPermissions(
  directory: string,
  grants: Record<string, boolean>
): Promise<void> {
  try {
    validateGrants(grants);
    const { guards, root } = await context(directory);
    const target = await discover(root, guards);
    const receipt = join(directory, 'permissions.json');
    if (await exists(receipt)) fail();
    const original = await read(target, guards);
    const value = json(original.data);
    const map = tools(value);
    const journal: PermissionJournal = {
      version: 1,
      target,
      original: original.data.toString('base64'),
      originalHash: hash(original.data),
      mode: original.info.mode & 0o777,
      mapPresent: Object.hasOwn(value, FIELD),
      previous: Object.fromEntries(
        Object.keys(grants).map((key) => [key, previous(map, key)])
      ),
      grants: { ...grants },
    };
    const installed = Object.keys(grants).length
      ? encode({ ...value, [FIELD]: { ...map, ...grants } })
      : original.data;
    const journalBytes = encode(journal);
    // No settings mutation occurs until the complete private journal is durable.
    await replace(receipt, journalBytes, 0o600, guards);
    await replace(target, installed, journal.mode, guards, original);
  } catch {
    throw new Error(ERROR);
  }
}

/** Recover either side of an interrupted install/restore. Unrelated Claude edits
 * survive; changed owned keys retain the journal and fail closed. */
export async function restoreMacToolPermissions(
  directory: string
): Promise<void> {
  try {
    const { guards, root } = await context(directory);
    const receipt = join(directory, 'permissions.json');
    if (!(await exists(receipt))) return;
    const saved = await read(receipt, guards, true);
    const target = await discover(root, guards);
    const { journal, original, value } = validateJournal(saved.data, target);
    const current = await read(target, guards);
    const restored = json(current.data);
    const map = { ...tools(restored) };
    for (const [key, expected] of Object.entries(journal.grants)) {
      const old = journal.previous[key]!;
      const now = previous(map, key);
      if (
        !(now.present && now.value === expected) &&
        !isDeepStrictEqual(now, old)
      )
        fail();
      if (old.present) map[key] = old.value;
      else delete map[key];
    }
    if (Object.keys(map).length || journal.mapPresent) restored[FIELD] = map;
    else delete restored[FIELD];
    const unchanged = isDeepStrictEqual(restored, value);
    const bytes = unchanged ? original : encode(restored);
    const mode = unchanged ? journal.mode : current.info.mode & 0o777;
    await replace(target, bytes, mode, guards, current);
    const after = await read(receipt, guards, true);
    if (!sameFile(after.info, saved.info) || !after.data.equals(saved.data))
      fail();
    // Verify settings once more before discarding the sole recovery receipt.
    const verified = await read(target, guards);
    if (!verified.data.equals(bytes) || (verified.info.mode & 0o777) !== mode)
      fail();
    await unlink(receipt);
    await syncDirectory(directory);
  } catch {
    throw new Error(ERROR);
  }
}
