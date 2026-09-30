import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  assertStoppedOwner,
  recoverMacCoworkSession,
} from './recoverSession.js';
const mock = vi.hoisted(() => ({
  home: '',
  restore: vi.fn(),
  stop: vi.fn(),
  start: vi.fn(),
  state: vi.fn(),
  localMcpRestore: vi.fn(),
  removeApp: vi.fn(),
}));
vi.mock('node:os', async (original) => ({
  ...(await original<object>()),
  homedir: () => mock.home,
}));
vi.mock('./macController.js', () => ({
  getMacCoworkController: async () => ({
    state: mock.state,
    stop: mock.stop,
    start: mock.start,
  }),
}));
vi.mock('./macTransaction.js', () => ({
  restoreMacCoworkSettings: mock.restore,
}));
vi.mock('./macLocalMcp.js', () => ({
  restoreMacLocalMcp: mock.localMcpRestore,
}));
vi.mock('./macApp.js', () => ({
  removeMacCoworkApp: mock.removeApp,
}));

afterEach(() => vi.restoreAllMocks());
describe('recovery owner check', () => {
  it('accepts only ESRCH, never EPERM or a live process', () => {
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => {
      throw Object.assign(new Error(), { code: 'ESRCH' });
    });
    expect(() => assertStoppedOwner(123)).not.toThrow();
    kill.mockImplementation(() => {
      throw Object.assign(new Error(), { code: 'EPERM' });
    });
    expect(() => assertStoppedOwner(123)).toThrow('Cannot confirm');
    kill.mockReturnValue(true);
    expect(() => assertStoppedOwner(123)).toThrow('still running');
  });
});
describe('explicit session recovery (no native execution)', () => {
  let dir: string,
    profile: string,
    lease: string,
    stage: string,
    transaction: string;
  beforeEach(async () => {
    vi.resetAllMocks();
    vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin');
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cowork-recovery-test-'));
    mock.home = dir;
    profile = path.join(
      dir,
      'Library/Application Support/Claude-3p/configLibrary'
    );
    lease = path.join(profile, '.mst-session-lock');
    transaction = path.join(profile, '.mst-setup-lock');
    stage = path.join(dir, 'stage');
    await fs.mkdir(lease, { recursive: true, mode: 0o700 });
    await fs.mkdir(transaction, { mode: 0o700 });
    await fs.mkdir(stage);
    await fs.writeFile(
      path.join(lease, 'session.json'),
      JSON.stringify({
        version: 1,
        nonce: '11111111-1111-4111-8111-111111111111',
        pid: 123,
        profileDirectory: profile,
        stagingDirectory: stage,
        wasRunning: false,
      }),
      { mode: 0o600 }
    );
    await fs.writeFile(
      path.join(transaction, 'journal.json'),
      JSON.stringify({ directory: stage }),
      { mode: 0o600 }
    );
    vi.spyOn(process, 'kill').mockImplementation(() => {
      throw Object.assign(new Error(), { code: 'ESRCH' });
    });
    mock.state.mockResolvedValue({ running: false });
    mock.localMcpRestore.mockImplementation(async (directory: string) => {
      await fs.rm(directory, { recursive: true, force: true });
    });
    mock.removeApp.mockImplementation(async (directory: string) => {
      await fs.rm(directory, { recursive: true, force: true });
    });
    mock.restore.mockImplementation(async () => {
      await fs.rm(transaction, { recursive: true });
      await fs.rmdir(stage);
    });
  });
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });
  async function pinnedReceipt(wasRunning = false) {
    const file = path.join(lease, 'session.json');
    const receipt = JSON.parse(await fs.readFile(file, 'utf8'));
    await fs.writeFile(
      file,
      JSON.stringify({
        ...receipt,
        wasRunning,
        pinnedApp: true,
        localMcp: true,
        restoreAppPath: '/Applications/Claude.app',
      })
    );
    await fs.mkdir(`${stage}-app`, { mode: 0o700 });
    await fs.mkdir(`${stage}-mcp`, { mode: 0o700 });
    await fs.writeFile(
      path.join(`${stage}-mcp`, 'credential.json'),
      'synthetic-only',
      { mode: 0o600 }
    );
  }
  async function fullyClean() {
    for (const file of [
      lease,
      transaction,
      stage,
      `${stage}-app`,
      `${stage}-mcp`,
      path.join(profile, '.mst-recovery-lock'),
    ])
      await expect(fs.lstat(file)).rejects.toMatchObject({ code: 'ENOENT' });
  }
  it.each([false, true])(
    'recovers pinned app and private MCP files with prior running=%s',
    async (wasRunning) => {
      await pinnedReceipt(wasRunning);
      let running = true;
      mock.state.mockImplementation(async () => ({ running }));
      mock.stop.mockImplementation(async () => {
        running = false;
      });
      mock.start.mockImplementation(async () => {
        running = true;
      });
      await recoverMacCoworkSession();
      expect(running).toBe(wasRunning);
      expect(mock.localMcpRestore).toHaveBeenCalledWith(`${stage}-mcp`);
      expect(mock.removeApp).toHaveBeenCalledWith(`${stage}-app`);
      expect(mock.stop.mock.invocationCallOrder[0]).toBeLessThan(
        mock.localMcpRestore.mock.invocationCallOrder[0]!
      );
      expect(mock.localMcpRestore.mock.invocationCallOrder[0]).toBeLessThan(
        mock.restore.mock.invocationCallOrder[0]!
      );
      expect(mock.restore.mock.invocationCallOrder[0]).toBeLessThan(
        mock.removeApp.mock.invocationCallOrder[0]!
      );
      if (wasRunning)
        expect(mock.start.mock.invocationCallOrder[0]).toBeLessThan(
          mock.removeApp.mock.invocationCallOrder[0]!
        );
      else expect(mock.start).not.toHaveBeenCalled();
      await fullyClean();
      await recoverMacCoworkSession();
      expect(mock.removeApp).toHaveBeenCalledTimes(1);
    }
  );
  it('retains private recovery state on MCP restore failure and supports retry', async () => {
    await pinnedReceipt();
    mock.localMcpRestore.mockRejectedValueOnce(new Error('config changed'));
    await expect(recoverMacCoworkSession()).rejects.toThrow('config changed');
    await fs.access(path.join(lease, 'session.json'));
    await fs.access(path.join(`${stage}-mcp`, 'credential.json'));
    await fs.access(`${stage}-app`);
    expect(mock.restore).not.toHaveBeenCalled();
    expect(mock.removeApp).not.toHaveBeenCalled();
    await recoverMacCoworkSession();
    await fullyClean();
  });
  it('retains the receipt after bundle removal failure and retries after settings were restored', async () => {
    await pinnedReceipt();
    mock.removeApp.mockRejectedValueOnce(new Error('bundle busy'));
    await expect(recoverMacCoworkSession()).rejects.toThrow('bundle busy');
    await fs.access(path.join(lease, 'session.json'));
    await fs.access(`${stage}-app`);
    await expect(fs.lstat(transaction)).rejects.toMatchObject({
      code: 'ENOENT',
    });
    await recoverMacCoworkSession();
    expect(mock.restore).toHaveBeenCalledTimes(1);
    await fullyClean();
  });
  it('does not delete a caller-owned app override', async () => {
    await recoverMacCoworkSession();
    expect(mock.removeApp).not.toHaveBeenCalled();
  });
  it('never restores or removes files if Claude refuses to stop', async () => {
    await pinnedReceipt();
    mock.state.mockResolvedValue({ running: true });
    await expect(recoverMacCoworkSession()).rejects.toThrow(
      'Claude did not stop'
    );
    expect(mock.localMcpRestore).not.toHaveBeenCalled();
    expect(mock.restore).not.toHaveBeenCalled();
    expect(mock.removeApp).not.toHaveBeenCalled();
    await fs.access(path.join(lease, 'session.json'));
  });
  it('does not recover a session whose owner is still alive', async () => {
    await pinnedReceipt();
    vi.mocked(process.kill).mockReturnValue(true);
    await expect(recoverMacCoworkSession()).rejects.toThrow('still running');
    expect(mock.stop).not.toHaveBeenCalled();
    expect(mock.localMcpRestore).not.toHaveBeenCalled();
    expect(mock.removeApp).not.toHaveBeenCalled();
  });
  it('removes the receipt only after verified restore succeeds', async () => {
    await recoverMacCoworkSession();
    expect(mock.restore).toHaveBeenCalledWith(profile);
    await expect(fs.stat(lease)).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it('retains the receipt on transaction restore failure', async () => {
    mock.restore.mockRejectedValueOnce(new Error('hash mismatch'));
    await expect(recoverMacCoworkSession()).rejects.toThrow('hash mismatch');
    expect(
      await fs.readFile(path.join(lease, 'session.json'), 'utf8')
    ).toContain('123');
  });
  it('does not stop Claude when staging does not match the receipt', async () => {
    await fs.writeFile(
      path.join(transaction, 'journal.json'),
      JSON.stringify({ directory: '/other' })
    );
    await expect(recoverMacCoworkSession()).rejects.toThrow('staging mismatch');
    expect(mock.stop).not.toHaveBeenCalled();
    expect(mock.restore).not.toHaveBeenCalled();
  });
});
