/**
 * Isolated Node entry point for the Linux ChatGPT driver. JSON on stdin,
 * exactly one JSON receipt line on stdout.
 */
import { parseArgs } from 'node:util';
import { openAtspiBus, type AtspiBus } from '../linuxAtspiBus.js';
import { AtspiChatgptDesktop } from './linuxAtspiDesktop.js';
import { NATIVE_MAX_ACTIONS } from './linuxContract.js';
import {
  ChatgptDriver,
  DriverFailure,
  INPUT_LIMIT,
  errorCode,
  type ChatgptReceipt,
} from './linuxDriver.js';

async function input(): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    const value: unknown = chunk;
    if (!Buffer.isBuffer(value)) throw new DriverFailure('invalid_input');
    size += value.length;
    if (size > INPUT_LIMIT) throw new DriverFailure('input_too_large');
    chunks.push(value);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(
      new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))
    );
  } catch {
    throw new DriverFailure('invalid_input');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
    throw new DriverFailure('invalid_input');
  return parsed as Record<string, unknown>;
}

function integer(value: string | undefined): number | undefined {
  return value !== undefined && /^-?\d+$/.test(value)
    ? Number(value)
    : undefined;
}

async function main(): Promise<void> {
  const started = Date.now();
  let bus: AtspiBus | undefined;
  let driver: ChatgptDriver | undefined;
  let receipt: ChatgptReceipt;
  try {
    const { values } = parseArgs({
      options: {
        mode: { type: 'string' },
        'timeout-ms': { type: 'string' },
        'max-actions': {
          type: 'string',
          default: String(NATIVE_MAX_ACTIONS.default),
        },
        'open-fd': { type: 'string' },
        help: { type: 'boolean' },
      },
    });
    if (values.help) {
      process.stdout.write(
        'Linux ChatGPT: --mode <prepare|submit> --timeout-ms <ms> --max-actions <count> [--open-fd <fd>]\n'
      );
      return;
    }
    const mode = values.mode;
    const timeout = integer(values['timeout-ms']);
    const maxActions = integer(values['max-actions']);
    if (mode !== 'prepare' && mode !== 'submit')
      throw new DriverFailure('invalid_input');
    if (
      timeout === undefined ||
      timeout <= 0 ||
      maxActions === undefined ||
      maxActions < 1 ||
      maxActions > NATIVE_MAX_ACTIONS.max
    )
      throw new DriverFailure('invalid_budget');
    const payload = await input();
    const deadlineAt = started + timeout;
    bus = await openAtspiBus(process.env, deadlineAt);
    driver = new ChatgptDriver(
      new AtspiChatgptDesktop({
        bus,
        deadlineAt,
        openFd: integer(values['open-fd']),
      }),
      timeout,
      maxActions
    );
    receipt =
      mode === 'prepare'
        ? await driver.prepare(payload.surface)
        : await driver.submit(payload.prompt, payload.surface);
  } catch (error) {
    receipt = driver
      ? await driver.receipt('failed')
      : {
          status: 'failed',
          action_count: 0,
          duration_ms: Math.max(0, Date.now() - started),
        };
    receipt.error = errorCode(error);
  } finally {
    bus?.close();
  }
  process.stdout.write(`${JSON.stringify(receipt)}\n`);
  process.exitCode = receipt.status === 'failed' ? 1 : 0;
}

await main();
