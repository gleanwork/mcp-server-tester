import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  chatgptDraftUrl,
  createLinuxChatgptApp,
  LINUX_CHATGPT_APP_FLAGS,
  quoteUrlComponent,
  type LinuxChatgptAppController,
} from './linuxApp.js';

let root: string;
let app: LinuxChatgptAppController | undefined;

interface Call {
  args: string[];
  env: Record<string, string>;
  pid: number;
  pgid: number;
}

async function fakeApp(handoffExit = 0, mainExitsImmediately = false) {
  const path = join(root, 'chatgpt');
  const calls = join(root, 'calls.jsonl');
  await writeFile(
    path,
    `#!${process.execPath}
const fs = require('node:fs');
const { spawn } = require('node:child_process');
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(calls)}, JSON.stringify({ args, env: process.env, pid: process.pid }) + '\\n');
const url = args.find((arg) => arg.startsWith('codex://'));
if (url) process.exit(${handoffExit});
if (${mainExitsImmediately}) process.exit(0);
const helper = spawn('/bin/sleep', ['60'], { stdio: 'ignore' });
fs.writeFileSync(${JSON.stringify(join(root, 'helper.pid'))}, String(helper.pid));
setInterval(() => {}, 1000);
`,
    { mode: 0o700 }
  );
  const environment = {
    HOME: root,
    CODEX_HOME: join(root, '.codex'),
    DISPLAY: ':99',
    DBUS_SESSION_BUS_ADDRESS: 'unix:path=/fixture/bus',
  };
  app = createLinuxChatgptApp({
    appPath: path,
    environment,
    workspace: join(root, 'workspace dir'),
  });
  return app;
}

async function calls(): Promise<Call[]> {
  return (await readFile(join(root, 'calls.jsonl'), 'utf8'))
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as Call);
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'mst-linux-app-'));
});
afterEach(async () => {
  await app?.stop().catch(() => undefined);
  app = undefined;
  await rm(root, { recursive: true, force: true });
});

describe('deep-link URL encoding', () => {
  it('matches Python quote(safe="") byte for byte', () => {
    expect(quoteUrlComponent('/tmp/a b/é')).toBe('%2Ftmp%2Fa%20b%2F%C3%A9');
    expect(quoteUrlComponent("α 😀\n!*'()~-_.")).toBe(
      '%CE%B1%20%F0%9F%98%80%0A%21%2A%27%28%29~-_.'
    );
    expect(chatgptDraftUrl('/w', '')).toBe('codex://new?path=%2Fw');
    expect(chatgptDraftUrl('/w', 'a&b')).toBe(
      'codex://new?path=%2Fw&prompt=a%26b'
    );
    expect(() => quoteUrlComponent('bad\uD800')).toThrow('prompt_invalid');
  });
});

describe('in-process Linux ChatGPT app controller', () => {
  it('starts with fixed flags in its own group, hands off one draft, and stops the group', async () => {
    const controller = await fakeApp();
    expect(await controller.state()).toEqual({ running: false });
    await controller.start({
      CODEX_HOME: join(root, '.codex'),
      MST_CHATGPT_MCP_TOKEN_0: 'fixture-token',
      OPENAI_API_KEY: 'must-not-pass',
    });
    expect(await controller.state()).toEqual({ running: true });
    await controller.openPrompt('  α 😀\nline  ');
    const [main, handoff] = await calls();
    expect(main!.args).toEqual([...LINUX_CHATGPT_APP_FLAGS]);
    expect(main!.env).toMatchObject({
      MST_CHATGPT_MCP_TOKEN_0: 'fixture-token',
      NO_AT_BRIDGE: '0',
      ACCESSIBILITY_ENABLED: '1',
      GTK_MODULES: 'gail:atk-bridge',
      DISPLAY: ':99',
      CODEX_HOME: join(root, '.codex'),
    });
    expect(main!.env.OPENAI_API_KEY).toBeUndefined();
    expect(handoff!.args).toEqual([
      ...LINUX_CHATGPT_APP_FLAGS,
      chatgptDraftUrl(join(root, 'workspace dir'), '  α 😀\nline  '),
    ]);
    // The hand-off process never receives MCP credentials.
    expect(handoff!.env.MST_CHATGPT_MCP_TOKEN_0).toBeUndefined();
    const helper = Number(await readFile(join(root, 'helper.pid'), 'utf8'));
    expect(alive(main!.pid)).toBe(true);
    expect(alive(helper)).toBe(true);
    await controller.stop();
    expect(await controller.state()).toEqual({ running: false });
    expect(alive(main!.pid)).toBe(false);
    expect(alive(helper)).toBe(false);
  });

  it('rejects a mismatched CODEX_HOME and invalid tokens before spawning', async () => {
    const controller = await fakeApp();
    await expect(
      controller.start({ CODEX_HOME: '/home/user/.codex' })
    ).rejects.toMatchObject({ code: 'environment_invalid' });
    await expect(
      controller.start({ MST_CHATGPT_MCP_TOKEN_0: 'a\nb' })
    ).rejects.toMatchObject({ code: 'environment_invalid' });
    await expect(readFile(join(root, 'calls.jsonl'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('does not hand off without a running main process', async () => {
    const controller = await fakeApp();
    await expect(controller.openPrompt('query')).rejects.toMatchObject({
      code: 'app_not_running',
    });
    await expect(readFile(join(root, 'calls.jsonl'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('fails closed on an exited main process', async () => {
    const controller = await fakeApp(0, true);
    await expect(controller.start()).rejects.toMatchObject({
      code: 'app_exited',
    });
  });

  it('treats a failed hand-off as uncertain and does not retry', async () => {
    const controller = await fakeApp(3);
    await controller.start();
    await expect(controller.openPrompt('query')).rejects.toMatchObject({
      code: 'url_handoff_failed',
    });
    expect(await calls()).toHaveLength(2);
  });

  it('rejects an oversized URL before spawning a hand-off', async () => {
    const controller = await fakeApp();
    await controller.start();
    await expect(
      controller.openPrompt('😀'.repeat(20_000))
    ).rejects.toMatchObject({ code: 'prompt_too_large' });
    expect(await calls()).toHaveLength(1);
  });
});
