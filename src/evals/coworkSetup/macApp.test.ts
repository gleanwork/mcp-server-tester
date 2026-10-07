import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  acquireMacCoworkApp,
  macCoworkAppVersion,
  readMacCoworkAppVersion,
  removeMacCoworkApp,
  resolveMacCoworkRelease,
} from './macApp.js';

const { execute } = vi.hoisted(() => ({
  execute:
    vi.fn<
      (
        file: string,
        args: string[],
        options: { env: Record<string, string> }
      ) => Promise<{ stdout: string; stderr?: string }>
    >(),
}));
vi.mock('node:child_process', async () => {
  const { promisify } = await import('node:util');
  return { execFile: Object.assign(vi.fn(), { [promisify.custom]: execute }) };
});
vi.mock('node:os', async (original) => ({
  ...(await original<typeof os>()),
  tmpdir: vi.fn(),
}));
const actualOs = await vi.importActual<typeof os>('node:os');
const version = '1.52386.6';
const archive = Buffer.from('synthetic signed archive, never executed');
function feed() {
  return {
    currentRelease: version,
    releases: [
      {
        version,
        updateTo: {
          version,
          url: `https://downloads.claude.ai/releases/darwin/universal/${version}/Claude-abc123.zip`,
          sha256: createHash('sha256').update(archive).digest('hex'),
          size: archive.length,
        },
      },
    ],
  };
}
let root: string;
let directory: string;
beforeEach(async () => {
  root = await fs.realpath(
    await fs.mkdtemp(join(actualOs.tmpdir(), 'mst-app-test-'))
  );
  vi.mocked(os.tmpdir).mockReturnValue(root);
  vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin');
  directory = join(
    root,
    'mst-cowork-session-11111111-2222-4333-8444-555555555555-app'
  );
  execute
    .mockReset()
    .mockImplementation(async (file: string, args: string[]) => {
      if (file === '/usr/bin/curl') {
        const output = args[args.indexOf('--output') + 1]!;
        await fs.writeFile(
          output,
          output.endsWith('.json') ? JSON.stringify(feed()) : archive
        );
      }
      if (file === '/usr/bin/ditto')
        await fs.mkdir(join(args.at(-1)!, 'Claude.app'));
      return {
        stdout: file === '/usr/bin/plutil' ? version + '\n' : '',
        stderr: '',
      };
    });
});
afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(root, { recursive: true, force: true });
});
describe('pinned Mac bundle provisioning (native execution mocked)', () => {
  it('has no default pin: only the eval config pins a version', () => {
    expect(macCoworkAppVersion(undefined, {})).toBeUndefined();
    expect(macCoworkAppVersion('2.3.4', {})).toBe('2.3.4');
    for (const value of ['latest', '../Claude', '1.2', '1.2.3\n'])
      expect(() => macCoworkAppVersion(value, {})).toThrow(
        'Invalid clientOptions.appVersion'
      );
    expect(() =>
      macCoworkAppVersion(version, { MST_COWORK_APP_PATH: '/app' })
    ).toThrow('not both');
    // The old environment pin fails loudly rather than silently unpinning.
    expect(() =>
      macCoworkAppVersion(undefined, { MST_COWORK_APP_VERSION: version })
    ).toThrow('clientOptions.appVersion');
  });
  it('reads an exact installed version and rejects anything else', async () => {
    execute.mockResolvedValueOnce({ stdout: '2.19675.1\n' });
    await expect(
      readMacCoworkAppVersion('/Applications/Claude.app')
    ).resolves.toBe('2.19675.1');
    expect(execute.mock.calls.at(-1)?.[1].at(-1)).toBe(
      '/Applications/Claude.app/Contents/Info.plist'
    );
    for (const stdout of ['', '2.2553', 'latest\n'])
      await expect(
        (execute.mockResolvedValueOnce({ stdout }),
        readMacCoworkAppVersion('/Applications/Claude.app'))
      ).rejects.toThrow('Unable to read the Claude Desktop version.');
  });
  it('accepts only an exact pin from the trusted release directory', () => {
    expect(resolveMacCoworkRelease(feed(), version).version).toBe(version);
    for (const url of [
      'http://downloads.claude.ai/Claude.zip',
      'https://evil.test/Claude.zip',
      `https://downloads.claude.ai/releases/darwin/universal/${version}/extra/Claude-abc.zip`,
      `https://downloads.claude.ai/releases/darwin/universal/${version}/Claude-abc.zip?token=secret`,
      `https://user@downloads.claude.ai/releases/darwin/universal/${version}/Claude-abc.zip`,
    ]) {
      const data = feed();
      data.releases[0]!.updateTo.url = url;
      expect(() => resolveMacCoworkRelease(data, version)).toThrow();
    }
    const data = feed();
    data.currentRelease = '2.0.0';
    expect(() => resolveMacCoworkRelease(data, version)).toThrow('unavailable');
    expect(() => resolveMacCoworkRelease(feed(), '2.0.0')).toThrow();
  });
  it('downloads privately, verifies bytes, signature and version, then removes only owned scratch', async () => {
    const app = await acquireMacCoworkApp(directory, version);
    expect(app).toBe(join(directory, 'unpacked/Claude.app'));
    expect((await fs.stat(directory)).mode & 0o777).toBe(0o700);
    const calls = execute.mock.calls;
    expect(calls.map(([file]) => file)).toEqual([
      '/usr/bin/curl',
      '/usr/bin/curl',
      '/usr/bin/ditto',
      '/usr/bin/codesign',
      '/usr/bin/plutil',
    ]);
    expect(calls[0]![1]).toContain('--disable');
    expect(calls[0]![1]).not.toContain('--location');
    expect(String(calls[0]![1].at(-1))).toContain('maxVersion=1.52386.6');
    expect(calls[3]![1]).toContain(
      '=anchor apple generic and identifier "com.anthropic.claudefordesktop" and certificate leaf[subject.OU] = "Q6L2SF6YDW"'
    );
    for (const call of calls)
      expect(Object.keys(call[2].env).sort()).toEqual(['PATH', 'TMPDIR']);
    await expect(fs.stat(join(directory, 'Claude.zip'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
    await removeMacCoworkApp(directory);
    await removeMacCoworkApp(directory);
    expect(await fs.readdir(root)).toEqual([]);
  });
  it.each([
    'download',
    'checksum verification',
    'signature verification',
    'bundle version verification',
  ])(
    'fails closed at %s and retains scratch for the owning session cleanup',
    async (phase) => {
      const original = execute.getMockImplementation()!;
      execute.mockImplementation(async (file, args, options) => {
        if (
          phase === 'download' &&
          file === '/usr/bin/curl' &&
          args.at(-1)!.endsWith('.zip')
        )
          throw new Error('secret native output');
        if (phase === 'signature verification' && file === '/usr/bin/codesign')
          throw new Error('secret native output');
        const result = await original(file, args, options);
        if (
          phase === 'checksum verification' &&
          file === '/usr/bin/curl' &&
          args.at(-1)!.endsWith('.zip')
        )
          await fs.writeFile(
            join(directory, 'Claude.zip'),
            Buffer.alloc(archive.length)
          );
        if (
          phase === 'bundle version verification' &&
          file === '/usr/bin/plutil'
        )
          return { stdout: '2.0.0' };
        return result;
      });
      await expect(acquireMacCoworkApp(directory, version)).rejects.toThrow(
        `${phase} failed`
      );
      if (phase === 'checksum verification')
        expect(
          execute.mock.calls.some(([file]) => file === '/usr/bin/ditto')
        ).toBe(false);
      await removeMacCoworkApp(directory);
      expect(await fs.readdir(root)).toEqual([]);
    }
  );
  it('does not write or execute off macOS', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('linux');
    await expect(acquireMacCoworkApp(directory, version)).rejects.toThrow(
      'requires macOS'
    );
    expect(execute).not.toHaveBeenCalled();
    expect(await fs.readdir(root)).toEqual([]);
  });
  it('refuses cleanup of unrelated or symlinked directories', async () => {
    await expect(removeMacCoworkApp(root)).rejects.toThrow('Invalid temporary');
    const other = join(root, 'other');
    await fs.mkdir(other);
    await fs.symlink(other, directory);
    await expect(removeMacCoworkApp(directory)).rejects.toThrow(
      'ownership changed'
    );
    expect((await fs.stat(other)).isDirectory()).toBe(true);
  });
});
