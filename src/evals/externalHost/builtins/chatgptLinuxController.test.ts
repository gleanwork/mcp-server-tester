import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { getLinuxChatgptApplicationController } from './chatgptLinuxController.js';

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true }))
  );
});

async function fixture(mode = 'valid') {
  const directory = await mkdtemp(join(tmpdir(), 'mst-chatgpt-controller-'));
  directories.push(directory);
  const helper = join(directory, 'helper.mjs');
  const calls = join(directory, 'calls.jsonl');
  await writeFile(
    helper,
    `#!/usr/bin/env node
import fs from 'node:fs';
const operation = process.argv[2];
const payload = JSON.parse(fs.readFileSync(0, 'utf8'));
fs.appendFileSync(${JSON.stringify(calls)}, JSON.stringify({operation, payload, argv:process.argv.slice(2), environmentKeys:Object.keys(process.env)})+'\\n');
if (${JSON.stringify(mode)} === 'failure') { console.error('fixture-private-diagnostic'); process.exit(17); }
if (${JSON.stringify(mode)} === 'malformed') { console.log('fixture-private-diagnostic'); process.exit(0); }
if (${JSON.stringify(mode)} === 'false-receipt') { console.log(JSON.stringify({launched:false})); process.exit(0); }
console.log(JSON.stringify(operation === 'state' ? {running:true} : operation === 'start' ? {launched:true} : {stopped:true}));
`,
    { mode: 0o700 }
  );
  const controller = getLinuxChatgptApplicationController(
    {
      PATH: process.env.PATH,
      HOME: directory,
      DISPLAY: ':1',
      DBUS_SESSION_BUS_ADDRESS: 'unix:path=/fixture/bus',
      MST_CHATGPT_APP_CONTROLLER: helper,
      ANTHROPIC_API_KEY: 'fixture-planner-key',
      GLEAN_API_TOKEN: 'fixture-server-key',
    },
    'linux'
  );
  return { controller, calls };
}

describe('prepared Linux ChatGPT app controller', () => {
  it('requires a prepared Linux environment and absolute helper', () => {
    expect(() => getLinuxChatgptApplicationController({}, 'darwin')).toThrow(
      'requires Linux'
    );
    expect(() => getLinuxChatgptApplicationController({}, 'linux')).toThrow(
      'absolute caller-owned'
    );
    expect(() =>
      getLinuxChatgptApplicationController(
        { MST_CHATGPT_APP_CONTROLLER: 'relative' },
        'linux'
      )
    ).toThrow('absolute caller-owned');
    expect(() =>
      getLinuxChatgptApplicationController(
        { MST_CHATGPT_APP_CONTROLLER: '/fixture/helper' },
        'linux'
      )
    ).toThrow('DISPLAY');
  });
  it('uses stdin for launch credentials and retains only desktop environment keys', async () => {
    const { controller, calls } = await fixture();
    expect(await controller.state()).toEqual({ running: true });
    await controller.start({ MST_CHATGPT_MCP_TOKEN_0: 'fixture-token' });
    await controller.stop();
    const records = (await readFile(calls, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(records.map((r) => r.operation)).toEqual(['state', 'start', 'stop']);
    expect(records[1]).toMatchObject({
      argv: ['start'],
      payload: { environment: { MST_CHATGPT_MCP_TOKEN_0: 'fixture-token' } },
    });
    expect(records[1]!.environmentKeys).not.toContain('ANTHROPIC_API_KEY');
    expect(records[1]!.environmentKeys).not.toContain('GLEAN_API_TOKEN');
  });
  it.each(['failure', 'malformed', 'false-receipt'])(
    'fails closed without retry or leaking %s output',
    async (mode) => {
      const { controller, calls } = await fixture(mode);
      await expect(controller.start()).rejects.not.toThrow(
        'fixture-private-diagnostic'
      );
      expect((await readFile(calls, 'utf8')).trim().split('\n')).toHaveLength(
        1
      );
    }
  );
  it('rejects an oversized environment before invoking the helper', async () => {
    const { controller, calls } = await fixture();
    await expect(
      controller.start({ VALUE: 'x'.repeat(128 * 1024) })
    ).rejects.toThrow('message limit');
    await expect(readFile(calls)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
