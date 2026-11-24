/**
 * The `agent-desktop` CLI (https://github.com/vercel-labs/agent-desktop), the
 * one place MST runs it. It reads and acts on an app through the OS
 * accessibility tree: the AX API on macOS, AT-SPI on Linux.
 *
 * agent-desktop is an optional dependency, pinned to one version. Each call
 * here runs it once: the CLI prints one JSON envelope and exits. This module
 * holds only that and the typed reads and actions MST uses. Which app to
 * read, what counts as ready and every action policy stay in the drivers.
 */
import { execFile } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { z } from 'zod';

/** One call's process limit. A snapshot of a large app takes under a second. */
const CALL_TIMEOUT_MS = 15_000;
/** The deepest tree agent-desktop reads. */
const MAX_DEPTH = 50;
/** agent-desktop's limit for text on stdin (`set-value`, `clipboard-set`). */
export const AGENT_DESKTOP_MAX_TEXT_BYTES = 128 * 1024;
/** The environment agent-desktop needs; an eval's secrets are not part of it. */
const ENV_NAMES = [
  'HOME',
  'USER',
  'LOGNAME',
  'PATH',
  'TMPDIR',
  'LANG',
  // The Linux desktop session agent-desktop reads: its display, session bus
  // and runtime directory. Without them it finds no accessibility bus.
  'DISPLAY',
  'XAUTHORITY',
  'WAYLAND_DISPLAY',
  'DBUS_SESSION_BUS_ADDRESS',
  'XDG_RUNTIME_DIR',
  'XDG_SESSION_TYPE',
  'AT_SPI_BUS_ADDRESS',
];

/**
 * A failed call. `code` is agent-desktop's own error code (`TIMEOUT`,
 * `STALE_REF`, `ACTION_FAILED`, ...), or `NO_REPLY` when the process ended
 * without a valid envelope.
 */
export class AgentDesktopError extends Error {
  constructor(
    readonly code: string,
    /** agent-desktop's `details.kind`, when it gives one. */
    readonly kind?: string,
    /** agent-desktop's delivery verdict for an action, when it gives one. */
    readonly delivery?: string
  ) {
    super(kind ? `${code} (${kind})` : code);
    this.name = 'AgentDesktopError';
  }

  /**
   * Whether an action may have reached the app. Only agent-desktop's
   * `not_delivered` proves it did not.
   */
  get mayHaveActed(): boolean {
    return this.delivery !== 'not_delivered';
  }
}

export interface AgentDesktopNode {
  role: string;
  name?: string | null;
  value?: string | null;
  states?: string[] | null;
  /** Present on elements an action can target. Valid for its snapshot only. */
  ref_id?: string;
  children?: AgentDesktopNode[];
}

const NodeSchema: z.ZodType<AgentDesktopNode> = z.lazy(() =>
  z.looseObject({
    role: z.string(),
    name: z.string().nullish(),
    value: z.string().nullish(),
    states: z.array(z.string()).nullish(),
    ref_id: z.string().optional(),
    children: z.array(NodeSchema).optional(),
  })
);

const EnvelopeSchema = z.looseObject({
  ok: z.boolean(),
  data: z.unknown().optional(),
  error: z
    .looseObject({
      code: z.string(),
      details: z.looseObject({ kind: z.string().optional() }).nullish(),
      disposition: z.looseObject({ delivery: z.string() }).nullish(),
    })
    .optional(),
});

const WindowSchema = z.looseObject({
  id: z.string(),
  pid: z.number().int(),
  accessible: z.boolean(),
  visible: z.boolean(),
  /** The owning application's name, where the OS gives one. */
  app_name: z.string().optional(),
});
export type AgentDesktopWindow = z.infer<typeof WindowSchema>;

const AppSchema = z.looseObject({
  name: z.string(),
  pid: z.number().int(),
});
export type AgentDesktopApp = z.infer<typeof AppSchema>;

/** One window, by id, of the application whose name agent-desktop lists it under. */
export interface AgentDesktopWindowTarget {
  id: string;
  app: string;
}

export interface AgentDesktopSnapshot {
  /** False when agent-desktop could not read the whole window in time. */
  complete: boolean;
  tree: AgentDesktopNode;
}

export interface AgentDesktopCall {
  args: readonly string[];
  stdin?: string;
  timeoutMs: number;
}

/** Runs the CLI once and returns what it printed. Tests replace it. */
export type AgentDesktopRun = (call: AgentDesktopCall) => Promise<string>;

export interface AgentDesktop {
  /** The Accessibility permission of the app that runs MST: `granted`, `denied` or `unknown`. */
  accessibility(): Promise<string>;
  /** agent-desktop's own version. */
  version(): Promise<string>;
  /** The running applications with a user interface. */
  apps(): Promise<AgentDesktopApp[]>;
  /** The visible windows: every application's, or one application's by exact name. */
  windows(app?: string): Promise<AgentDesktopWindow[]>;
  /**
   * The whole tree of one window, including text that no action can target.
   * The window is named with its application: agent-desktop then settles
   * that application's windows, not every window on a busy desktop.
   */
  snapshot(window: AgentDesktopWindowTarget): Promise<AgentDesktopSnapshot>;
  /** An element's current value, or null when it has none. */
  value(ref: string): Promise<string | null>;
  click(ref: string): Promise<void>;
  setValue(ref: string, text: string): Promise<void>;
  scrollTo(ref: string): Promise<void>;
  /** Gives an element keyboard focus, as a physical focus change. */
  focus(ref: string): Promise<void>;
  /** Puts `text` on the clipboard. On Linux a helper process keeps owning it. */
  clipboardSet(text: string): Promise<void>;
  /** Sends one key combo (`ctrl+v`, `return`) to the focused element, as keys. */
  press(combo: string): Promise<void>;
}

