import { execFile } from 'node:child_process';
import { rmSync } from 'node:fs';
import { chmod, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { z } from 'zod';
import { CHATGPT_CONTROLLER_SOURCE } from './chatgptControllerSource.js';

const exec = promisify(execFile);
const ERROR = 'Unable to control the ChatGPT desktop application safely.';
const StateSchema = z.object({
  running: z.boolean(),
  instances: z.number().int().min(0).max(1),
});

export interface ChatgptApplicationOptions {
  bundleId?: string;
  appPath?: string;
}

export interface ChatgptApplicationController {
  state(): Promise<{ running: boolean }>;
  stop(): Promise<void>;
  start(environment?: Record<string, string>): Promise<void>;
}

const controllers = new Map<string, Promise<ChatgptApplicationController>>();

export async function getChatgptApplicationController(
  options: ChatgptApplicationOptions = {}
): Promise<ChatgptApplicationController> {
  if (process.platform !== 'darwin') throw new Error(ERROR);
  const bundleId = options.bundleId ?? 'com.openai.codex';
  const appPath = resolve(options.appPath ?? '/Applications/ChatGPT.app');
  const key = JSON.stringify([bundleId, appPath]);
  let controller = controllers.get(key);
  if (!controller) {
    controller = compile(bundleId, appPath).catch((error) => {
      controllers.delete(key);
      throw error;
    });
    controllers.set(key, controller);
  }
  return controller;
}

async function compile(
  bundleId: string,
  appPath: string
): Promise<ChatgptApplicationController> {
  let directory: string | undefined;
  try {
    directory = await realpath(await mkdtemp(join(tmpdir(), 'mst-chatgpt-')));
    await chmod(directory, 0o700);
    const source = join(directory, 'controller.swift');
    const binary = join(directory, 'controller');
    await writeFile(source, CHATGPT_CONTROLLER_SOURCE, {
      mode: 0o600,
      flag: 'wx',
    });
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
    process.once('exit', () => {
      rmSync(ownedDirectory, { recursive: true, force: true });
    });

    const invoke = async (
      action: 'state' | 'stop' | 'start',
      environment: Record<string, string> = {}
    ) => {
      try {
        // Launch credentials travel over a pipe, never in process-list arguments.
        const stdout = await new Promise<string>((resolve, reject) => {
          const child = execFile(
            binary,
            [action, bundleId, appPath],
            {
              env: process.env,
              cwd: ownedDirectory,
              timeout: 45_000,
              maxBuffer: 16 * 1024,
            },
            (error, output) =>
              error
                ? reject(error instanceof Error ? error : new Error(ERROR))
                : resolve(output)
          );
          child.stdin?.on('error', reject);
          child.stdin?.end(JSON.stringify(environment));
        });
        return JSON.parse(stdout) as unknown;
      } catch (error) {
        throw controllerError(action, error);
      }
    };

    return {
      async state() {
        const state = StateSchema.parse(await invoke('state'));
        if (state.running !== (state.instances === 1)) throw new Error(ERROR);
        return { running: state.running };
      },
      async stop() {
        z.object({ stopped: z.literal(true) }).parse(await invoke('stop'));
      },
      async start(environment) {
        z.object({ launched: z.literal(true) }).parse(
          await invoke('start', environment)
        );
      },
    };
  } catch (error) {
    if (directory) await rm(directory, { recursive: true, force: true });
    throw controllerError('compile', error);
  }
}

function controllerError(stage: string, error: unknown): Error {
  // Do not include execFile's message: it can echo launch arguments containing secrets.
  const failure = error as {
    code?: unknown;
    signal?: unknown;
    stderr?: unknown;
  };
  const detail =
    typeof failure?.stderr === 'string'
      ? failure.stderr.trim().slice(0, 2000)
      : '';
  const code =
    typeof failure?.code === 'string' || typeof failure?.code === 'number'
      ? String(failure.code)
      : 'unknown';
  const signal = typeof failure?.signal === 'string' ? failure.signal : 'none';
  return new Error(
    `${ERROR} Stage: ${stage}; code: ${code}; signal: ${signal}${detail ? `; ${detail}` : ''}`,
    { cause: error }
  );
}

export function defaultChatgptAppPath(): string {
  return resolve(
    process.env.MST_CHATGPT_APP_PATH ?? '/Applications/ChatGPT.app'
  );
}

export function defaultChatgptBundleId(): string {
  return process.env.MST_CHATGPT_BUNDLE_ID ?? 'com.openai.codex';
}

export function defaultChatgptConfigHome(): string {
  return join(homedir(), '.codex');
}
