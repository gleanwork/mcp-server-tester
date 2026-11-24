/**
 * Parity of two reads of one screen (ADR 0017): what the drivers would see
 * differently through two transports of the desktop interface. Controls are
 * matched by role and name, in the order each read lists them, because that
 * is what a driver's rules match on. Tree shape is not compared: the
 * transports nest controls differently, and no rule depends on it.
 */
import type { DesktopUiNode } from './desktopUi.js';

/** What a read of one screen looks like in a snapshot file and a parity report. */
export interface RecordedSnapshot {
  /** The transport that read it: `atspi`, `agent-desktop`, ... */
  automation: string;
  /** The accessible application's name that was read. */
  app: string;
  os: string;
  takenAt: string;
  /** How long the read took. */
  durationMs: number;
  /** The transport's own version, where it has one (agent-desktop's). */
  automationVersion?: string;
  nodes: DesktopUiNode[];
}

type Control = Pick<
  DesktopUiNode,
  'role' | 'name' | 'visible' | 'showing' | 'enabled' | 'selected'
>;

interface ParityDifference {
  role: string;
  name: string;
  /** Which read has this control that the other has not, or `both` when its states differ. */
  in: 'first' | 'second' | 'both';
  first?: Omit<Control, 'role' | 'name'>;
  second?: Omit<Control, 'role' | 'name'>;
}

export interface ParityReport {
  first: { automation: string; controls: number; durationMs: number };
  second: { automation: string; controls: number; durationMs: number };
  /** Controls both reads list with the same role, name and states. */
  same: number;
  differences: ParityDifference[];
}

function key(node: Control): string {
  return `${node.role}\u0000${node.name}`;
}

function states(node: Control): Omit<Control, 'role' | 'name'> {
  return {
    visible: node.visible,
    showing: node.showing,
    enabled: node.enabled,
    selected: node.selected,
  };
}

function sameStates(a: Control, b: Control): boolean {
  return (
    a.visible === b.visible &&
    a.showing === b.showing &&
    a.enabled === b.enabled &&
    a.selected === b.selected
  );
}

/** Nodes a driver's rules can match: those with a name. Layout has none. */
function controls(nodes: readonly DesktopUiNode[]): Control[] {
  return nodes.filter((node) => node.name !== '');
}

export function compareSnapshots(
  first: RecordedSnapshot,
  second: RecordedSnapshot
): ParityReport {
  const a = controls(first.nodes);
  const b = controls(second.nodes);
  // The nth control of a role and name in one read matches the nth in the other.
  const pending = new Map<string, Control[]>();
  for (const node of b) {
    const list = pending.get(key(node)) ?? [];
    list.push(node);
    pending.set(key(node), list);
  }
  const differences: ParityDifference[] = [];
  let same = 0;
  for (const node of a) {
    const match = pending.get(key(node))?.shift();
    if (!match) {
      differences.push({
        role: node.role,
        name: node.name,
        in: 'first',
        first: states(node),
      });
    } else if (sameStates(node, match)) {
      same += 1;
    } else {
      differences.push({
        role: node.role,
        name: node.name,
        in: 'both',
        first: states(node),
        second: states(match),
      });
    }
  }
  for (const list of pending.values())
    for (const node of list)
      differences.push({
        role: node.role,
        name: node.name,
        in: 'second',
        second: states(node),
      });
  return {
    first: {
      automation: first.automation,
      controls: a.length,
      durationMs: first.durationMs,
    },
    second: {
      automation: second.automation,
      controls: b.length,
      durationMs: second.durationMs,
    },
    same,
    differences,
  };
}

/** The report as lines for a terminal. */
export function formatParity(report: ParityReport): string {
  const lines = [
    `${report.first.automation}: ${report.first.controls} controls in ${report.first.durationMs} ms`,
    `${report.second.automation}: ${report.second.controls} controls in ${report.second.durationMs} ms`,
    `${report.same} the same, ${report.differences.length} different`,
  ];
  for (const difference of report.differences) {
    const where =
      difference.in === 'both'
        ? `states differ: ${report.first.automation} ${flags(difference.first!)}, ${report.second.automation} ${flags(difference.second!)}`
        : `only in ${difference.in === 'first' ? report.first.automation : report.second.automation}`;
    lines.push(`  ${difference.role} "${difference.name}": ${where}`);
  }
  return lines.join('\n');
}

function flags(control: Omit<Control, 'role' | 'name'>): string {
  const on = (Object.keys(control) as (keyof typeof control)[]).filter(
    (name) => control[name]
  );
  return on.length ? on.join(',') : 'none';
}
