import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

interface ExecOptions {
  env: Record<string, string | undefined>;
  cwd: string;
  timeout: number;
  maxBuffer: number;
}

const { execute, stdinWrites } = vi.hoisted(() => ({
  execute: vi.fn(),
  stdinWrites: [] as string[],
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

/** A promisified execFile result, with the child's stdin like Node attaches it. */
function result(outcome: string | Error, options: { stdinError?: Error } = {}) {
  const promise =
    typeof outcome === 'string'
      ? Promise.resolve({ stdout: outcome, stderr: '' })
      : Promise.reject(outcome);
  return Object.assign(promise, {
    child: {
      stdin: {
        on: (event: string, handler: (error: Error) => void) => {
          if (event === 'error' && options.stdinError) {
            handler(options.stdinError);
          }
        },
        end: (value: string) => stdinWrites.push(value),
      },
    },
  });
}

let root: string;
beforeEach(async () => {
  vi.resetModules();
  stdinWrites.length = 0;
  root = await fs.realpath(
    await fs.mkdtemp(join(actualOs.tmpdir(), 'mst-helper-test-'))
  );
  vi.mocked(os.tmpdir).mockReturnValue(root);
  execute.mockReset().mockImplementation((file: string, args: string[]) => {
    if (file === '/usr/bin/xcrun') {
      return fs
        .writeFile(args[3]!, 'synthetic executable, never run', { mode: 0o700 })
        .then(() => ({ stdout: '', stderr: '' }));
    }
    return result(JSON.stringify({ ok: true, args }));
  });
});
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await fs.rm(root, { recursive: true, force: true });
});

describe('compileSwiftHelper (all execution mocked)', () => {
  it('builds privately with no caller credentials', async () => {
    vi.stubEnv('MST_SYNTHETIC_SECRET', 'synthetic-secret');
    const { compileSwiftHelper } = await import('./nativeHelper.js');
    await compileSwiftHelper({ name: 'probe', source: 'print("hi")' });
    const [file, args, options] = execute.mock.calls[0]! as [
      string,
      string[],
      ExecOptions,
    ];
    expect(file).toBe('/usr/bin/xcrun');
    expect(args.slice(0, 1)).toEqual(['swiftc']);
    expect(args[1]).toMatch(/\/mst-probe-[^/]+\/controller\.swift$/);
    expect(await fs.readFile(args[1]!, 'utf8')).toBe('print("hi")');
    expect((await fs.stat(args[1]!)).mode & 0o777).toBe(0o600);
    expect((await fs.stat(args[3]!)).mode & 0o777).toBe(0o700);
    expect(options.env).toEqual({
      PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
      TMPDIR: options.cwd,
    });
    expect(options).toMatchObject({ timeout: 120_000, maxBuffer: 64 * 1024 });
  });

  it('runs under the minimal policy without caller credentials', async () => {
    vi.stubEnv('MST_SYNTHETIC_SECRET', 'synthetic-secret');
    const { compileSwiftHelper } = await import('./nativeHelper.js');
    const helper = await compileSwiftHelper({ name: 'probe', source: '' });
    expect(
      await helper.run(['state'], { environment: 'minimal', timeoutMs: 30_000 })
    ).toEqual({ ok: true, args: ['state'] });
    const options = execute.mock.calls[1]![2] as ExecOptions;
    expect(Object.keys(options.env).sort()).toEqual(['PATH', 'TMPDIR']);
    expect(options).toMatchObject({ timeout: 30_000, maxBuffer: 16 * 1024 });
    // stdin is always closed, so a helper never waits on it.
    expect(stdinWrites).toEqual(['']);
  });

  it('passes the test environment under the inherit policy and writes stdin', async () => {
    vi.stubEnv('MST_SYNTHETIC_SECRET', 'synthetic-secret');
    const { compileSwiftHelper } = await import('./nativeHelper.js');
    const helper = await compileSwiftHelper({ name: 'probe', source: '' });
    await helper.run(['start'], {
      environment: 'inherit',
      timeoutMs: 45_000,
      stdin: '{"TOKEN":"synthetic-secret"}',
    });
    const [, args, options] = execute.mock.calls[1]! as [
      string,
      string[],
      ExecOptions,
    ];
    expect(options.env).toBe(process.env);
    expect(options.timeout).toBe(45_000);
    // The secret travels on stdin, never in the process arguments.
    expect(stdinWrites).toEqual(['{"TOKEN":"synthetic-secret"}']);
    expect(args.join(' ')).not.toContain('synthetic-secret');
  });

  it('rejects output that is not a JSON receipt', async () => {
    const { compileSwiftHelper } = await import('./nativeHelper.js');
    const helper = await compileSwiftHelper({ name: 'probe', source: '' });
    execute.mockReturnValueOnce(result('not json'));
    await expect(
      helper.run(['state'], { environment: 'minimal', timeoutMs: 1_000 })
    ).rejects.toThrow(SyntaxError);
  });

  it('rejects when stdin was provided but could not be written', async () => {
    const { compileSwiftHelper } = await import('./nativeHelper.js');
    const helper = await compileSwiftHelper({ name: 'probe', source: '' });
    const epipe = Object.assign(new Error('write EPIPE'), { code: 'EPIPE' });
    execute.mockReturnValueOnce(result('{}', { stdinError: epipe }));
    await expect(
      helper.run(['start'], {
        environment: 'inherit',
        timeoutMs: 1_000,
        stdin: '{"TOKEN":"synthetic-secret"}',
      })
    ).rejects.toBe(epipe);
    // Without input to deliver, the receipt decides.
    execute.mockReturnValueOnce(result('{}', { stdinError: epipe }));
    await expect(
      helper.run(['state'], { environment: 'minimal', timeoutMs: 1_000 })
    ).resolves.toEqual({});
  });

  it('rejects with the raw process error so callers can map code, signal and stderr', async () => {
    const { compileSwiftHelper } = await import('./nativeHelper.js');
    const helper = await compileSwiftHelper({ name: 'probe', source: '' });
    const failure = Object.assign(new Error('Command failed: start'), {
      code: 2,
      signal: null,
      stderr: 'refused\n',
    });
    execute.mockReturnValueOnce(result(failure));
    await expect(
      helper.run(['start'], { environment: 'minimal', timeoutMs: 1_000 })
    ).rejects.toBe(failure);
  });

  it('removes its scratch at process exit', async () => {
    const exits: Array<() => void> = [];
    vi.spyOn(process, 'once').mockImplementation(((
      event: string,
      handler: () => void
    ) => {
      if (event === 'exit') exits.push(handler);
      return process;
    }) as typeof process.once);
    const { compileSwiftHelper } = await import('./nativeHelper.js');
    await compileSwiftHelper({ name: 'probe', source: '' });
    expect(await fs.readdir(root)).toHaveLength(1);
    expect(exits).toHaveLength(1);
    exits[0]!();
    expect(await fs.readdir(root)).toEqual([]);
  });

  it('refuses a name that is not a plain path segment', async () => {
    const { compileSwiftHelper } = await import('./nativeHelper.js');
    await expect(
      compileSwiftHelper({ name: '../escape', source: '' })
    ).rejects.toThrow('lowercase letters and dashes');
    expect(execute).not.toHaveBeenCalled();
  });

  it('removes its scratch and rethrows the raw error when the build fails', async () => {
    const { compileSwiftHelper } = await import('./nativeHelper.js');
    const failure = Object.assign(new Error('compiler said no'), {
      code: 'EBUILD',
    });
    execute.mockRejectedValueOnce(failure);
    await expect(
      compileSwiftHelper({ name: 'probe', source: '' })
    ).rejects.toBe(failure);
    expect(await fs.readdir(root)).toEqual([]);
  });
});
