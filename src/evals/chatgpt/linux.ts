import { execFile } from 'node:child_process';
import { createRequire } from 'node:module';
import { isAbsolute, relative, resolve } from 'node:path';
import { z } from 'zod';
import type { ExternalHostConfig } from '../externalHost/types.js';
import type { SemanticDesktopTelemetry } from '../cowork/driver.js';
import {
  chatgptDesktopEnvironment,
  chatgptSurface,
  readLaunchEnvironment,
} from './driver.js';

const SESSION_KEYS = [
  'PATH',
  'HOME',
  'DISPLAY',
  'XAUTHORITY',
  'DBUS_SESSION_BUS_ADDRESS',
  'AT_SPI_BUS_ADDRESS',
  'XDG_RUNTIME_DIR',
  'XDG_CONFIG_HOME',
  'LANG',
  'LC_ALL',
];
const FailurePhase = z.enum([
  'waiting-for-initial-ui',
  'profession-selected',
  'continue-ready',
  'intro-dismiss',
  'surface',
  'composer',
]);
const ComposerCandidate = z
  .object({
    role: z.string().regex(/^[a-z][a-z -]{0,63}$/),
    showing: z.boolean(),
    visible: z.boolean(),
    enabled: z.boolean(),
    sensitive: z.boolean(),
    editableState: z.boolean(),
    editableInterface: z.boolean(),
  })
  .strict();
const Receipt = z
  .object({
    status: z.enum(['ready', 'submitted', 'failed']),
    surface: z.enum(['chatgpt-work', 'codex']).optional(),
    action_count: z.number().int().nonnegative(),
    duration_ms: z.number().finite().nonnegative(),
    phase: FailurePhase.optional(),
    composerCandidates: z.array(ComposerCandidate).max(16).optional(),
    error: z
      .string()
      .regex(/^[a-z_]{1,64}$/)
      .optional(),
  })
  .strict()
  .refine(
    (receipt) => receipt.phase === undefined || receipt.status === 'failed'
  )
  .refine(
    (receipt) =>
      receipt.composerCandidates === undefined ||
      (receipt.status === 'failed' && receipt.phase === 'composer')
  );

export class NativeChatgptDriverError extends Error {
  constructor(
    message: string,
    public readonly telemetry?: SemanticDesktopTelemetry,
    public readonly phase?: z.infer<typeof FailurePhase>,
    public readonly composerCandidates?: z.infer<typeof ComposerCandidate>[]
  ) {
    super(message);
  }
}

/** The caller explicitly attests to an isolated HOME; never fall back to a user profile. */
export function linuxChatgptHome(environment: NodeJS.ProcessEnv): string {
  const home = environment.MST_CHATGPT_ISOLATED_HOME;
  if (
    !home ||
    !isAbsolute(home) ||
    resolve(home) === '/' ||
    environment.HOME !== home
  )
    throw new Error(
      'Linux ChatGPT requires MST_CHATGPT_ISOLATED_HOME equal to the caller-prepared absolute HOME.'
    );
  if (!environment.DISPLAY || !environment.DBUS_SESSION_BUS_ADDRESS)
    throw new Error(
      'Linux ChatGPT requires a prepared DISPLAY and D-Bus session.'
    );
  return home;
}

export function validateLinuxChatgptPaths(config: ExternalHostConfig): string {
  const desktop = chatgptDesktopEnvironment(config);
  const home = linuxChatgptHome(desktop);
  const launch = readLaunchEnvironment(config.options?.environment);
  for (const key of SESSION_KEYS) {
    if (launch[key] !== undefined && launch[key] !== desktop[key])
      throw new Error(
        'Linux ChatGPT launch environment must not override the prepared desktop session.'
      );
  }
  const path = config.codexSetup?.configPath;
  if (
    !path ||
    !isAbsolute(path) ||
    relative(home, path).startsWith('..') ||
    isAbsolute(relative(home, path))
  )
    throw new Error(
      'Linux ChatGPT requires an explicit configPath inside its isolated HOME.'
    );
  if (config.options?.chatgptSessionRoot !== undefined)
    throw new Error(
      'Linux ChatGPT reads native sessions only from the configured CODEX_HOME.'
    );
  return home;
}

export async function runLinuxChatgptDesktop(
  mode: 'prepare' | 'submit',
  config: ExternalHostConfig,
  deadlineAt: number,
  prompt?: string
): Promise<{ telemetry: SemanticDesktopTelemetry }> {
  const started = Date.now();
  const timeout = Math.min(deadlineAt - started, 60_000);
  if (timeout <= 0)
    throw new NativeChatgptDriverError(
      'Linux ChatGPT deadline exceeded; no action attempted.'
    );
  const env = chatgptDesktopEnvironment(config);
  linuxChatgptHome(env);
  const surface = chatgptSurface(config);
  const maxActions = Number(config.options?.nativeMaxActions ?? 24);
  if (!Number.isInteger(maxActions) || maxActions < 1 || maxActions > 64)
    throw new NativeChatgptDriverError('Invalid Linux ChatGPT action budget.');
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
  const result = await new Promise<{ failed: boolean; stdout: string }>(
    (resolveResult) => {
      const child = execFile(
        env.MST_CHATGPT_PYTHON ?? 'python3',
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
        ],
        {
          timeout,
          killSignal: 'SIGKILL',
          maxBuffer: 16 * 1024,
          env: {
            ...Object.fromEntries(
              SESSION_KEYS.flatMap((key) =>
                env[key] === undefined ? [] : [[key, env[key]]]
              )
            ),
            NO_AT_BRIDGE: '0',
          },
        },
        (error, stdout) =>
          resolveResult({ failed: error !== null, stdout: String(stdout) })
      );
      child.stdin?.on('error', () => {
        /* Never retry an uncertain write. */
      });
      child.stdin?.end(payload);
    }
  );
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
      `Linux ChatGPT ${mode} failed or its receipt was uncertain (${record?.error ?? 'missing_or_invalid_receipt'}${record?.phase ? `; phase=${record.phase}` : ''}); no retry attempted.`,
      telemetry,
      record?.phase,
      record?.composerCandidates
    );
  return { telemetry };
}
