import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MAC_COWORK_CONTROLLER_SOURCE } from './macControllerSource.js';

const { execute } = vi.hoisted(() => ({ execute: vi.fn() }));
vi.mock('node:child_process', async () => {
  const { promisify } = await import('node:util');
  return { execFile: Object.assign(vi.fn(), { [promisify.custom]: execute }) };
});
vi.mock('node:os', async (original) => ({
  ...(await original<typeof os>()),
  tmpdir: vi.fn(),
}));
const actualOs = await vi.importActual<typeof os>('node:os');
let root: string;
beforeEach(async () => {
  vi.resetModules();
  vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin');
  root = await fs.realpath(
    await fs.mkdtemp(join(actualOs.tmpdir(), 'mst-native-test-'))
  );
  vi.mocked(os.tmpdir).mockReturnValue(root);
  execute
    .mockReset()
    .mockImplementation(async (file: string, args: string[]) => {
      if (file === '/usr/bin/xcrun') {
        await fs.writeFile(args[3]!, 'synthetic executable, never run', {
          mode: 0o700,
        });
        return { stdout: '', stderr: '' };
      }
      return {
        stdout: JSON.stringify(
          args[0] === 'state'
            ? {
                running: false,
                instances: 0,
                workspaceApplicationCount: 10,
                claudeBundleReadable: true,
                accessibilityTrusted: false,
              }
            : args[0] === 'stop'
              ? { stopped: true }
              : { launched: true }
        ),
        stderr: '',
      };
    });
});
afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(root, { recursive: true, force: true });
});

describe('bundled Mac native controller (all execution mocked)', () => {
  it('never executes or writes native scratch on non-macOS', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('linux');
    const { getMacCoworkController } = await import('./macController.js');
    await expect(getMacCoworkController()).rejects.toThrow(
      'Unable to control the Mac Cowork application safely.'
    );
    expect(execute).not.toHaveBeenCalled();
    expect(await fs.readdir(root)).toEqual([]);
  });
  it('compiles embedded source once per process and bounds output/time with no credential environment', async () => {
    const { getMacCoworkController } = await import('./macController.js');
    const [first, second] = await Promise.all([
      getMacCoworkController(),
      getMacCoworkController(),
    ]);
    expect(first).toBe(second);
    expect(await first.state()).toEqual({ running: false });
    await first.stop();
    await first.start();
    expect(execute).toHaveBeenCalledTimes(4);
    const [file, args, options] = execute.mock.calls[0]! as [
      string,
      string[],
      { maxBuffer: number; timeout: number; env: Record<string, string> },
    ];
    expect(file).toBe('/usr/bin/xcrun');
    expect(args[0]).toBe('swiftc');
    expect(await fs.readFile(args[1]!, 'utf8')).toBe(
      MAC_COWORK_CONTROLLER_SOURCE
    );
    expect((await fs.stat(args[1]!)).mode & 0o777).toBe(0o600);
    expect((await fs.stat(args[3]!)).mode & 0o777).toBe(0o700);
    expect(options.maxBuffer).toBe(64 * 1024);
    expect(options.timeout).toBe(120_000);
    expect(Object.keys(options.env).sort()).toEqual(['PATH', 'TMPDIR']);
    expect(execute.mock.calls[1]![2]).toMatchObject({
      timeout: 30_000,
      maxBuffer: 16 * 1024,
    });
  });
  it.each([
    {
      running: false,
      instances: 0,
      workspaceApplicationCount: 0,
      claudeBundleReadable: true,
    },
    {
      running: false,
      instances: 0,
      workspaceApplicationCount: 5,
      claudeBundleReadable: false,
    },
    {
      running: true,
      instances: 2,
      workspaceApplicationCount: 5,
      claudeBundleReadable: true,
    },
    {
      running: true,
      instances: 0,
      workspaceApplicationCount: 5,
      claudeBundleReadable: true,
    },
    { running: 'synthetic-secret' },
  ])(
    'rejects unavailable or inconsistent native state without revealing output: %j',
    async (state) => {
      const { getMacCoworkController } = await import('./macController.js');
      const controller = await getMacCoworkController();
      execute.mockResolvedValueOnce({ stdout: JSON.stringify(state) });
      await expect(controller.state()).rejects.toThrow(
        'Unable to control the Mac Cowork application safely.'
      );
    }
  );
  it('sanitizes compiler errors, cleans scratch and permits a later retry', async () => {
    const { getMacCoworkController } = await import('./macController.js');
    execute.mockRejectedValueOnce(
      new Error('synthetic-secret compiler stderr')
    );
    await expect(getMacCoworkController()).rejects.toThrow(
      'Unable to control the Mac Cowork application safely.'
    );
    expect(await fs.readdir(root)).toEqual([]);
    await getMacCoworkController();
    expect(execute).toHaveBeenCalledTimes(2);
  });
  it.each(['stop', 'start'] as const)(
    'sanitizes %s failures without fallback or force-kill',
    async (action) => {
      const { getMacCoworkController } = await import('./macController.js');
      const controller = await getMacCoworkController();
      execute.mockRejectedValueOnce(
        new Error('synthetic-secret native stderr')
      );
      await expect(controller[action]()).rejects.toThrow(
        'Unable to control the Mac Cowork application safely.'
      );
      expect(execute).toHaveBeenCalledTimes(2);
    }
  );
});
