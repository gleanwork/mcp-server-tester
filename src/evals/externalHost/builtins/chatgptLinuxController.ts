import { execFile } from 'node:child_process';
import { isAbsolute } from 'node:path';
import { z } from 'zod';
import type { ChatgptApplicationController } from '../../chatgpt/driver.js';

const SESSION_KEYS = [
  'PATH',
  'HOME',
  'DISPLAY',
  'XAUTHORITY',
  'DBUS_SESSION_BUS_ADDRESS',
  'AT_SPI_BUS_ADDRESS',
  'XDG_RUNTIME_DIR',
  'XDG_CONFIG_HOME',
  'GNOME_KEYRING_CONTROL',
  'LANG',
  'LC_ALL',
  'MST_CHATGPT_CONTROL_SOCKET',
];

/** Control only the app through a caller-owned helper, never provision a Linux desktop. */
export function getLinuxChatgptApplicationController(
  environment: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform
): ChatgptApplicationController {
  if (platform !== 'linux')
    throw new Error('The Linux ChatGPT controller requires Linux.');
  const helper = environment.MST_CHATGPT_APP_CONTROLLER;
  if (!helper || !isAbsolute(helper))
    throw new Error(
      'MST_CHATGPT_APP_CONTROLLER must identify an absolute caller-owned executable.'
    );
  if (!environment.DISPLAY || !environment.DBUS_SESSION_BUS_ADDRESS)
    throw new Error(
      'ChatGPT requires a prepared Linux DISPLAY and D-Bus session.'
    );
  const executable = helper;
  if (
    environment.MST_CHATGPT_CONTROL_SOCKET &&
    !isAbsolute(environment.MST_CHATGPT_CONTROL_SOCKET)
  )
    throw new Error('MST_CHATGPT_CONTROL_SOCKET must be an absolute path.');
  const env = Object.fromEntries(
    SESSION_KEYS.flatMap((key) =>
      environment[key] === undefined ? [] : [[key, environment[key]]]
    )
  );
  async function invoke(
    operation: 'state' | 'start' | 'stop',
    launchEnvironment: Record<string, string> = {}
  ): Promise<unknown> {
    const payload = JSON.stringify({ environment: launchEnvironment });
    if (Buffer.byteLength(payload) > 128 * 1024)
      throw new Error(
        'ChatGPT launch environment exceeds the control message limit.'
      );
    const result = await new Promise<{ failed: boolean; output: string }>(
      (resolve) => {
        const child = execFile(
          executable,
          [operation],
          { env, timeout: 45_000, maxBuffer: 16 * 1024, killSignal: 'SIGKILL' },
          (error, stdout) =>
            resolve({ failed: error !== null, output: String(stdout) })
        );
        child.stdin?.on('error', () => {
          // An uncertain write is never retried; execFile will settle the operation.
        });
        child.stdin?.end(payload);
      }
    );
    if (result.failed)
      throw new Error(
        `Prepared Linux ChatGPT ${operation} failed; no retry attempted.`
      );
    try {
      return JSON.parse(result.output) as unknown;
    } catch {
      // Raw helper output and execFile errors can contain credentials. Never echo them.
      throw new Error(
        `Prepared Linux ChatGPT ${operation} returned an invalid receipt.`
      );
    }
  }
  return {
    async state() {
      const parsed = z
        .object({ running: z.boolean() })
        .strict()
        .safeParse(await invoke('state'));
      if (!parsed.success)
        throw new Error('Invalid Linux ChatGPT state receipt.');
      return parsed.data;
    },
    async start(environment) {
      const parsed = z
        .object({ launched: z.literal(true) })
        .strict()
        .safeParse(await invoke('start', environment));
      if (!parsed.success)
        throw new Error('Invalid Linux ChatGPT start receipt.');
    },
    async stop() {
      const parsed = z
        .object({ stopped: z.literal(true) })
        .strict()
        .safeParse(await invoke('stop'));
      if (!parsed.success)
        throw new Error('Invalid Linux ChatGPT stop receipt.');
    },
  };
}
