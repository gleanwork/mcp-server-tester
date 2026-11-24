import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  DesktopUi,
  DesktopUiNode,
} from '../../../evals/desktopUi/desktopUi.js';
import { desktopParity, desktopSnapshot } from './index.js';

function node(role: string, name: string, enabled = true): DesktopUiNode {
  return {
    id: `${role}:${name}`,
    role,
    name,
    visible: true,
    showing: true,
    enabled,
    selected: false,
  };
}

const reads: Record<string, DesktopUiNode[]> = {
  atspi: [node('frame', 'Claude'), node('button', 'Send', false)],
  'agent-desktop': [node('frame', 'Claude'), node('button', 'Send')],
};
const closed: string[] = [];
const connect = vi.fn(
  async (automation: string, app: string): Promise<DesktopUi> => ({
    snapshot: async () => reads[automation]!,
    readText: async () => '',
    activate: async () => {},
    reveal: async () => {},
    enterText: async () => {},
    openLink: async () => {},
    close: () => {
      closed.push(`${automation}:${app}`);
    },
  })
);

let directory: string;
let out: string;
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'mst-desktop-cli-'));
  closed.length = 0;
  connect.mockClear();
  process.exitCode = undefined;
  out = '';
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
    out += String(chunk);
    return true;
  });
});
afterEach(async () => {
  vi.restoreAllMocks();
  process.exitCode = undefined;
  await rm(directory, { recursive: true, force: true });
});

describe('mst desktop snapshot', () => {
  it('reads through the default transport on Linux and writes the snapshot', async () => {
    const file = join(directory, 'claude.json');
    await desktopSnapshot({
      app: 'Claude',
      out: file,
      connect,
      platform: 'linux',
    });
    expect(connect).toHaveBeenCalledExactlyOnceWith(
      'atspi',
      'Claude',
      expect.any(Number),
      'linux'
    );
    const written = JSON.parse(await readFile(file, 'utf8'));
    expect(written).toMatchObject({
      automation: 'atspi',
      app: 'Claude',
      os: 'linux',
      nodes: reads.atspi,
    });
    expect(written.durationMs).toBeGreaterThanOrEqual(0);
    expect(out).toMatch(
      /^2 nodes of Claude through atspi in \d+ ms, written to /
    );
    expect(closed).toEqual(['atspi:Claude']);
  });

  it('reads through the chosen transport, to stdout', async () => {
    await desktopSnapshot({
      app: 'Claude',
      automation: 'agent-desktop',
      connect,
      platform: 'linux',
    });
    expect(connect.mock.calls[0]![0]).toBe('agent-desktop');
    expect(JSON.parse(out)).toMatchObject({ automation: 'agent-desktop' });
  });

  it('defaults to agent-desktop on macOS, where the default reads no tree', async () => {
    await desktopSnapshot({ app: 'Claude', connect, platform: 'darwin' });
    expect(connect.mock.calls[0]![0]).toBe('agent-desktop');
    await expect(
      desktopSnapshot({
        app: 'Claude',
        automation: 'atspi',
        connect,
        platform: 'darwin',
      })
    ).rejects.toThrow(
      'atspi reads no accessibility tree on darwin; agent-desktop do'
    );
  });

  it('refuses an automation it does not know, and an OS with no desktop setup', async () => {
    await expect(
      desktopSnapshot({
        app: 'Claude',
        automation: 'xdotool',
        connect,
        platform: 'linux',
      })
    ).rejects.toThrow('"xdotool" names no desktop automation');
    await expect(
      desktopSnapshot({ app: 'Claude', connect, platform: 'win32' })
    ).rejects.toThrow('MST has no desktop setup on win32.');
    expect(connect).not.toHaveBeenCalled();
  });

  it('closes the connection when the read fails', async () => {
    const failing = vi.fn(
      async (): Promise<DesktopUi> => ({
        snapshot: async () => {
          throw new Error('accessibility_scan_timeout');
        },
        readText: async () => '',
        activate: async () => {},
        reveal: async () => {},
        enterText: async () => {},
        openLink: async () => {},
        close: () => {
          closed.push('failing');
        },
      })
    );
    await expect(
      desktopSnapshot({ app: 'Claude', connect: failing, platform: 'linux' })
    ).rejects.toThrow('accessibility_scan_timeout');
    expect(closed).toEqual(['failing']);
  });
});

describe('mst desktop parity', () => {
  it('reads through both transports in turn, lists the differences, and exits 1', async () => {
    const file = join(directory, 'parity.json');
    await desktopParity({
      app: 'Claude',
      out: file,
      connect,
      platform: 'linux',
    });
    expect(connect.mock.calls.map((call) => call[0])).toEqual([
      'atspi',
      'agent-desktop',
    ]);
    expect(closed).toEqual(['atspi:Claude', 'agent-desktop:Claude']);
    expect(out).toContain('1 the same, 1 different');
    expect(out).toContain('button "Send": states differ');
    expect(process.exitCode).toBe(1);
    const written = JSON.parse(await readFile(file, 'utf8'));
    expect(written.report.differences).toHaveLength(1);
    expect(
      written.snapshots.map((s: { automation: string }) => s.automation)
    ).toEqual(['atspi', 'agent-desktop']);
  });

  it('exits 0 when the reads agree', async () => {
    reads['agent-desktop'] = reads.atspi!;
    try {
      await desktopParity({ app: 'Claude', connect, platform: 'linux' });
    } finally {
      reads['agent-desktop'] = [
        node('frame', 'Claude'),
        node('button', 'Send'),
      ];
    }
    expect(out).toContain('2 the same, 0 different');
    expect(process.exitCode).toBeUndefined();
  });

  it('has nothing to compare on macOS, and says what to run instead', async () => {
    await expect(
      desktopParity({ app: 'Claude', connect, platform: 'darwin' })
    ).rejects.toThrow(
      'On darwin the default reads no accessibility tree (Computer Use), so there is nothing to compare agent-desktop with.'
    );
    expect(connect).not.toHaveBeenCalled();
  });
});
