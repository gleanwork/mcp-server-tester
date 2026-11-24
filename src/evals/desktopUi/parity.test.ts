import { describe, expect, it } from 'vitest';
import type { DesktopUiNode } from './desktopUi.js';
import {
  compareSnapshots,
  formatParity,
  type RecordedSnapshot,
} from './parity.js';

function node(
  role: string,
  name: string,
  states: Partial<DesktopUiNode> = {}
): DesktopUiNode {
  return {
    id: `${role}:${name}`,
    role,
    name,
    visible: true,
    showing: true,
    enabled: true,
    selected: false,
    ...states,
  };
}

function read(
  automation: string,
  nodes: DesktopUiNode[],
  durationMs = 10
): RecordedSnapshot {
  return {
    automation,
    app: 'App',
    os: 'linux',
    takenAt: '2026-11-23T00:00:00.000Z',
    durationMs,
    nodes,
  };
}

describe('compareSnapshots', () => {
  it('matches controls by role and name, whatever their nesting or order', () => {
    const first = read('atspi', [
      node('frame', 'App'),
      node('section', ''),
      node('button', 'Send'),
      node('entry', 'Prompt'),
    ]);
    const second = read(
      'agent-desktop',
      [
        node('frame', 'App'),
        node('entry', 'Prompt', { id: 'other' }),
        node('button', 'Send', { id: 'x' }),
      ],
      580
    );
    expect(compareSnapshots(first, second)).toEqual({
      first: { automation: 'atspi', controls: 3, durationMs: 10 },
      second: { automation: 'agent-desktop', controls: 3, durationMs: 580 },
      same: 3,
      differences: [],
    });
  });

  it('lists a control one read has and the other has not, and a control whose states differ', () => {
    const report = compareSnapshots(
      read('atspi', [
        node('button', 'Send', { enabled: false }),
        node('static', 'Only here'),
        node('menu item', 'Fast'),
        node('menu item', 'Fast'),
      ]),
      read('agent-desktop', [
        node('button', 'Send'),
        node('menu item', 'Fast'),
        node('link', 'Only there', { showing: false }),
      ])
    );
    expect(report.same).toBe(1);
    expect(report.differences).toEqual([
      {
        role: 'button',
        name: 'Send',
        in: 'both',
        first: {
          visible: true,
          showing: true,
          enabled: false,
          selected: false,
        },
        second: {
          visible: true,
          showing: true,
          enabled: true,
          selected: false,
        },
      },
      {
        role: 'static',
        name: 'Only here',
        in: 'first',
        first: { visible: true, showing: true, enabled: true, selected: false },
      },
      // The second "Fast": one read lists it twice.
      {
        role: 'menu item',
        name: 'Fast',
        in: 'first',
        first: { visible: true, showing: true, enabled: true, selected: false },
      },
      {
        role: 'link',
        name: 'Only there',
        in: 'second',
        second: {
          visible: true,
          showing: false,
          enabled: true,
          selected: false,
        },
      },
    ]);
    expect(formatParity(report)).toBe(
      [
        'atspi: 4 controls in 10 ms',
        'agent-desktop: 3 controls in 10 ms',
        '1 the same, 4 different',
        '  button "Send": states differ: atspi visible,showing, agent-desktop visible,showing,enabled',
        '  static "Only here": only in atspi',
        '  menu item "Fast": only in atspi',
        '  link "Only there": only in agent-desktop',
      ].join('\n')
    );
  });
});
