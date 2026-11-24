/**
 * `mst desktop`: the two read-only checks of ADR 0017 on the desktop app in
 * front of you. Neither presses, types or opens anything.
 *
 *   mst desktop snapshot --app <name> [--automation <name>] [--out <file>]
 *   mst desktop parity --app <name> [--out <file>]
 *
 * `snapshot` reads one screen of a running app through one transport of the
 * desktop interface and writes what the drivers would see. `parity` reads it
 * through MST's default transport and through agent-desktop, and lists every
 * control that differs. The app is named by its accessible application name
 * (`Claude`, `ChatGPT`), so the checks know no product.
 */
import { writeFile } from 'node:fs/promises';
import { connectAgentDesktopUi } from '../../../evals/desktopUi/agentDesktopConnect.js';
import { connectAtspiDesktopUi } from '../../../evals/desktopUi/atspi.js';
import {
  DESKTOP_AUTOMATIONS,
  type DesktopAutomation,
} from '../../../evals/desktopUi/automation.js';
import type { DesktopUi } from '../../../evals/desktopUi/desktopUi.js';
import {
  compareSnapshots,
  formatParity,
  type RecordedSnapshot,
} from '../../../evals/desktopUi/parity.js';

/** One read's time limit: a snapshot of a large app takes under a second. */
const READ_TIMEOUT_MS = 30_000;

/**
 * The transports that read a tree on this OS, the default first. Computer
 * Use reads no tree, so on macOS only agent-desktop can.
 */
function treeAutomations(platform: NodeJS.Platform): DesktopAutomation[] {
  switch (platform) {
    case 'linux':
      return ['atspi', 'agent-desktop'];
    case 'darwin':
      return ['agent-desktop'];
    default:
      return [];
  }
}

export interface DesktopSnapshotOptions {
  app: string;
  automation?: string;
  out?: string;
  /** Tests pass the connection; the command connects for real. */
  connect?: typeof connect;
  platform?: NodeJS.Platform;
}

async function connect(
  automation: DesktopAutomation,
  app: string,
  deadlineAt: number,
  platform: NodeJS.Platform
): Promise<DesktopUi> {
  const application = (name: string) =>
    name.toLowerCase() === app.toLowerCase();
  if (automation === 'atspi')
    return connectAtspiDesktopUi(process.env, deadlineAt, { application });
  return connectAgentDesktopUi(
    process.env,
    deadlineAt,
    { application },
    platform
  );
}

async function readOnce(
  automation: DesktopAutomation,
  app: string,
  platform: NodeJS.Platform,
  connectWith: typeof connect
): Promise<RecordedSnapshot> {
  const started = Date.now();
  const ui = await connectWith(
    automation,
    app,
    started + READ_TIMEOUT_MS,
    platform
  );
  try {
    const nodes = await ui.snapshot();
    return {
      automation,
      app,
      os: platform,
      takenAt: new Date(started).toISOString(),
      durationMs: Date.now() - started,
      nodes: [...nodes],
    };
  } finally {
    await ui.close();
  }
}

function chosenAutomation(
  value: string | undefined,
  platform: NodeJS.Platform
): DesktopAutomation {
  const available = treeAutomations(platform);
  if (!available.length)
    throw new Error(`MST has no desktop setup on ${platform}.`);
  if (value === undefined) return available[0]!;
  if (!(DESKTOP_AUTOMATIONS as readonly string[]).includes(value))
    throw new Error(
      `"${value}" names no desktop automation; MST knows ${DESKTOP_AUTOMATIONS.join(', ')}.`
    );
  if (!available.includes(value as DesktopAutomation))
    throw new Error(
      `${value} reads no accessibility tree on ${platform}; ${available.join(' and ')} do.`
    );
  return value as DesktopAutomation;
}

export async function desktopSnapshot(
  options: DesktopSnapshotOptions
): Promise<void> {
  const platform = options.platform ?? process.platform;
  const automation = chosenAutomation(options.automation, platform);
  const snapshot = await readOnce(
    automation,
    options.app,
    platform,
    options.connect ?? connect
  );
  const text = `${JSON.stringify(snapshot, null, 2)}\n`;
  if (options.out === undefined) {
    process.stdout.write(text);
    return;
  }
  await writeFile(options.out, text);
  process.stdout.write(
    `${snapshot.nodes.length} nodes of ${options.app} through ${automation} in ${snapshot.durationMs} ms, written to ${options.out}\n`
  );
}

export interface DesktopParityOptions {
  app: string;
  out?: string;
  connect?: typeof connect;
  platform?: NodeJS.Platform;
}

/** Sets the exit code to 1 when the two reads differ. */
export async function desktopParity(
  options: DesktopParityOptions
): Promise<void> {
  const platform = options.platform ?? process.platform;
  const [first, second] = treeAutomations(platform);
  if (first === undefined)
    throw new Error(`MST has no desktop setup on ${platform}.`);
  if (second === undefined)
    throw new Error(
      `On ${platform} the default reads no accessibility tree (Computer Use), so there is nothing to compare ${first} with. Run \`mst desktop snapshot\` and the live checks instead.`
    );
  const connectWith = options.connect ?? connect;
  // One after the other: both read the same idle screen, and neither waits
  // for the other's bus.
  const a = await readOnce(first, options.app, platform, connectWith);
  const b = await readOnce(second, options.app, platform, connectWith);
  const report = compareSnapshots(a, b);
  if (options.out !== undefined)
    await writeFile(
      options.out,
      `${JSON.stringify({ report, snapshots: [a, b] }, null, 2)}\n`
    );
  process.stdout.write(`${formatParity(report)}\n`);
  if (report.differences.length) process.exitCode = 1;
}
