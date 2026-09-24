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
}

async function fakeApp(handoffExit = 0, mainExitsImmediately = false) {
  const path = join(root, 'chatgpt');
  const script = `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(join(root, 'calls.jsonl'))}, JSON.stringify({ args, env: process.env, pid: process.pid }) + '\\n');
if (args.some((arg) => arg.startsWith('codex://'))) process.exit(${handoffExit});
const helper = require('node:child_process').spawn('/bin/sleep', ['60'], { stdio: 'ignore' });
fs.writeFileSync(${JSON.stringify(join(root, 'helper.pid'))}, String(helper.pid));
setInterval(() => {}, 1000);
`;
  await writeFile(path, mainExitsImmediately ? '#!/bin/sh\nexit 0\n' : script, {
    mode: 0o700,
  });
  app = createLinuxChatgptApp({
    appPath: path,
    environment: {
      HOME: root,
      CODEX_HOME: join(root, '.codex'),
      DISPLAY: ':99',
      DBUS_SESSION_BUS_ADDRESS: 'unix:path=/fixture/bus',
    },
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
    await expect.poll(async () => (await calls()).length).toBe(2);
    const [main, handoff] = (await calls()).sort(
      (a, b) => a.args.length - b.args.length
    );
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
    const helperPid = () => readFile(join(root, 'helper.pid'), 'utf8');
    await expect.poll(() => helperPid().catch(() => '')).not.toBe('');
    const group = [main!.pid, Number(await helperPid())];
    expect(group.map(alive)).toEqual([true, true]);
    await controller.stop();
    expect(await controller.state()).toEqual({ running: false });
    expect(group.map(alive)).toEqual([false, false]);
  });

  const invalid = 'environment_invalid';
  it.each([
    ['a mismatched CODEX_HOME', { CODEX_HOME: '/home/user/.codex' }, invalid],
    ['an invalid token', { MST_CHATGPT_MCP_TOKEN_0: 'a\nb' }, invalid],
    ['a hand-off without a main process', undefined, 'app_not_running'],
  ])('rejects %s before spawning', async (_, environment, code) => {
    const controller = await fakeApp();
    const failure = environment
      ? controller.start(environment)
      : controller.openPrompt('query');
    await expect(failure).rejects.toMatchObject({ code });
    await expect(readFile(join(root, 'calls.jsonl'))).rejects.toThrow();
  });

  it('fails closed on an exited main process', async () => {
    const controller = await fakeApp(0, true);
    // Either start observes the exit, or state and hand-off do; never a draft.
    const started = await controller.start().catch((error: unknown) => error);
    if (started) expect(started).toMatchObject({ code: 'app_exited' });
    await expect
      .poll(async () => (await controller.state()).running)
      .toBe(false);
    await expect(controller.openPrompt('query')).rejects.toMatchObject({
      code: 'app_not_running',
    });
  });

  // A failed hand-off is uncertain and never retried; an oversized URL never spawns.
  it.each([
    [3, 'query', 'url_handoff_failed', 2],
    [0, '😀'.repeat(20_000), 'prompt_too_large', 1],
  ])('hand-off exit %s fails with %s', async (exit, prompt, code, count) => {
    const controller = await fakeApp(exit);
    await controller.start();
    await expect.poll(async () => (await calls()).length).toBe(1);
    await expect(controller.openPrompt(prompt)).rejects.toMatchObject({ code });
    await expect.poll(async () => (await calls()).length).toBe(count);
  });
});
