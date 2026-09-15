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
describe.skipIf(process.platform !== 'darwin')(
  'explicit session recovery',
  () => {
    let dir: string,
      profile: string,
      lease: string,
      stage: string,
      transaction: string;
    beforeEach(async () => {
      vi.clearAllMocks();
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
      mock.restore.mockImplementation(async () => {
        await fs.rm(transaction, { recursive: true });
        await fs.rmdir(stage);
      });
    });
    afterEach(async () => {
      await fs.rm(dir, { recursive: true, force: true });
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
      await expect(recoverMacCoworkSession()).rejects.toThrow(
        'staging mismatch'
      );
      expect(mock.stop).not.toHaveBeenCalled();
      expect(mock.restore).not.toHaveBeenCalled();
    });
  }
);
