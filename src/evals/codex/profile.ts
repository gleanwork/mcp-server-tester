import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import {
  lstat,
  mkdir,
  open,
  realpath,
  rename,
  rmdir,
  unlink,
} from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';

export interface CodexProfile {
  readonly root: string;
  readonly id: string;
  readonly paths: Readonly<{
    home: string;
    codex: string;
    electron: string;
    config: string;
    cache: string;
    data: string;
    state: string;
    runtime: string;
    temp: string;
    workspace: string;
  }>;
}

const profileOwnerBrand: unique symbol = Symbol('CodexProfileOwner');

/** Opaque authority for one reserved host lifecycle. */
export interface CodexProfileOwner {
  readonly profileId: string;
  readonly ownerId: string;
  readonly [profileOwnerBrand]: true;
}

export function createCodexProfileOwner(
  profile: CodexProfile
): CodexProfileOwner {
  return Object.freeze({
    profileId: profile.id,
    ownerId: randomUUID(),
    [profileOwnerBrand]: true as const,
  });
}

/** Creates or reopens our own profile. Never imports or reads auth or app config. */
export async function prepareCodexProfile(
  profilePath: string
): Promise<CodexProfile> {
  if (!isAbsolute(profilePath))
    throw new Error('Profile path must be absolute.');
  const requested = resolve(profilePath);
  const root = join(await realpath(dirname(requested)), basename(requested));
  let fresh = true;
  try {
    await mkdir(root, { mode: 0o700 });
  } catch (error) {
    if (!isFileExists(error)) throw error;
    fresh = false;
  }
  let id: string = randomUUID();
  await assertPrivateDirectory(root);
  if (!fresh) {
    const marker = await readOwnerMarker(root);
    if (
      marker.kind !== 'codex-desktop-profile' ||
      marker.version !== 1 ||
      marker.root !== root ||
      marker.uid !== process.getuid?.() ||
      typeof marker.id !== 'string' ||
      !/^[a-f0-9-]{36}$/.test(marker.id)
    )
      throw new Error('Invalid Codex profile ownership marker.');
    id = marker.id;
  }
  const profile: CodexProfile = {
    root,
    id,
    paths: {
      home: join(root, 'home'),
      codex: join(root, 'codex'),
      electron: join(root, 'electron'),
      config: join(root, 'xdg-config'),
      cache: join(root, 'xdg-cache'),
      data: join(root, 'xdg-data'),
      state: join(root, 'xdg-state'),
      runtime: join(root, 'xdg-runtime'),
      temp: join(root, 'tmp'),
      workspace: join(root, 'workspace'),
    },
  };
  if (fresh) {
    for (const directory of Object.values(profile.paths)) {
      await mkdir(directory, { mode: 0o700 });
    }
    const marker = await open(join(root, '.owner.json'), 'wx', 0o600);
    try {
      await marker.writeFile(
        JSON.stringify({
          kind: 'codex-desktop-profile',
          version: 1,
          id: profile.id,
          root,
          uid: process.getuid?.(),
        })
      );
      await marker.sync();
    } finally {
      await marker.close();
    }
    await syncDirectory(root);
  }
  for (const directory of Object.values(profile.paths)) {
    await assertPrivateDirectory(directory);
  }
  return profile;
}

async function assertPrivateDirectory(directory: string): Promise<void> {
  try {
    const info = await lstat(directory);
    if (
      !info.isDirectory() ||
      info.uid !== process.getuid?.() ||
      (info.mode & 0o777) !== 0o700 ||
      (await realpath(directory)) !== directory
    ) {
      throw new Error('unsafe');
    }
  } catch {
    throw new Error(
      'Codex profile directories must be private, owned, and canonical.'
    );
  }
}

async function readOwnerMarker(root: string): Promise<Record<string, unknown>> {
  try {
    const file = await open(
      join(root, '.owner.json'),
      constants.O_RDONLY | constants.O_NOFOLLOW
    );
    try {
      const info = await file.stat();
      if (
        !info.isFile() ||
        info.uid !== process.getuid?.() ||
        info.nlink !== 1 ||
        (info.mode & 0o777) !== 0o600 ||
        info.size > 8192
      )
        throw new Error('unsafe');
      const marker: unknown = JSON.parse(await file.readFile('utf8'));
      if (!marker || typeof marker !== 'object' || Array.isArray(marker))
        throw new Error('invalid');
      return marker as Record<string, unknown>;
    } finally {
      await file.close();
    }
  } catch {
    throw new Error('Invalid Codex profile ownership marker.');
  }
}

function isFileExists(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'EEXIST';
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}

export async function profileStateExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (isMissing(error)) return false;
    throw new Error('Cannot verify Codex profile state.');
  }
}

