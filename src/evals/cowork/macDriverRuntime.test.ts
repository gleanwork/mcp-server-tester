/**
 * The macOS driver's own runtime, over a stand-in for the agent-desktop CLI
 * and the UI seam: each operation gives agent-desktop a private state
 * directory and removes it, whether the operation connects or not.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname } from 'node:path';
import type * as AgentDesktopModule from '../agentDesktop.js';
import { CoworkDriverError } from './interaction.js';
import type { LinuxUi, LinuxUiNode } from './linuxUi.js';

const fake = vi.hoisted(() => ({
  /** The state directory of each agent-desktop the driver made. */
  homes: [] as (string | undefined)[],
  /** Whether each state directory existed when the UI seam connected. */
  existed: [] as boolean[],
  closed: 0,
  connectError: undefined as Error | undefined,
}));
vi.mock('../agentDesktop.js', async (original) => ({
  ...(await original<typeof AgentDesktopModule>()),
  agentDesktopBinary: () => '/fake/agent-desktop',
  agentDesktop: (options: { env?: NodeJS.ProcessEnv }) => {
    fake.homes.push(options.env?.AGENT_DESKTOP_HOME);
    return { home: options.env?.AGENT_DESKTOP_HOME };
  },
}));
vi.mock('./macUi.js', () => ({
  connectMacUi: async (options: { desktop: { home?: string } }) => {
    fake.existed.push(existsSync(options.desktop.home ?? ''));
    if (fake.connectError) throw fake.connectError;
    return readySurface();
  },
}));
const { macDriverAvailable, runMacDriver } = await import('./macDriver.js');

function node(name: string, role = 'button', selected = false): LinuxUiNode {
  return {
    id: `${role}:${name}`,
    name,
    role,
    visible: true,
    showing: true,
    enabled: true,
    selected,
  };
}

/** A ready account-mode Cowork surface that no operation here acts on. */
function readySurface(): LinuxUi {
  const never = async () => {
    throw new Error('a readiness check never acts');
  };
  return {
    snapshot: async () => [
      node('Cowork', 'radio button', true),
      node('Chat', 'radio button'),
      node('Write your prompt to Claude', 'entry'),
      node('Model: Opus 5.5 Medium'),
    ],
    readText: async () => '',
    activate: never,
    reveal: never,
    paste: never,
    openCowork: never,
    openNewTask: never,
    close() {
      fake.closed += 1;
    },
  };
}

beforeEach(() => {
  fake.homes = [];
  fake.existed = [];
  fake.closed = 0;
  fake.connectError = undefined;
});
afterEach(() => vi.unstubAllEnvs());

const options = () => ({
  deadlineAt: Date.now() + 20_000,
  appPath: '/Applications/Claude.app',
});

describe("the macOS driver's agent-desktop state", () => {
  it('is available when agent-desktop is installed', () => {
    expect(macDriverAvailable()).toBe(true);
  });

  it('gives each operation a private state directory and removes it afterwards', async () => {
    // The user's own setting never reaches agent-desktop.
    vi.stubEnv('AGENT_DESKTOP_HOME', '/Users/someone/.agent-desktop');
    await expect(runMacDriver('probe', {}, options())).resolves.toMatchObject({
      status: 'ready',
    });
    await runMacDriver('probe', {}, options());

    const [first, second] = fake.homes;
    expect(first).not.toBe(second);
    for (const home of [first, second]) {
      expect(dirname(home!)).toBe(tmpdir().replace(/\/$/, ''));
      expect(basename(home!)).toMatch(/^mst-agent-desktop-/);
      expect(existsSync(home!)).toBe(false);
    }
    // Each directory was there while its operation ran.
    expect(fake.existed).toEqual([true, true]);
    expect(fake.closed).toBe(2);
  });

  it('removes the state directory when connecting fails', async () => {
    fake.connectError = new Error('no window');
    await expect(runMacDriver('probe', {}, options())).rejects.toBeInstanceOf(
      CoworkDriverError
    );
    expect(fake.existed).toEqual([true]);
    expect(existsSync(fake.homes[0]!)).toBe(false);
    expect(fake.closed).toBe(0);
  });
});
