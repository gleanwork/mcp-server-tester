/**
 * The client app a trial ran on, as `clientTelemetry.clientApp` records it:
 * what the client observed, so a run says which app version produced it.
 * History and the report list it (`clientApps`).
 */
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';

const exec = promisify(execFile);

/** A client app and the version that ran. */
export interface ClientApp {
  name: string;
  version: string;
  /**
   * `pinned`: the eval config chose the version; `installed`: the one on the
   * machine, or the one the client reported running.
   */
  source: 'installed' | 'pinned';
}

/** A version or name as a client reports it: short, with no control characters. */
const SAFE = /^[\w .:+~()-]{1,64}$/;

/** The app, or undefined when its name or version isn't a plain short string. */
export function clientApp(
  name: unknown,
  version: unknown,
  source: ClientApp['source'] = 'installed'
): ClientApp | undefined {
  if (typeof name !== 'string' || typeof version !== 'string') return undefined;
  if (!SAFE.test(name) || !SAFE.test(version)) return undefined;
  return { name, version, source };
}

/** `{ clientApp }` to spread into a trial's telemetry, or nothing. */
export function withClientApp(app: ClientApp | undefined): {
  clientApp?: ClientApp;
} {
  return app ? { clientApp: app } : {};
}

/**
 * A Debian package's installed version, from dpkg's status file (the
 * `Package:` stanza whose `Status:` says installed). Undefined when it isn't
 * installed.
 */
export function installedDebVersion(
  status: string,
  name: string
): string | undefined {
  for (const stanza of status.split(/\n\s*\n/)) {
    const field = (key: string) =>
      new RegExp(`^${key}: (.+)$`, 'm').exec(stanza)?.[1]?.trim();
    if (field('Package') !== name) continue;
    if (!/\binstalled$/.test(field('Status') ?? '')) continue;
    return field('Version');
  }
  return undefined;
}

/** The installed Debian package `name`, as the app `label`; undefined when it isn't. */
export async function installedDebApp(
  name: string,
  label: string,
  statusFile = '/var/lib/dpkg/status'
): Promise<ClientApp | undefined> {
  try {
    const version = installedDebVersion(
      await readFile(statusFile, 'utf8'),
      name
    );
    return clientApp(label, version, 'installed');
  } catch {
    return undefined;
  }
}

/**
 * A macOS app bundle's name and version (`CFBundleName`,
 * `CFBundleShortVersionString`); undefined when its Info.plist can't be read.
 */
export async function macAppBundle(
  appPath: string
): Promise<ClientApp | undefined> {
  const plist = join(appPath, 'Contents', 'Info.plist');
  const key = async (name: string) =>
    (
      await exec(
        '/usr/bin/plutil',
        ['-extract', name, 'raw', '-o', '-', plist],
        {
          timeout: 10_000,
        }
      )
    ).stdout.trim();
  try {
    return clientApp(
      await key('CFBundleName'),
      await key('CFBundleShortVersionString'),
      'installed'
    );
  } catch {
    return undefined;
  }
}
