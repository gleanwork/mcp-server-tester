/** Isolated Node entry point for the managed (third-party) Linux Cowork driver. */
import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import { stat, writeFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { parseArgs } from 'node:util';
import { z } from 'zod';
import { connectLinuxUi } from './linuxAtspi.js';
import {
  accessibilityText,
  runThirdPartyLinux,
  scanLinuxUi,
  thirdPartyFailureCode,
  type ThirdPartyReceipt,
} from './linuxThirdPartyDriver.js';
import { LinuxUiError, type LinuxUi } from './linuxUi.js';
import { xwdToPng } from './xwdPng.js';

const operation = z.enum([
  'probe',
  'reset',
  'submit',
  'hitl',
  'answer',
  'diagnose',
]);
const MAX_INPUT_BYTES = 2 * 1024 * 1024;
const ACCOUNT_ENVIRONMENT = [
  'MST_COWORK_ACCOUNT_OWNER',
  'MST_COWORK_ACCOUNT_MARKER',
  'MST_COWORK_ACCOUNT_PROFILE',
];

async function input(): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of process.stdin) {
    const value: unknown = chunk;
    if (!Buffer.isBuffer(value)) throw new LinuxUiError('invalid_input');
    bytes += value.length;
    if (bytes > MAX_INPUT_BYTES) throw new LinuxUiError('input_too_large');
    chunks.push(value);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(
      new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)) ||
        '{}'
    );
  } catch {
    throw new LinuxUiError('invalid_input');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
    throw new LinuxUiError('invalid_input');
  return parsed as Record<string, unknown>;
}

/** Never follow an existing symlink in the diagnosis directory. */
async function writePrivate(
  path: string,
  data: Buffer | string
): Promise<void> {
  await writeFile(path, data, {
    flag:
      constants.O_WRONLY |
      constants.O_CREAT |
      constants.O_TRUNC |
      constants.O_NOFOLLOW,
    mode: 0o600,
  });
}

function errorName(error: unknown): string {
  if (error instanceof LinuxUiError) return error.code;
  return error instanceof Error ? error.name : 'Error';
}

function screenshot(timeoutMs: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    execFile(
      'xwd',
      ['-root', '-silent'],
      {
        encoding: 'buffer',
        timeout: timeoutMs,
        killSignal: 'SIGKILL',
        maxBuffer: 256 * 1024 * 1024,
        shell: false,
      },
      (error, stdout) =>
        error
          ? reject(error instanceof Error ? error : new Error('xwd failed'))
          : resolve(stdout)
    );
  });
}

/** Read-only desktop capture: a screenshot and the accessibility tree. Never acts on the app. */
async function diagnose(
  directory: unknown,
  started: number,
  deadlineAt: number
): Promise<ThirdPartyReceipt> {
  if (
    typeof directory !== 'string' ||
    !isAbsolute(directory) ||
    !(await stat(directory).catch(() => undefined))?.isDirectory()
  )
    throw new LinuxUiError('invalid_directory');
  const files: string[] = [];
  try {
    const budget = Math.max(1000, Math.min((deadlineAt - started) / 2, 15_000));
    await writePrivate(
      join(directory, 'screen.png'),
      xwdToPng(await screenshot(budget))
    );
    files.push('screen.png');
  } catch (error) {
    await writePrivate(
      join(directory, 'screen.error'),
      `${errorName(error)}\n`
    );
  }
  let ui: LinuxUi | undefined;
  try {
    ui = await connectLinuxUi(process.env, deadlineAt);
    await writePrivate(
      join(directory, 'accessibility.txt'),
      accessibilityText(await scanLinuxUi(ui, deadlineAt))
    );
    files.push('accessibility.txt');
  } catch (error) {
    await writePrivate(
      join(directory, 'accessibility.error'),
      `${errorName(error)}\n`
    );
  } finally {
    await ui?.close();
  }
  return {
    status: 'diagnosed',
    action_count: 0,
    duration_ms: Math.max(0, Date.now() - started),
    files,
  };
}

async function main(): Promise<void> {
  const started = Date.now();
  let ui: LinuxUi | undefined;
  let receipt: ThirdPartyReceipt;
  try {
    const { values } = parseArgs({
      options: {
        mode: { type: 'string' },
        'timeout-ms': { type: 'string' },
        'max-actions': { type: 'string', default: '24' },
        help: { type: 'boolean' },
      },
    });
    if (values.help) {
      process.stdout.write(
        'Linux managed Cowork: --mode <probe|reset|submit|hitl|answer|diagnose> --timeout-ms <ms> --max-actions <count>\n'
      );
      return;
    }
    const mode = operation.safeParse(values.mode);
    if (!mode.success) throw new LinuxUiError('invalid_request');
    const timeout = Number(values['timeout-ms']);
    const maxActions = Number(values['max-actions']);
    if (
      !Number.isSafeInteger(timeout) ||
      timeout < 1 ||
      timeout > 3_600_000 ||
      !Number.isSafeInteger(maxActions) ||
      maxActions < 1 ||
      maxActions > 64
    )
      throw new LinuxUiError('invalid_budget');
    const payload = await input();
    // Reject account-backed requests before touching the desktop or taking a
    // diagnostic screenshot. Metadata is a guard, never a mode selector.
    if (
      payload.firstParty === true ||
      ACCOUNT_ENVIRONMENT.some((key) => process.env[key])
    )
      throw new LinuxUiError('wrong_driver_mode');
    const deadlineAt = started + timeout;
    if (mode.data === 'diagnose') {
      receipt = await diagnose(payload.dir, started, deadlineAt);
    } else {
      ui = await connectLinuxUi(process.env, deadlineAt);
      receipt = await runThirdPartyLinux(mode.data, payload, ui, {
        deadlineAt,
        maxActions,
      });
    }
  } catch (error) {
    // Do not emit raw D-Bus errors, paths, input, or inherited environment data.
    receipt = {
      status: 'failed',
      action_count: 0,
      duration_ms: Math.max(0, Date.now() - started),
      error: thirdPartyFailureCode(error),
    };
  } finally {
    await ui?.close();
  }
  process.stdout.write(`${JSON.stringify(receipt)}\n`);
  process.exitCode = receipt.status === 'failed' ? 1 : 0;
}

await main();
