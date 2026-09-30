import { execFile } from 'node:child_process';
import { rmSync } from 'node:fs';
import { chmod, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { z } from 'zod';
import { macCoworkControllerSource } from './macControllerSource.js';

const ERROR = 'Unable to control the Mac Cowork application safely.';
const exec = promisify(execFile);
const StateSchema = z.object({
  running: z.boolean(),
  instances: z.number().int().min(0).max(1),
  workspaceApplicationCount: z.number().int().positive(),
  claudeBundleReadable: z.literal(true),
  runningAppPath: z.string().optional(),
});

/** Application lifecycle only: no native MCP inventory or query interface. */
export interface MacCoworkController {
  state(): Promise<{ running: boolean; runningAppPath?: string }>;
  stop(): Promise<void>;
  start(): Promise<void>;
}

const compiled = new Map<string, Promise<MacCoworkController>>();

function configuredAppPath(
  value = process.env.MST_COWORK_APP_PATH ?? '/Applications/Claude.app'
): string {
  if (
    !value.startsWith('/') ||
    value.includes('\0') ||
    value.includes('\n') ||
    value.includes('\r')
  )
    throw new Error(ERROR);
  return value;
}

async function compile(appPath: string): Promise<MacCoworkController> {
  let directory: string | undefined;
  try {
    directory = await realpath(
      await mkdtemp(join(tmpdir(), 'mst-cowork-native-'))
    );
    await chmod(directory, 0o700);
    const source = join(directory, 'controller.swift');
    const binary = join(directory, 'controller');
    await writeFile(source, macCoworkControllerSource(appPath), {
      mode: 0o600,
      flag: 'wx',
    });
    // Do not forward caller credentials or probe ambient credential sources.
    const env = { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', TMPDIR: directory };
    await exec(
      '/usr/bin/xcrun',
      [
        'swiftc',
        source,
        '-o',
        binary,
        '-module-cache-path',
        join(directory, 'module-cache'),
      ],
      { env, cwd: directory, timeout: 120_000, maxBuffer: 64 * 1024 }
    );
    await chmod(binary, 0o700);
    const ownedDirectory = directory;
    // One compiled helper per process. Its private, noncredential scratch is
    // removed on normal process exit; never install artifacts into the repo.
    process.once('exit', () => {
      try {
        rmSync(ownedDirectory, { recursive: true, force: true });
      } catch {
        /* best effort */
      }
    });
    const invoke = async (
      action: 'state' | 'stop' | 'start'
    ): Promise<unknown> => {
      try {
        const { stdout } = await exec(binary, [action], {
          env,
          cwd: ownedDirectory,
          timeout: 30_000,
          maxBuffer: 16 * 1024,
        });
        return JSON.parse(stdout) as unknown;
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code ?? 'unknown';
        throw new Error(`${ERROR} Native ${action} failed (${code}).`);
      }
    };
    return {
      async state() {
        try {
          const state = StateSchema.parse(await invoke('state'));
          if (state.running !== (state.instances === 1)) throw new Error();
          return {
            running: state.running,
            ...(state.runningAppPath
              ? { runningAppPath: configuredAppPath(state.runningAppPath) }
              : {}),
          };
        } catch (error) {
          throw new Error(
            `${ERROR} State check failed: ${error instanceof Error ? error.message : 'unknown'}`
          );
        }
      },
      async stop() {
        try {
          z.object({ stopped: z.literal(true) }).parse(await invoke('stop'));
        } catch {
          throw new Error(ERROR);
        }
      },
      async start() {
        try {
          z.object({ launched: z.literal(true) }).parse(await invoke('start'));
        } catch {
          throw new Error(ERROR);
        }
      },
    };
  } catch (error) {
    if (directory) {
      try {
        await rm(directory, { recursive: true, force: true });
      } catch {
        /* best effort */
      }
    }
    const code = (error as NodeJS.ErrnoException).code ?? 'unknown';
    throw new Error(`${ERROR} Native controller build failed (${code}).`);
  }
}

/** Small module seam for lifecycle tests; never invoke native tools off macOS. */
export async function getMacCoworkController(
  appPath?: string
): Promise<MacCoworkController> {
  if (process.platform !== 'darwin') throw new Error(ERROR);
  const path = configuredAppPath(appPath);
  let controller = compiled.get(path);
  if (!controller) {
    controller = compile(path).catch(() => {
      compiled.delete(path);
      throw new Error(ERROR);
    });
    compiled.set(path, controller);
  }
  return controller;
}
