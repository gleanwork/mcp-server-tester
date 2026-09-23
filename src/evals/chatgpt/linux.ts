import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import type { Duplex } from 'node:stream';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import type { ExternalHostConfig } from '../externalHost/types.js';
import type { SemanticDesktopTelemetry } from '../cowork/driver.js';
import {
  chatgptDesktopEnvironment,
  chatgptSurface,
  nativeMaxActions,
} from './driver.js';
import { CodexSetupError } from '../codexSetup/native.js';
import { readLinuxChatgptEnvironment } from '../chatgptSetup/linuxProfile.js';
import {
  LINUX_CHATGPT_ERROR_CODES,
  LINUX_CHATGPT_SCREEN_LABELS,
  LINUX_CHATGPT_RUNTIME_ENVIRONMENT,
  pickEnvironment,
} from './linuxContract.js';

const FailurePhase = z.enum([
  'waiting-for-initial-ui',
  'profession-selected',
  'continue-ready',
  'intro-dismiss',
  'surface',
  'composer',
]);
const FailureStep = z.enum([
  'draft-open',
  'draft-surface',
  'draft-readback',
  'send',
]);
const DraftState = z
  .object({
    observedSurface: z.enum(['chatgpt-work', 'codex', 'unknown', 'ambiguous']),
    composerRootCount: z.number().int().min(0).max(5000),
    sendControlCount: z.number().int().min(0).max(5000),
    textReadable: z.boolean(),
    screen: z
      .object({
        nodeCount: z.number().int().min(0).max(5000),
        visibleButtonCount: z.number().int().min(0).max(5000),
        visibleFrameCount: z.number().int().min(0).max(5000),
        dialogCount: z.number().int().min(0).max(5000),
        knownLabels: z.array(z.enum(LINUX_CHATGPT_SCREEN_LABELS)).max(64),
      })
      .strict()
      .optional(),
    textLength: z
      .number()
      .int()
      .min(0)
      .max(2 * 1024 * 1024)
      .optional(),
    textSha256: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
    embeddedObjectCount: z
      .number()
      .int()
      .min(0)
      .max(2 * 1024 * 1024)
      .optional(),
    newlineCount: z
      .number()
      .int()
      .min(0)
      .max(2 * 1024 * 1024)
      .optional(),
  })
  .strict()
  .refine((state) => {
    const measurements = [
      state.textLength,
      state.textSha256,
      state.embeddedObjectCount,
      state.newlineCount,
    ];
    if (!state.textReadable)
      return measurements.every((value) => value === undefined);
    return (
      state.composerRootCount === 1 &&
      state.textLength !== undefined &&
      state.textSha256 !== undefined &&
      state.embeddedObjectCount !== undefined &&
      state.newlineCount !== undefined &&
      state.embeddedObjectCount + state.newlineCount <= state.textLength
    );
  });
const Receipt = z
  .object({
    status: z.enum(['ready', 'submitted', 'failed']),
    surface: z.enum(['chatgpt-work', 'codex']).optional(),
    action_count: z.number().int().nonnegative(),
    duration_ms: z.number().finite().nonnegative(),
    phase: FailurePhase.optional(),
    step: FailureStep.optional(),
    draftState: DraftState.optional(),
    error: z.enum(LINUX_CHATGPT_ERROR_CODES).optional(),
  })
  .strict()
  .refine(
    (receipt) => receipt.phase === undefined || receipt.status === 'failed'
  )
  .refine(
    (receipt) => receipt.draftState === undefined || receipt.status === 'failed'
  )
  .refine(
    (receipt) =>
      receipt.step === undefined ||
      (receipt.status === 'failed' && receipt.phase === 'composer')
  );

/** Failure-only fields from a validated receipt. Never raw helper output. */
export interface NativeChatgptDriverDiagnostics {
  telemetry?: SemanticDesktopTelemetry;
  error?: z.infer<typeof Receipt>['error'];
  phase?: z.infer<typeof FailurePhase>;
  step?: z.infer<typeof FailureStep>;
  draftState?: z.infer<typeof DraftState>;
}

export class NativeChatgptDriverError extends Error {
  constructor(
    message: string,
    public readonly diagnostics: NativeChatgptDriverDiagnostics = {}
  ) {
    super(message);
  }

  get telemetry(): SemanticDesktopTelemetry | undefined {
    return this.diagnostics.telemetry;
  }
}

/** MST's draft hand-off. Called at most once per native invocation. */
export type ChatgptPromptOpener = (prompt: string) => Promise<void>;

const OPEN_REQUEST_LIMIT = 1024;

