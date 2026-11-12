/** Isolated Node entry point for the account-backed Linux desktop driver. */
import { parseArgs } from 'node:util';
import { z } from 'zod';
import { connectLinuxUi } from './linuxAtspi.js';
import { runFirstPartyLinux } from './linuxFirstPartyDriver.js';
import {
  LinuxUiError,
  type LinuxUi,
  type LinuxDriverReceipt,
} from './linuxUi.js';

const operation = z.enum([
  'probe',
  'reset',
  'submit',
  'hitl',
  'answer',
  'diagnose',
]);
const payloadSchema = z
  .object({
    prompt: z.string().optional(),
    targetModel: z.string().optional(),
    approveWriteTools: z.boolean().optional(),
    questions: z
      .array(
        z.object({
          labels: z.array(z.string()).min(1),
          multiSelect: z.boolean().optional(),
        })
      )
      .optional(),
    dir: z.string().optional(),
  })
  .strict()
  .transform(({ approveWriteTools, ...payload }) => ({
    ...payload,
    approveWrites: approveWriteTools,
  }));
const MAX_INPUT_BYTES = 16 * 1024 * 1024;

async function input(): Promise<unknown> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of process.stdin) {
    const value: unknown = chunk;
    if (!Buffer.isBuffer(value)) throw new LinuxUiError('invalid_request');
    bytes += value.length;
    if (bytes > MAX_INPUT_BYTES) throw new LinuxUiError('request_too_large');
    chunks.push(value);
  }
  const text = new TextDecoder('utf-8', { fatal: true }).decode(
    Buffer.concat(chunks)
  );
  return JSON.parse(text || '{}') as unknown;
}

async function main(): Promise<void> {
  const started = Date.now();
  let ui: LinuxUi | undefined;
  let receipt: LinuxDriverReceipt;
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
        'Linux first-party Cowork: --mode <probe|reset|submit|hitl|answer|diagnose> --timeout-ms <ms> --max-actions <count>\n'
      );
      return;
    }
    const mode = operation.parse(values.mode);
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
    // Mode is explicit in this entry point. Metadata is a rejection guard, not
    // a selector; the TypeScript desktop adapter checks the full owned runtime.
    if (
      !process.env.MST_COWORK_ACCOUNT_OWNER ||
      !process.env.MST_COWORK_ACCOUNT_PROFILE ||
      !process.env.MST_COWORK_ACCOUNT_MARKER
    )
      throw new LinuxUiError('account_runtime_required');
    const payload = payloadSchema.parse(await input());
    const deadlineAt = started + timeout;
    ui = await connectLinuxUi(process.env, deadlineAt);
    receipt = await runFirstPartyLinux(mode, payload, ui, {
      deadlineAt,
      maxActions,
    });
  } catch (error) {
    // Do not emit raw D-Bus errors, paths, input, or inherited environment data.
    receipt = {
      status: 'failed',
      action_count: 0,
      duration_ms: Math.max(0, Date.now() - started),
      error:
        error instanceof LinuxUiError && /^[a-z_]{1,64}$/.test(error.code)
          ? error.code
          : 'invalid_request',
    };
  } finally {
    await ui?.close();
  }
  process.stdout.write(`${JSON.stringify(receipt)}\n`);
  process.exitCode = receipt.status === 'failed' ? 1 : 0;
}

await main();
