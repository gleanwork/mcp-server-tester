import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  linuxChatgptHome,
  NativeChatgptDriverError,
  runLinuxChatgptDesktop,
  validateLinuxChatgptPaths,
} from './linux.js';
import type { ExternalHostConfig } from '../externalHost/types.js';

let root: string;
let config: ExternalHostConfig;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'mst-chatgpt-native-'));
  config = {
    driver: 'openai.chatgpt.agent.desktop-app.linux',
    codexSetup: {
      configPath: join(root, '.codex', 'config.toml'),
      servers: [],
    },
    options: {
      desktopEnvironment: {
        HOME: root,
        MST_CHATGPT_ISOLATED_HOME: root,
        DISPLAY: ':1',
        DBUS_SESSION_BUS_ADDRESS: 'unix:path=/fixture/bus',
      },
    },
  };
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function helper(mode = 'valid', receipt?: unknown) {
  const path = join(root, 'python-fixture.mjs');
  await writeFile(
    path,
    `#!/usr/bin/env node
import fs from 'node:fs';
const payload = JSON.parse(fs.readFileSync(0, 'utf8'));
fs.appendFileSync(${JSON.stringify(join(root, 'calls.jsonl'))}, JSON.stringify({ payload, argv: process.argv.slice(2), env: Object.keys(process.env) })+'\\n');
if (${JSON.stringify(mode)} === 'malformed') { console.log('private-receipt'); process.exit(0); }
if (${JSON.stringify(mode)} === 'failure') { console.error('private-error'); process.exit(1); }
if (${JSON.stringify(mode)} === 'receipt') { console.log(JSON.stringify(${JSON.stringify(receipt) ?? 'null'})); process.exit(0); }
const prepare = process.argv.includes('prepare');
console.log(JSON.stringify({status: prepare ? 'ready' : 'submitted', surface: ${JSON.stringify(mode)} === 'wrong-surface' ? 'codex' : payload.surface, action_count: ${JSON.stringify(mode)} === 'over-budget' ? 65 : 3, duration_ms: 4}));
`,
    { mode: 0o700 }
  );
  config.options!.desktopEnvironment = {
    ...(config.options!.desktopEnvironment as object),
    MST_CHATGPT_PYTHON: path,
    ANTHROPIC_API_KEY: 'private-key',
  };
}

const composerCandidate = {
  role: 'document web',
  showing: false,
  visible: true,
  enabled: true,
  sensitive: false,
  editableState: true,
  editableInterface: false,
  textInterface: true,
};
const composerFailure = {
  status: 'failed',
  phase: 'composer',
  error: 'state_transition_unobserved',
  action_count: 0,
  duration_ms: 4,
};

