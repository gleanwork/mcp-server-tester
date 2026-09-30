import { execFile } from 'node:child_process';
import { rmSync } from 'node:fs';
import { chmod, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

/**
 * Native helpers: the small Swift programs that desktop hosts compile and run
 * to control a macOS application. This module owns how a helper is built, what
 * environment it sees and how its output is bounded, so every host applies one
 * policy. Receipt schemas and error wording stay with each controller.
 *
 * The Linux Python helpers do not use this module: Cowork's is one execFile
 * call and ChatGPT's is a streaming request/response protocol.
 */

const exec = promisify(execFile);

/** The only search path a helper is built with, or run with under `'minimal'`. */
const SYSTEM_PATH = '/usr/bin:/bin:/usr/sbin:/sbin';
const BUILD_TIMEOUT_MS = 120_000;
const BUILD_OUTPUT_LIMIT = 64 * 1024;
const RUN_OUTPUT_LIMIT = 16 * 1024;

/**
 * The environment a helper runs with.
 *
 * - `'minimal'`: the system `PATH` and the helper's private `TMPDIR`, with no
 *   caller credentials. Use this unless the helper launches an application that
 *   needs the caller's environment.
 * - `'inherit'`: the test process's environment. The helper, and any application
 *   it launches, can read every variable the test run has, credentials included.
 */
export type NativeHelperEnvironment = 'minimal' | 'inherit';

export interface NativeHelperRunOptions {
  environment: NativeHelperEnvironment;
  timeoutMs: number;
  /**
   * Written to the helper's stdin, so secrets never appear in process
   * arguments. When set, a failed write rejects the run even if the helper
   * exits cleanly. When unset, stdin is closed empty.
   */
  stdin?: string;
}

export interface NativeHelper {
  /**
   * Runs the helper and returns its parsed JSON receipt. Rejects with the raw
   * process error, which carries `code`, `signal` and `stderr`; callers must
   * not echo its message, which can include the arguments.
   */
  run(args: string[], options: NativeHelperRunOptions): Promise<unknown>;
}

/**
 * Compiles a Swift helper into a private, owner-only scratch directory that is
 * removed when the process exits. The build sees no caller credentials. Rejects
 * with the raw build error after removing the scratch.
 */
export async function compileSwiftHelper(options: {
  /** A short name for the scratch directory (`mst-<name>-...`). */
  name: string;
  source: string;
}): Promise<NativeHelper> {
  if (!/^[a-z][a-z-]*$/.test(options.name)) {
    throw new Error(
      'A native helper name must be lowercase letters and dashes.'
    );
  }
  let directory: string | undefined;
  try {
    directory = await mkdtemp(join(tmpdir(), `mst-${options.name}-`));
    directory = await realpath(directory);
    await chmod(directory, 0o700);
    const source = join(directory, 'controller.swift');
    const binary = join(directory, 'controller');
    await writeFile(source, options.source, { mode: 0o600, flag: 'wx' });
    const minimal = { PATH: SYSTEM_PATH, TMPDIR: directory };
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
      {
        env: minimal,
        cwd: directory,
        timeout: BUILD_TIMEOUT_MS,
        maxBuffer: BUILD_OUTPUT_LIMIT,
      }
    );
    await chmod(binary, 0o700);
    const ownedDirectory = directory;
    // The private, noncredential scratch is removed on normal process exit;
    // never install artifacts into the repo.
    process.once('exit', () => {
      try {
        rmSync(ownedDirectory, { recursive: true, force: true });
      } catch {
        /* best effort */
      }
    });
    return {
      async run(args, runOptions) {
        const pending = exec(binary, args, {
          env: runOptions.environment === 'minimal' ? minimal : process.env,
          cwd: ownedDirectory,
          timeout: runOptions.timeoutMs,
          maxBuffer: RUN_OUTPUT_LIMIT,
        });
        let stdinError: Error | undefined;
        pending.child.stdin?.on('error', (error) => {
          stdinError = error;
        });
        pending.child.stdin?.end(runOptions.stdin ?? '');
        const { stdout } = await pending;
        // A helper that exits cleanly without reading its input has not
        // received what the caller sent.
        if (stdinError && runOptions.stdin !== undefined) throw stdinError;
        return JSON.parse(stdout) as unknown;
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
    throw error;
  }
}