/**
 * The path of the installed agent-desktop executable, or undefined when the
 * package is not installed. Looks where MST itself resolves packages, then in
 * the working directory's project.
 */
export function agentDesktopBinary(
  from: readonly string[] = [
    typeof __filename === 'string' ? __filename : import.meta.url,
    join(process.cwd(), 'package.json'),
  ]
): string | undefined {
  for (const origin of from) {
    try {
      const manifest = createRequire(origin).resolve(
        'agent-desktop/package.json'
      );
      const parsed: unknown = JSON.parse(readFileSync(manifest, 'utf8'));
      const bin =
        parsed && typeof parsed === 'object'
          ? (parsed as { bin?: unknown }).bin
          : undefined;
      const entry =
        typeof bin === 'string'
          ? bin
          : bin && typeof bin === 'object'
            ? (bin as Record<string, unknown>)['agent-desktop']
            : undefined;
      if (typeof entry !== 'string') continue;
      const path = join(dirname(manifest), entry);
      if (existsSync(path)) return path;
    } catch {
      // Not installed where this origin resolves packages.
    }
  }
  return undefined;
}

function execRun(binary: string, env: NodeJS.ProcessEnv): AgentDesktopRun {
  const childEnv = Object.fromEntries(
    Object.entries(env).filter(
      ([name, value]) =>
        value !== undefined &&
        (ENV_NAMES.includes(name) || name.startsWith('AGENT_DESKTOP_'))
    )
  );
  return function run({ args, stdin, timeoutMs }) {
    return new Promise((resolve) => {
      const child = execFile(
        binary,
        [...args],
        {
          timeout: timeoutMs,
          killSignal: 'SIGKILL',
          maxBuffer: 32 * 1024 * 1024,
          env: childEnv,
        },
        // agent-desktop exits 1 on a failure it reports, with the envelope on
        // stdout. A process that printed nothing leaves an empty string.
        (_error, stdout) => resolve(String(stdout))
      );
      child.stdin?.on('error', () => {
        /* The envelope, or its absence, reports the failure. */
      });
      child.stdin?.end(stdin ?? '');
    });
  };
}

export function agentDesktop(options: {
  binary: string;
  /** No call runs past this time. */
  deadlineAt: number;
  env?: NodeJS.ProcessEnv;
  run?: AgentDesktopRun;
}): AgentDesktop {
  const run =
    options.run ?? execRun(options.binary, options.env ?? process.env);

  async function call(
    args: readonly string[],
    stdin?: string,
    limitMs = CALL_TIMEOUT_MS
  ): Promise<unknown> {
    const timeoutMs = Math.min(limitMs, options.deadlineAt - Date.now());
    // Nothing ran, so nothing reached the app.
    if (timeoutMs <= 0)
      throw new AgentDesktopError('TIMEOUT', undefined, 'not_delivered');
    let envelope: z.infer<typeof EnvelopeSchema>;
    try {
      envelope = EnvelopeSchema.parse(
        JSON.parse(await run({ args, stdin, timeoutMs }))
      );
    } catch {
      throw new AgentDesktopError('NO_REPLY');
    }
    if (envelope.ok) return envelope.data;
    throw new AgentDesktopError(
      envelope.error?.code ?? 'NO_REPLY',
      envelope.error?.details?.kind,
      envelope.error?.disposition?.delivery
    );
  }

  /** Parses a successful reply. A shape MST does not know is no reply. */
  function read<T>(schema: z.ZodType<T>, data: unknown): T {
    const parsed = schema.safeParse(data);
    if (!parsed.success) throw new AgentDesktopError('NO_REPLY');
    return parsed.data;
  }

  return {
    async accessibility() {
      const data = read(
        z.looseObject({
          permissions: z.looseObject({
            accessibility: z.looseObject({ state: z.string() }),
          }),
        }),
        await call(['status'])
      );
      return data.permissions.accessibility.state;
    },
    async version() {
      const data = read(
        z.looseObject({ version: z.string() }),
        await call(['status'])
      );
      return data.version;
    },
    async apps() {
      const data = read(
        z.looseObject({ apps: z.array(AppSchema) }),
        await call(['list-apps'])
      );
      return data.apps;
    },
    async windows(app) {
      return read(
        z.array(WindowSchema),
        await call(
          app === undefined ? ['list-windows'] : ['list-windows', '--app', app]
        )
      );
    },
    async snapshot(window) {
      // Leave the CLI time to print its own timeout before the process limit.
      const budget = Math.min(CALL_TIMEOUT_MS, options.deadlineAt - Date.now());
      const data = read(
        z.looseObject({ complete: z.boolean().optional(), tree: NodeSchema }),
        await call([
          'snapshot',
          '--app',
          window.app,
          '--window-id',
          window.id,
          '--max-depth',
          String(MAX_DEPTH),
          '--timeout-ms',
          String(Math.max(1, Math.floor(budget - Math.min(1000, budget / 10)))),
        ])
      );
      return { complete: data.complete !== false, tree: data.tree };
    },
    async value(ref) {
      const data = read(
        z.looseObject({ value: z.string().nullish() }),
        await call(['get', ref, '--property', 'value'])
      );
      return data.value ?? null;
    },
    async click(ref) {
      await call(['click', ref]);
    },
    async setValue(ref, text) {
      await call(['set-value', ref, '--stdin'], text);
    },
    async scrollTo(ref) {
      await call(['scroll-to', ref]);
    },
    async focus(ref) {
      await call(['--headed', 'focus', ref]);
    },
    async clipboardSet(text) {
      await call(['clipboard-set', '--stdin'], text);
    },
    async press(combo) {
      await call(['--headed', 'press', combo]);
    },
  };
}