describe('Linux ChatGPT runtime adapter', () => {
  it.each([0, 1, 16])(
    'preserves %i allowlisted candidates as error metadata only',
    async (count) => {
      const composerCandidates = Array.from({ length: count }, () => ({
        ...composerCandidate,
      }));
      await helper('receipt', { ...composerFailure, composerCandidates });
      const error: unknown = await runLinuxChatgptDesktop(
        'prepare',
        config,
        Date.now() + 5000
      ).catch((failure: unknown) => failure);
      expect(error).toBeInstanceOf(NativeChatgptDriverError);
      expect(error).toMatchObject({
        phase: 'composer',
        composerCandidates,
        telemetry: { accounting: 'partial', action_count: 0 },
      });
      expect((error as Error).message).not.toContain('document web');
    }
  );
  it.each([
    'helper_missing',
    'helper_failed',
    'helper_timeout',
    'clipboard_unavailable',
    'focus_failed',
    'composer_not_empty',
    'desktop_attribute_error',
    'desktop_type_error',
    'desktop_glib_error',
  ])('preserves static native error %s', async (code) => {
    await helper('receipt', { ...composerFailure, error: code });
    await expect(
      runLinuxChatgptDesktop('prepare', config, Date.now() + 5000)
    ).rejects.toThrow(code);
    const calls = (await readFile(join(root, 'calls.jsonl'), 'utf8'))
      .trim()
      .split('\n');
    expect(calls).toHaveLength(1);
  });
  it.each([
    'new-chat-resolve',
    'new-chat-focus',
    'new-chat-shortcut',
    'new-chat-empty',
  ])('preserves fixed failure step %s', async (step) => {
    await helper('receipt', { ...composerFailure, step });
    const error: unknown = await runLinuxChatgptDesktop(
      'prepare',
      config,
      Date.now() + 5000
    ).catch((failure: unknown) => failure);
    expect(error).toBeInstanceOf(NativeChatgptDriverError);
    expect(error).toMatchObject({ phase: 'composer', step });
    expect((error as Error).message).toContain(`step=${step}`);
    expect(
      (await readFile(join(root, 'calls.jsonl'), 'utf8')).trim().split('\n')
    ).toHaveLength(1);
  });
  it('accepts legacy composer failures without diagnostics', async () => {
    await helper('receipt', composerFailure);
    await expect(
      runLinuxChatgptDesktop('prepare', config, Date.now() + 5000)
    ).rejects.toMatchObject({
      phase: 'composer',
      composerCandidates: undefined,
    });
  });
  it.each([
    { composerCandidates: Array.from({ length: 17 }, () => composerCandidate) },
    { composerCandidates: [{ ...composerCandidate, name: 'private UI text' }] },
    { composerCandidates: [{ ...composerCandidate, text: 'private prompt' }] },
    {
      composerCandidates: [{ ...composerCandidate, config: 'private config' }],
    },
    {
      composerCandidates: [
        { ...composerCandidate, url: 'https://private.example' },
      ],
    },
    {
      composerCandidates: [
        { ...composerCandidate, credentials: 'private key' },
      ],
    },
    { composerCandidates: [{ ...composerCandidate, showing: 1 }] },
    { composerCandidates: [{ ...composerCandidate, editableState: 'true' }] },
    { composerCandidates: [{ ...composerCandidate, editableInterface: null }] },
    { composerCandidates: [{ ...composerCandidate, textInterface: 'true' }] },
    { step: 'private_step_text' },
    { step: null },
    { step: 'new-chat-focus', phase: 'surface' },
    { step: 'new-chat-focus', phase: undefined },
    { step: 'new-chat-focus', status: 'ready', phase: undefined },
    { step: 'new-chat-focus', status: 'submitted', phase: 'composer' },
    { error: 'private_error_text' },
    { error: 'AttributeError: private prompt' },
    { composerCandidates: [{ role: 'text' }] },
    { composerCandidates: [{ ...composerCandidate, role: 'x'.repeat(65) }] },
    {
      composerCandidates: [
        { ...composerCandidate, role: 'https://private.example' },
      ],
    },
    { composerCandidates: {} },
    { composerCandidates: null },
    { composerCandidates: [], phase: 'surface' },
    { composerCandidates: [], phase: undefined },
    {
      composerCandidates: [],
      status: 'ready',
      surface: 'chatgpt-work',
      phase: undefined,
    },
    { composerCandidates: [], status: 'submitted', phase: 'composer' },
  ])(
    'rejects invalid diagnostic receipt %# without exposing it',
    async (override) => {
      await helper('receipt', { ...composerFailure, ...override });
      const error: unknown = await runLinuxChatgptDesktop(
        'prepare',
        config,
        Date.now() + 5000
      ).catch((failure: unknown) => failure);
      expect(error).toBeInstanceOf(NativeChatgptDriverError);
      expect(error).toMatchObject({
        phase: undefined,
        composerCandidates: undefined,
        step: undefined,
      });
      expect((error as Error).message).toContain('missing_or_invalid_receipt');
      expect(JSON.stringify(error)).not.toContain('private');
      expect((error as Error).message).not.toContain('private');
    }
  );
  it('requires an explicitly isolated desktop and bounded config path', () => {
    expect(() => linuxChatgptHome({})).toThrow('ISOLATED_HOME');
    expect(validateLinuxChatgptPaths(config)).toBe(root);
    expect(() =>
      validateLinuxChatgptPaths({ ...config, codexSetup: { servers: [] } })
    ).toThrow('explicit configPath');
    expect(() =>
      validateLinuxChatgptPaths({
        ...config,
        codexSetup: { configPath: '/other/config.toml', servers: [] },
      })
    ).toThrow('isolated HOME');
    expect(() =>
      validateLinuxChatgptPaths({
        ...config,
        options: { ...config.options, environment: { HOME: '/normal/user' } },
      })
    ).toThrow('must not override');
  });
  it('sends exact prompt through stdin and reports no planner usage or cost', async () => {
    await helper();
    const prompt = '  α\nline\n';
    const result = await runLinuxChatgptDesktop(
      'submit',
      config,
      Date.now() + 5000,
      prompt
    );
    expect(result.telemetry).toMatchObject({
      driver: 'linux-desktop',
      accounting: 'complete',
      action_count: 3,
      planner: { status: 'not-applicable' },
      cost: { status: 'not-applicable' },
    });
    const record = JSON.parse(
      (await readFile(join(root, 'calls.jsonl'), 'utf8')).trim()
    ) as { payload: unknown; argv: string[]; env: string[] };
    expect(record.payload).toEqual({ prompt, surface: 'chatgpt-work' });
    expect(record.argv).not.toContain(prompt);
    expect(record.env).not.toContain('ANTHROPIC_API_KEY');
  });
  it.each(['failure', 'malformed', 'wrong-surface', 'over-budget'])(
    'does not retry or expose raw output on %s',
    async (mode) => {
      await helper(mode);
      await expect(
        runLinuxChatgptDesktop(
          'submit',
          config,
          Date.now() + 5000,
          'private-query'
        )
      ).rejects.toThrow('no retry attempted');
      expect(
        (await readFile(join(root, 'calls.jsonl'), 'utf8')).trim().split('\n')
      ).toHaveLength(1);
    }
  );
  it('passes surface to setup without a model prompt', async () => {
    await helper();
    config.options!.surface = 'codex';
    await runLinuxChatgptDesktop('prepare', config, Date.now() + 5000);
    const record = JSON.parse(
      (await readFile(join(root, 'calls.jsonl'), 'utf8')).trim()
    ) as { payload: unknown };
    expect(record.payload).toEqual({ surface: 'codex' });
  });
  it('does not spawn after the deadline', async () => {
    await helper();
    await expect(
      runLinuxChatgptDesktop('submit', config, Date.now() - 1, 'query')
    ).rejects.toThrow('deadline');
    await expect(readFile(join(root, 'calls.jsonl'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });
});