/** A stale operation guard is quarantined and never reclaimed automatically. */
export async function lockCodexProfileOperation(profile: CodexProfile) {
  const directory = join(profile.root, '.profile-operation');
  try {
    await mkdir(directory, { mode: 0o700 });
  } catch (error) {
    if (isFileExists(error))
      throw new Error('Codex profile operation is active or quarantined.');
    throw error;
  }
  await syncDirectory(profile.root);
  let released = false;
  return {
    async release() {
      if (released)
        throw new Error('Codex profile operation already released.');
      await rmdir(directory);
      await syncDirectory(profile.root);
      released = true;
    },
  };
}

export async function saveCodexProfileOwner(
  directory: string,
  profile: CodexProfile,
  owner: CodexProfileOwner
): Promise<void> {
  assertOwner(profile, owner);
  await saveRecord(directory, 'owner.json', {
    version: 1,
    profileId: owner.profileId,
    ownerId: owner.ownerId,
  });
}

export async function assertCodexProfileOwner(
  directory: string,
  profile: CodexProfile,
  owner: CodexProfileOwner | undefined
): Promise<void> {
  if (!owner) throw new Error('Conflicting Codex profile state.');
  assertOwner(profile, owner);
  try {
    const file = await open(
      join(directory, 'owner.json'),
      constants.O_RDONLY | constants.O_NOFOLLOW
    );
    try {
      const info = await file.stat();
      if (
        !info.isFile() ||
        info.uid !== process.getuid?.() ||
        info.nlink !== 1 ||
        (info.mode & 0o777) !== 0o600 ||
        info.size > 8192
      )
        throw new Error('unsafe');
      const record: unknown = JSON.parse(await file.readFile('utf8'));
      if (
        !record ||
        typeof record !== 'object' ||
        Array.isArray(record) ||
        (record as Record<string, unknown>).version !== 1 ||
        (record as Record<string, unknown>).profileId !== owner.profileId ||
        (record as Record<string, unknown>).ownerId !== owner.ownerId
      )
        throw new Error('invalid');
    } finally {
      await file.close();
    }
  } catch {
    throw new Error('Conflicting or quarantined Codex profile state.');
  }
}

function assertOwner(profile: CodexProfile, owner: CodexProfileOwner): void {
  if (
    owner[profileOwnerBrand] !== true ||
    owner.profileId !== profile.id ||
    !/^[a-f0-9-]{36}$/.test(owner.ownerId)
  )
    throw new Error('Codex profile owner mismatch.');
}

/** A leftover lease is never reclaimed automatically, including after a crash. */
export async function leaseCodexProfile(
  profile: CodexProfile,
  executablePath: string,
  owner?: CodexProfileOwner
) {
  const operation = await lockCodexProfileOperation(profile);
  try {
    for (const name of ['.host-active', '.fixture-config']) {
      const state = join(profile.root, name);
      if (await profileStateExists(state))
        await assertCodexProfileOwner(state, profile, owner);
    }
    const directory = join(profile.root, '.lease');
    try {
      await mkdir(directory, { mode: 0o700 });
    } catch (error) {
      if (isFileExists(error))
        throw new Error('Codex profile is leased or quarantined.');
      throw error;
    }
    // Persist the lease's parent entry before any app can be spawned.
    await syncDirectory(profile.root);
    const record = {
      profileId: profile.id,
      leaseId: randomUUID(),
      ownerPid: process.pid,
      executablePath,
      appPid: null as number | null,
      status: 'launching' as
        | 'launching'
        | 'running'
        | 'exited'
        | 'quarantined'
        | 'not-launched',
    };
    await saveRecord(directory, 'status.json', record);
    return {
      async running(appPid: number) {
        record.appPid = appPid;
        record.status = 'running';
        await saveRecord(directory, 'status.json', record);
      },
      async quarantine() {
        record.status = 'quarantined';
        await saveRecord(directory, 'status.json', record);
      },
      async release(status: 'exited' | 'not-launched' = 'exited') {
        record.status = status;
        await saveRecord(profile.root, '.last-launch.json', record);
        await unlink(join(directory, 'status.json'));
        await rmdir(directory);
        await syncDirectory(profile.root);
      },
    };
  } finally {
    await operation.release();
  }
}

async function saveRecord(
  directory: string,
  name: string,
  record: object
): Promise<void> {
  await assertPrivateDirectory(directory);
  const temporary = join(directory, `.record-${randomUUID()}.tmp`);
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

async function syncDirectory(directory: string): Promise<void> {
  const file = await open(directory, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    await file.sync();
  } finally {
    await file.close();
  }
}