export async function runLinuxChatgptDesktop(
  mode: 'prepare' | 'submit',
  config: ExternalHostConfig,
  deadlineAt: number,
  prompt?: string,
  openPrompt?: ChatgptPromptOpener
): Promise<{ telemetry: SemanticDesktopTelemetry }> {
  const started = Date.now();
  const timeout = Math.min(deadlineAt - started, 60_000);
  if (timeout <= 0)
    throw new NativeChatgptDriverError(
      'Linux ChatGPT deadline exceeded; no action attempted.'
    );
  const desktop = chatgptDesktopEnvironment(config);
  let python: string | undefined;
  let env: Record<string, string>;
  try {
    const linux = readLinuxChatgptEnvironment(desktop);
    python = linux.python;
    // The profile installed by setup, never an inherited CLI profile.
    env = {
      ...pickEnvironment(desktop, LINUX_CHATGPT_RUNTIME_ENVIRONMENT),
      CODEX_HOME: linux.codexHome,
      NO_AT_BRIDGE: '0',
    };
  } catch (error) {
    throw new NativeChatgptDriverError(
      `${error instanceof Error ? error.message : 'Invalid Linux ChatGPT environment.'}`
    );
  }
  const surface = chatgptSurface(config);
  let maxActions: number;
  try {
    maxActions = nativeMaxActions(config);
  } catch {
    throw new NativeChatgptDriverError('Invalid Linux ChatGPT action budget.');
  }
  const draft = mode === 'submit' ? (prompt ?? '') : '';
  const payload = JSON.stringify({
    surface,
    ...(mode === 'submit' ? { prompt } : {}),
  });
  if (Buffer.byteLength(payload) > 2 * 1024 * 1024)
    throw new NativeChatgptDriverError(
      'Linux ChatGPT input exceeds the control message limit.'
    );
  const script = createRequire(
    typeof __filename === 'string' ? __filename : import.meta.url
  ).resolve('@gleanwork/mcp-server-tester/chatgpt-linux-runtime');
  let openFailure: string | undefined;
  let handoff: Promise<void> | undefined;
  const result = await new Promise<{ failed: boolean; stdout: string }>(
    (resolveResult) => {
      const child = spawn(
        python ?? 'python3',
        [
          script,
          '--mode',
          mode,
          '--timeout-ms',
          String(
            Math.max(1, Math.floor(timeout - Math.min(1000, timeout / 10)))
          ),
          '--max-actions',
          String(maxActions),
          ...(openPrompt ? ['--open-fd', '3'] : []),
        ],
        {
          env,
          shell: false,
          stdio: [
            'pipe',
            'pipe',
            'ignore',
            ...(openPrompt ? ['pipe' as const] : []),
          ],
        }
      );
      let stdout = '';
      let overflow = false;
      let settled = false;
      const timer = setTimeout(() => child.kill('SIGKILL'), timeout);
      const settle = (failed: boolean) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolveResult({ failed: failed || overflow, stdout });
      };
      child.stdout?.on('data', (chunk: Buffer) => {
        if (stdout.length + chunk.length > 64 * 1024) {
          overflow = true;
          child.kill('SIGKILL');
          return;
        }
        stdout += chunk.toString('utf8');
      });
      child.on('error', () => settle(true));
      child.on('close', (code) => settle(code !== 0));
      child.stdin?.on('error', () => {
        /* Never retry an uncertain write. */
      });
      child.stdin?.end(payload);
      const channel = child.stdio[3] as Duplex | null | undefined;
      if (openPrompt && channel) {
        let request = '';
        let requested = false;
        channel.on('error', () => undefined);
        channel.on('data', (chunk: Buffer) => {
          if (requested) return;
          request += chunk.toString('utf8');
          if (request.length > OPEN_REQUEST_LIMIT) {
            requested = true;
            channel.end(`${JSON.stringify({ opened: false })}\n`);
            return;
          }
          const newline = request.indexOf('\n');
          if (newline < 0) return;
          // Exactly one hand-off per invocation, bound to the expected draft.
          requested = true;
          let valid = false;
          try {
            const message = JSON.parse(request.slice(0, newline)) as unknown;
            valid = isDeepStrictEqual(message, {
              open: createHash('sha256').update(draft, 'utf8').digest('hex'),
            });
          } catch {
            valid = false;
          }
          const reply = (opened: boolean): void => {
            channel.end(`${JSON.stringify({ opened })}\n`);
          };
          if (!valid) {
            reply(false);
            return;
          }
          handoff = openPrompt(draft).then(
            () => reply(true),
            (error: unknown) => {
              openFailure =
                error instanceof CodexSetupError ? error.code : 'open_failed';
              reply(false);
            }
          );
        });
      }
    }
  );
  // Never return while a deep-link hand-off process is still in flight.
  await handoff;
  let record: z.infer<typeof Receipt> | undefined;
  try {
    record = Receipt.parse(JSON.parse(result.stdout));
  } catch {
    /* Never expose raw output. */
  }
  const valid =
    !result.failed &&
    record?.status === (mode === 'prepare' ? 'ready' : 'submitted') &&
    record.surface === surface &&
    record.action_count <= maxActions;
  const telemetry: SemanticDesktopTelemetry = {
    driver: 'linux-desktop',
    accounting: valid ? 'complete' : 'partial',
    duration_ms: Math.max(0, Date.now() - started),
    action_count: record?.action_count ?? 0,
    planner: { status: 'not-applicable' },
    cost: { status: 'not-applicable' },
  };
  if (!valid)
    throw new NativeChatgptDriverError(
      `Linux ChatGPT ${mode} failed or its receipt was uncertain (${record?.error ?? 'missing_or_invalid_receipt'}${record?.phase ? `; phase=${record.phase}` : ''}${record?.step ? `; step=${record.step}` : ''}${openFailure ? `; open=${openFailure}` : ''}); no retry attempted.`,
      {
        telemetry,
        error: record?.error,
        phase: record?.phase,
        step: record?.step,
        draftState: record?.draftState,
      }
    );
  return { telemetry };
}
