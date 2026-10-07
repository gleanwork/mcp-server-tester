import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, mkdir, readFile, realpath, rm } from 'node:fs/promises';
import { release, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { z } from 'zod';

const exec = promisify(execFile);
const MAX_DOWNLOAD = 1024 * 1024 * 1024;
const VERSION = /^\d+\.\d+\.\d+$(?![\s\S])/;
const Update = z.object({
  version: z.string(),
  url: z.string(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  size: z.number().int().positive().max(MAX_DOWNLOAD),
});
const Feed = z.object({
  currentRelease: z.string(),
  releases: z.array(z.object({ version: z.string(), updateTo: Update })),
});

/**
 * The Claude Desktop version a session runs: `host.options.appVersion` when the
 * eval config pins one, otherwise whatever is installed. MST has no default pin.
 */
export function macCoworkAppVersion(
  appVersion: string | undefined,
  env: Record<string, string | undefined>
): string | undefined {
  if (env.MST_COWORK_APP_VERSION !== undefined)
    throw new Error(
      'MST_COWORK_APP_VERSION was removed; pin a version with host.options.appVersion in the eval config.'
    );
  if (appVersion === undefined) return undefined;
  if (!VERSION.test(appVersion))
    throw new Error(
      'Invalid host.options.appVersion; expected an exact x.y.z version.'
    );
  if (env.MST_COWORK_APP_PATH)
    throw new Error(
      'Set host.options.appVersion or MST_COWORK_APP_PATH, not both.'
    );
  return appVersion;
}

/** Only the exact release returned by Anthropic's bounded update feed is accepted. */
export function resolveMacCoworkRelease(value: unknown, version: string) {
  const feed = Feed.parse(value);
  const matches = feed.releases.filter((entry) => entry.version === version);
  if (feed.currentRelease !== version || matches.length !== 1)
    throw new Error('The requested Claude Desktop pin is unavailable.');
  const update = matches[0]!.updateTo;
  const url = new URL(update.url);
  if (
    update.version !== version ||
    url.origin !== 'https://downloads.claude.ai' ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !VERSION.test(version) ||
    !url.pathname.startsWith(`/releases/darwin/universal/${version}/`) ||
    !/^Claude-[a-f0-9]+\.zip$/.test(url.pathname.split('/').at(-1) ?? '') ||
    url.pathname.split('/').length !== 6
  )
    throw new Error('Invalid pinned Claude Desktop release metadata.');
  return update;
}

function nativeOptions(directory: string, timeout = 120_000) {
  return {
    cwd: directory,
    env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', TMPDIR: directory },
    timeout,
    maxBuffer: 64 * 1024,
  };
}

async function validateDirectoryPath(directory: string): Promise<void> {
  if (
    dirname(directory) !== (await realpath(tmpdir())) ||
    !/^mst-cowork-session-[a-f0-9-]{36}-app$/.test(
      directory.split('/').at(-1) ?? ''
    )
  )
    throw new Error('Invalid temporary Claude Desktop directory.');
}

/** Called only after the session lease is owned and all Claude instances are stopped. */
export async function removeMacCoworkApp(directory: string): Promise<void> {
  await validateDirectoryPath(directory);
  let info;
  try {
    info = await lstat(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  if (
    !info.isDirectory() ||
    info.isSymbolicLink() ||
    info.uid !== process.getuid?.() ||
    info.mode & 0o077
  )
    throw new Error(
      'Temporary Claude Desktop directory ownership changed; retained for recovery.'
    );
  await rm(directory, { recursive: true });
}

/** The bundle's `CFBundleShortVersionString`; throws unless it is `x.y.z`. */
export async function readMacCoworkAppVersion(app: string): Promise<string> {
  try {
    const { stdout } = await exec(
      '/usr/bin/plutil',
      [
        '-extract',
        'CFBundleShortVersionString',
        'raw',
        '-o',
        '-',
        join(app, 'Contents/Info.plist'),
      ],
      nativeOptions(dirname(app))
    );
    const version = stdout.trim();
    if (!VERSION.test(version)) throw new Error();
    return version;
  } catch {
    throw new Error('Unable to read the Claude Desktop version.');
  }
}

/** Throws unless the bundle is still exactly `version`. */
export async function verifyMacCoworkAppVersion(
  app: string,
  version: string
): Promise<void> {
  const actual = await readMacCoworkAppVersion(app).catch(() => undefined);
  if (actual !== version)
    throw new Error(
      `Claude Desktop ${version} could not be verified; refusing results from a changed bundle.`
    );
}

/** Acquire without executing the downloaded application or changing installed apps.
 * The caller journals directory before invoking this function and owns cleanup.
 */
export async function acquireMacCoworkApp(
  directory: string,
  version: string
): Promise<string> {
  if (process.platform !== 'darwin' || !VERSION.test(version))
    throw new Error(
      'Pinned Claude Desktop acquisition requires macOS and an exact version.'
    );
  await validateDirectoryPath(directory);
  await mkdir(directory, { mode: 0o700 });
  let phase = 'release lookup';
  try {
    const feed = new URL(
      'https://releases.claude.com/api/desktop/darwin/universal/squirrel/update'
    );
    feed.search = new URLSearchParams({
      version: '0.0.0',
      maxVersion: version,
      device_id: randomUUID(),
      os_version: release(),
    }).toString();
    const curl = async (
      url: string,
      output: string,
      limit: number,
      seconds: number
    ) => {
      // No redirects, ambient curl configuration, credentials, or latest fallback.
      await exec(
        '/usr/bin/curl',
        [
          '--disable',
          '--fail',
          '--silent',
          '--show-error',
          '--proto',
          '=https',
          '--connect-timeout',
          '30',
          '--max-time',
          String(seconds),
          '--max-filesize',
          String(limit),
          '--output',
          output,
          url,
        ],
        nativeOptions(directory, (seconds + 5) * 1000)
      );
    };
    const metadata = join(directory, 'release.json');
    await curl(feed.href, metadata, 1024 * 1024, 60);
    const update = resolveMacCoworkRelease(
      JSON.parse(await readFile(metadata, 'utf8')),
      version
    );
    phase = 'download';
    const archive = join(directory, 'Claude.zip');
    await curl(update.url, archive, update.size, 600);
    phase = 'checksum verification';
    if ((await lstat(archive)).size !== update.size) throw new Error();
    const hash = createHash('sha256');
    for await (const chunk of createReadStream(archive))
      hash.update(chunk as Buffer);
    if (hash.digest('hex') !== update.sha256) throw new Error();
    phase = 'extraction';
    const unpacked = join(directory, 'unpacked');
    await mkdir(unpacked, { mode: 0o700 });
    await exec(
      '/usr/bin/ditto',
      ['-x', '-k', archive, unpacked],
      nativeOptions(directory)
    );
    const app = join(unpacked, 'Claude.app');
    phase = 'signature verification';
    await exec(
      '/usr/bin/codesign',
      [
        '--verify',
        '--deep',
        '--strict',
        '-R',
        '=anchor apple generic and identifier "com.anthropic.claudefordesktop" and certificate leaf[subject.OU] = "Q6L2SF6YDW"',
        app,
      ],
      nativeOptions(directory)
    );
    phase = 'bundle version verification';
    await verifyMacCoworkAppVersion(app, version);
    await rm(archive);
    return app;
  } catch {
    // Never echo native output or response bodies into an eval result.
    throw new Error(
      `Unable to acquire Claude Desktop ${version}: ${phase} failed. No installed-app fallback was used.`
    );
  }
}
