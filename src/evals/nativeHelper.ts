import { execFile } from 'node:child_process';
import { rmSync } from 'node:fs';
import { chmod, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

/**
 * Native helpers: the small Swift programs that desktop clients compile and run
 * to control a macOS application. This module owns how a helper is built, what
 * environment it sees and how its output is bounded, so every client applies one
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
type NativeHelperEnvironment = 'minimal' | 'inherit';

interface NativeHelperRunOptions {
  environment: NativeHelperEnvironment;
  timeoutMs: number;
  /**
   * Written to the helper's stdin, so secrets never appear in process
   * arguments. When set, a failed write rejects the run even if the helper
   * exits cleanly. When unset, stdin is closed empty.
   */
  stdin?: string;
}

/**
 * A helper failed to build. The message says what to fix on the machine. It
 * comes from the compiler's output, which sees no caller credentials, so
 * callers may show it as is.
 */
export class NativeHelperBuildError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'NativeHelperBuildError';
  }
}

const COMMAND_LINE_TOOLS = '/Library/Developer/CommandLineTools';

/** Turns a failed `xcrun swiftc` into a message that says what to fix. */
function buildError(error: unknown): NativeHelperBuildError {
  const failure = error as {
    code?: unknown;
    killed?: unknown;
    signal?: unknown;
    stderr?: unknown;
  };
  const stderr = typeof failure?.stderr === 'string' ? failure.stderr : '';
  const prefix = "MST couldn't build its macOS helper.";
  let reason: string;
  if (/agreed to the Xcode .*license/i.test(stderr)) {
    reason =
      "The Xcode license hasn't been accepted. Run `sudo xcodebuild -license accept`, " +
      `or build with the Command Line Tools: set DEVELOPER_DIR=${COMMAND_LINE_TOOLS}.`;
  } else if (
    failure?.code === 'ENOENT' ||
    /invalid active developer path|unable to find utility "swiftc"/i.test(
      stderr
    )
  ) {
    reason =
      "The Xcode Command Line Tools aren't installed. Run `xcode-select --install`.";
  } else if (failure?.killed === true || typeof failure?.signal === 'string') {
    reason = `The build stopped after ${BUILD_TIMEOUT_MS / 1000} s or was killed.`;
  } else {
    const code =
      typeof failure?.code === 'string' || typeof failure?.code === 'number'
        ? String(failure.code)
        : 'unknown';
    const line = stderr
      .split('\n')
      .map((text) => text.trim())
      .filter(Boolean)
      .pop();
    reason = `swiftc failed (exit ${code})${line ? `: ${line.slice(0, 500)}` : '.'}`;
  }
  return new NativeHelperBuildError(`${prefix} ${reason}`, { cause: error });
}

/**
 * The toolchain `xcrun` uses, when the caller chose one. It selects Xcode or the
 * Command Line Tools and carries no credential.
 */
function developerDirectory(): { DEVELOPER_DIR?: string } {
  const value = process.env.DEVELOPER_DIR;
  return value && value.startsWith('/') ? { DEVELOPER_DIR: value } : {};
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
 * removed when the process exits. The build sees no caller credentials, only
 * `DEVELOPER_DIR` when it is set. A failed build rejects with a
 * {@link NativeHelperBuildError} after removing the scratch.
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
    try {
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
          env: { ...minimal, ...developerDirectory() },
          cwd: directory,
          timeout: BUILD_TIMEOUT_MS,
          maxBuffer: BUILD_OUTPUT_LIMIT,
        }
      );
    } catch (error) {
      throw buildError(error);
    }
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
