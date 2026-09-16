import { afterEach, beforeEach, expect, it } from 'vitest';
import { mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCodexSetup } from '../../../manual/codex/setup.js';
import {
  launchCodexApp,
  type CodexExit,
  type CodexProcessFacade,
} from '../../../../src/evals/codex/launcher.js';

let root: string;
let executablePath: string;
let finish: (exit: CodexExit) => void;
let processes: CodexProcessFacade;
let launched: Promise<void>;
let spawned: number;
let interrupt: () => void;
let output: string[];
let removed: boolean;

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'codex-setup-test-')));
  executablePath = join(root, 'ChatGPT.app/Contents/MacOS/ChatGPT');
  await mkdir(join(root, 'ChatGPT.app/Contents/MacOS'), { recursive: true });
  await writeFile(executablePath, 'fixture never executed', { mode: 0o700 });
  const exited = new Promise<CodexExit>((resolve) => {
    finish = resolve;
  });
  let notify!: () => void;
  launched = new Promise<void>((resolve) => {
    notify = resolve;
  });
  spawned = 0;
  processes = {
    platform: 'darwin',
    readBundleInfo: async () => ({
      identifier: 'com.openai.codex',
      executable: 'ChatGPT',
      version: '26.903.71938',
    }),
    verifyBundleSignature: async () => ({
      teamIdentifier: '2DC432GLL2',
    }),
    listProcesses: async () => [],
    spawn() {
      spawned++;
      notify();
      return { pid: 4545, exited };
    },
  };
  output = [];
  removed = false;
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function terminal() {
  return {
    write(message: string) {
      output.push(message);
    },
    onInterrupt(listener: () => void) {
      interrupt = listener;
      return () => {
        removed = true;
      };
    },
  };
}

it('leaves sign-in to the user and waits for app exit without treating it as authentication success', async () => {
  let completed = false;
  const setup = runCodexSetup(
    ['--executable', executablePath, '--profile', join(root, 'profile')],
    processes,
    terminal()
  ).then((code) => {
    completed = true;
    return code;
  });
  await launched;
  expect(completed).toBe(false);
  finish({ code: 0, signal: null });
  expect(await setup).toBe(0);
  expect(output.join('\n')).toContain(
    'Sign in in the app, then quit it normally'
  );
  expect(output.join('\n')).toContain('sign-in was not verified');
  expect(removed).toBe(true);
});

it('interrupts setup by quarantining, not killing or completing authentication', async () => {
  const profilePath = join(root, 'profile');
  const setup = runCodexSetup(
    ['--executable', executablePath, '--profile', profilePath],
    processes,
    terminal()
  );
  await launched;
  interrupt();
  finish({ code: 0, signal: null });
  expect(await setup).toBe(1);
  expect(output.join('\n')).toContain('Quit the app manually');
  await expect(
    launchCodexApp({ executablePath, profilePath }, processes)
  ).rejects.toThrow(/leased|quarantined/i);
  expect(spawned).toBe(1);
});

it.each([
  { args: [], code: 1 },
  { args: ['--profile', '/unused'], code: 1 },
  { args: ['--help'], code: 0 },
  {
    args: [
      '--executable',
      '/unused',
      '--profile',
      '/unused',
      '--url',
      'https://example.com',
    ],
    code: 1,
  },
  {
    args: ['--executable', '/unused', '--profile', '/unused', 'prompt'],
    code: 1,
  },
])(
  'does not launch on help, missing paths, URLs, or prompts: $args',
  async ({ args, code }) => {
    expect(await runCodexSetup(args, processes, terminal())).toBe(code);
    expect(spawned).toBe(0);
  }
);
