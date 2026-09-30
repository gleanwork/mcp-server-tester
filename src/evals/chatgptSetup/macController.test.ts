import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CHATGPT_CONTROLLER_SOURCE } from './macControllerSource.js';

interface ExecOptions {
  env: Record<string, string | undefined>;
  timeout: number;
  maxBuffer: number;
}

const { execute, stdinWrites } = vi.hoisted(() => ({
  execute: vi.fn(),
  stdinWrites: [] as string[],
}));
// Both call styles route through `execute`, so these tests pin behavior rather
// than which execFile form the controller uses.
vi.mock('node:child_process', async () => {
  const { promisify } = await import('node:util');
  const callback = vi.fn(
    (
      file: string,
      args: string[],
      options: unknown,
      done: (error: unknown, stdout: string, stderr: string) => void
    ) => {
      const pending = execute(file, args, options) as Promise<{
        stdout: string;
        stderr: string;
      }> & { child?: unknown };
      // Like Node, the callback form reports stderr as an argument, not on
      // the error; the promisified form attaches it to the error.
      pending.then(
        (output) => done(null, output.stdout, output.stderr),
        (error: Error & { stderr?: string }) => {
          const { stderr = '', ...fields } = error;
          done(Object.assign(new Error(error.message), fields), '', stderr);
        }
      );
      return pending.child ?? { stdin: { on: vi.fn(), end: vi.fn() } };
    }
  );
  return { execFile: Object.assign(callback, { [promisify.custom]: execute }) };
});
vi.mock('node:os', async (original) => ({
  ...(await original<typeof os>()),
  tmpdir: vi.fn(),
}));
const actualOs = await vi.importActual<typeof os>('node:os');

function receipt(value: unknown) {
  return Object.assign(
    Promise.resolve({ stdout: JSON.stringify(value), stderr: '' }),
    {
      child: {
        stdin: {
          on: vi.fn(),
          end: (input: string) => stdinWrites.push(input),
        },
      },
    }
  );
}

let root: string;
beforeEach(async () => {
  vi.resetModules();
  stdinWrites.length = 0;
  vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin');
  root = await fs.realpath(
    await fs.mkdtemp(join(actualOs.tmpdir(), 'mst-chatgpt-test-'))
  );
  vi.mocked(os.tmpdir).mockReturnValue(root);
  execute.mockReset().mockImplementation((file: string, args: string[]) => {
    if (file === '/usr/bin/xcrun') {
      return fs
        .writeFile(args[3]!, 'synthetic executable, never run', { mode: 0o700 })
        .then(() => ({ stdout: '', stderr: '' }));
    }
    return receipt(
      args[0] === 'state'
        ? { running: false, instances: 0 }
        : args[0] === 'stop'
          ? { stopped: true }
          : { launched: true }
    );
  });
});
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await fs.rm(root, { recursive: true, force: true });
});

describe('ChatGPT macOS application controller (all execution mocked)', () => {
  it('refuses to build or run off macOS', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('linux');
    const { getChatgptApplicationController } =
      await import('./macController.js');
    await expect(getChatgptApplicationController()).rejects.toThrow(
      'Unable to control the ChatGPT desktop application safely.'
    );
    expect(execute).not.toHaveBeenCalled();
  });

  it('builds the embedded source once per app and bundle', async () => {
    const { getChatgptApplicationController } =
      await import('./macController.js');
    const [first, second] = await Promise.all([
      getChatgptApplicationController({ appPath: '/Applications/X.app' }),
      getChatgptApplicationController({ appPath: '/Applications/X.app' }),
    ]);
    expect(first).toBe(second);
    expect(execute).toHaveBeenCalledTimes(1);
    const [, args, options] = execute.mock.calls[0]! as [
      string,
      string[],
      ExecOptions,
    ];
    expect(await fs.readFile(args[1]!, 'utf8')).toBe(CHATGPT_CONTROLLER_SOURCE);
    expect(Object.keys(options.env).sort()).toEqual(['PATH', 'TMPDIR']);
  });

  it('launches with the inherited environment and passes credentials on stdin only', async () => {
    const { getChatgptApplicationController } =
      await import('./macController.js');
    const controller = await getChatgptApplicationController({
      bundleId: 'com.example.chatgpt',
      appPath: '/Applications/X.app',
    });
    expect(await controller.state()).toEqual({ running: false });
    await controller.start({ OPENAI_API_KEY: 'synthetic-secret' });
    const [, args, options] = execute.mock.calls[2]! as [
      string,
      string[],
      ExecOptions,
    ];
    expect(args).toEqual([
      'start',
      'com.example.chatgpt',
      '/Applications/X.app',
    ]);
    expect(options.env).toBe(process.env);
    expect(options).toMatchObject({ timeout: 45_000, maxBuffer: 16 * 1024 });
    expect(stdinWrites).toEqual([
      '{}',
      JSON.stringify({ OPENAI_API_KEY: 'synthetic-secret' }),
    ]);
  });

  // Changed by the shared helper: the callback form never put stderr on the
  // error, so messages used to end at the signal. They now include the
  // helper's (static) stderr line.
  it('reports failures by stage, code, signal and helper stderr, without the process message', async () => {
    const { getChatgptApplicationController } =
      await import('./macController.js');
    const controller = await getChatgptApplicationController();
    execute.mockReturnValueOnce(
      Object.assign(
        Promise.reject(
          Object.assign(new Error('Command failed: start synthetic-secret'), {
            code: 1,
            signal: null,
            stderr: 'launch refused\n',
          })
        ),
        { child: { stdin: { on: vi.fn(), end: vi.fn() } } }
      )
    );
    const failure = await controller.start({}).catch((error: Error) => error);
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toBe(
      'Unable to control the ChatGPT desktop application safely. Stage: start; code: 1; signal: none; launch refused'
    );
  });

  it('names the compile stage and permits a later retry', async () => {
    const { getChatgptApplicationController } =
      await import('./macController.js');
    execute.mockRejectedValueOnce(
      Object.assign(new Error('synthetic-secret compiler output'), {
        code: 'ENOENT',
      })
    );
    await expect(getChatgptApplicationController()).rejects.toThrow(
      'Unable to control the ChatGPT desktop application safely. Stage: compile; code: ENOENT; signal: none'
    );
    expect(await fs.readdir(root)).toEqual([]);
    await getChatgptApplicationController();
    expect(execute).toHaveBeenCalledTimes(2);
  });
});
