import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { NativeChatgptDriverError, runLinuxChatgptDesktop } from './linux.js';
import { validateLinuxChatgptConfig } from '../chatgptSetup/linuxProfile.js';
import { linuxEnvironment } from './linuxEnvironment.fixture.js';
import type { ExternalHostConfig } from '../externalHost/types.js';

let root: string;
let config: ExternalHostConfig;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'mst-chatgpt-native-'));
  config = {
    driver: 'openai.chatgpt.agent.desktop-app.linux',
    codexSetup: { servers: [] },
    options: { desktopEnvironment: linuxEnvironment(root) },
  };
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

/** Fake MST parent: records the fd-3 request and replies. */
function opener(calls: string[], fail = false) {
  return async (prompt: string) => {
    calls.push(prompt);
    if (fail) throw new Error('private failure');
  };
}

async function helper(mode = 'valid', receipt?: unknown) {
  const path = join(root, 'python-fixture.mjs');
  await writeFile(
    path,
    `#!/usr/bin/env node
import fs from 'node:fs';
const payload = JSON.parse(fs.readFileSync(0, 'utf8'));
let opened;
if (process.argv.includes('--open-fd')) {
  const crypto = await import('node:crypto');
  const net = await import('node:net');
  const socket = new net.Socket({ fd: 3, readable: true, writable: true });
  const draft = payload.prompt ?? '';
  const hash = ${JSON.stringify(mode)} === 'wrong-hash' ? '0'.repeat(64) : crypto.createHash('sha256').update(draft, 'utf8').digest('hex');
  socket.write(JSON.stringify({ open: hash }) + '\\n');
  opened = await new Promise((resolve) => socket.once('data', (d) => resolve(JSON.parse(String(d)).opened)));
  socket.destroy();
}
fs.appendFileSync(${JSON.stringify(join(root, 'calls.jsonl'))}, JSON.stringify({ payload, argv: process.argv.slice(2), env: Object.keys(process.env), codexHome: process.env.CODEX_HOME, opened })+'\\n');
if (opened === false) { console.log(JSON.stringify({status:'failed', action_count: 1, duration_ms: 1, error: 'helper_failed'})); process.exit(1); }
if (${JSON.stringify(mode)} === 'malformed') { console.log('private-receipt'); process.exit(0); }
if (${JSON.stringify(mode)} === 'failure') { console.error('private-error'); process.exit(1); }
if (${JSON.stringify(mode)} === 'receipt') { console.log(JSON.stringify(${JSON.stringify(receipt) ?? 'null'})); process.exit(0); }
const prepare = process.argv.includes('prepare');
console.log(JSON.stringify({status: prepare ? 'ready' : 'submitted', surface: ${JSON.stringify(mode)} === 'wrong-surface' ? 'codex' : payload.surface, action_count: ${JSON.stringify(mode)} === 'over-budget' ? 65 : 2, duration_ms: 4}));
`,
    { mode: 0o700 }
  );
  config.options!.desktopEnvironment = {
    ...(config.options!.desktopEnvironment as object),
    MST_CHATGPT_PYTHON: path,
    ANTHROPIC_API_KEY: 'private-key',
  };
}

const unreadableDraftState = {
  observedSurface: 'chatgpt-work',
  composerRootCount: 1,
  sendControlCount: 1,
  textReadable: false,
};
const readableDraftState = {
  ...unreadableDraftState,
  textReadable: true,
  textLength: 0,
  textSha256:
    'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
  embeddedObjectCount: 0,
  newlineCount: 0,
};
const composerFailure = {
  status: 'failed',
  phase: 'composer',
  error: 'state_transition_unobserved',
  action_count: 0,
  duration_ms: 4,
};

const calls = async () =>
  (await readFile(join(root, 'calls.jsonl'), 'utf8')).trim().split('\n');
const record = async <T>() => JSON.parse((await calls())[0]!) as T;
const run = (
  mode: 'prepare' | 'submit',
  prompt?: string,
  open?: (prompt: string) => Promise<void>
) => runLinuxChatgptDesktop(mode, config, Date.now() + 5000, prompt, open);
const failure = (mode: 'prepare' | 'submit' = 'prepare', prompt?: string) =>
  run(mode, prompt).then(
    () => {
      throw new Error('expected failure');
    },
    (error: unknown) => {
      expect(error).toBeInstanceOf(NativeChatgptDriverError);
      return error as NativeChatgptDriverError;
    }
  );
const invalid = unreadableDraftState;
const readable = readableDraftState;

describe('Linux ChatGPT runtime adapter', () => {
  it.each([
    ...(['prepare', 'submit'] as const).map((mode) => ({
      mode,
      receipt: {
        status: 'inspected',
        surface: 'chatgpt-work',
        action_count: 1,
        duration_ms: 4,
        metadata: { setupOnly: true, controls: [{ name: 'MCP servers' }] },
      },
    })),
    ...(['ready', 'submitted'] as const).map((status) => ({
      mode: status === 'ready' ? ('prepare' as const) : ('submit' as const),
      receipt: {
        status,
        surface: 'chatgpt-work',
        action_count: 1,
        duration_ms: 1,
        draftState: readableDraftState,
      },
    })),
    ...[
      { setupControls: { setupOnly: true, controls: [] } },
      { composerCandidates: [] },
      { step: 'private_step_text' },
      { step: null },
      { step: 'draft-open', phase: 'surface' },
      { step: 'draft-open', phase: undefined },
      { step: 'draft-open', status: 'ready', phase: undefined },
      { step: 'draft-open', status: 'submitted', phase: 'composer' },
      { error: 'private_error_text' },
      { error: 'AttributeError: private prompt' },
      { phase: 'private_phase_text' },
      ...[
        ...(
          [
            [invalid, 'observedSurface', 'private surface'],
            [invalid, 'composerRootCount', -1, 5001, 1.5],
            [invalid, 'sendControlCount', -1, 5001, 1.5],
            [invalid, 'textReadable', 'true'],
            [invalid, 'textLength', 0],
            [invalid, 'textSha256', readableDraftState.textSha256],
            [invalid, 'embeddedObjectCount', 0],
            [invalid, 'newlineCount', 0],
            [readable, 'composerRootCount', 0, 2],
            [readable, 'textLength', undefined, 2 * 1024 * 1024 + 1, -1, 1.5],
            [readable, 'textSha256', undefined, 'private hash', 'A'.repeat(64)],
            [readable, 'embeddedObjectCount', undefined, -1],
            [readable, 'newlineCount', undefined, 1.5],
            ...['text', 'name', 'url', 'prompt', 'config', 'credentials'].map(
              (key) => [readable, key, 'private UI value']
            ),
          ] as Array<[object, string, ...unknown[]]>
        ).flatMap(([base, key, ...values]) =>
          values.map((value) => ({ ...base, [key]: value }))
        ),
        { ...readable, textLength: 1, embeddedObjectCount: 1, newlineCount: 1 },
        null,
        {},
      ].map((draftState) => ({ draftState })),
    ].map((override) => ({
      mode: 'prepare' as const,
      receipt: { ...composerFailure, ...override },
    })),
  ])(
    'rejects invalid, removed, or private receipt fields %# without exposing them',
    async ({ mode, receipt }) => {
      await helper('receipt', receipt);
      const error = await failure(mode, mode === 'submit' ? 'q' : undefined);
      expect(error).toMatchObject({
        diagnostics: {
          draftState: undefined,
          phase: undefined,
          step: undefined,
        },
      });
      expect(error.message).toContain('missing_or_invalid_receipt');
      expect(JSON.stringify(error)).not.toContain('private');
      expect(error.message).not.toContain('private');
      expect(await calls()).toHaveLength(1);
    }
  );
  it.each([
    ...[
      readableDraftState,
      unreadableDraftState,
      {
        ...unreadableDraftState,
        observedSurface: 'unknown',
        composerRootCount: 0,
        sendControlCount: 0,
      },
      {
        ...unreadableDraftState,
        observedSurface: 'ambiguous',
        composerRootCount: 5000,
        sendControlCount: 5000,
      },
      {
        ...readableDraftState,
        observedSurface: 'codex',
        textLength: 2 * 1024 * 1024,
        embeddedObjectCount: 1,
        newlineCount: 2,
      },
    ].map((draftState) => ({ step: 'draft-surface', draftState })),
    ...['draft-open', 'draft-readback', 'send'].map((step) => ({ step })),
    ...[
      'helper_missing',
      'helper_failed',
      'helper_timeout',
      'profession_geometry_invalid',
      'desktop_attribute_error',
      'desktop_type_error',
      'desktop_glib_error',
    ].map((error) => ({ error })),
    {},
  ] as Array<{ step?: string; draftState?: object; error?: string }>)(
    'accepts a valid composer failure receipt %#',
    async (override) => {
      await helper('receipt', { ...composerFailure, ...override });
      const error = await failure();
      const { step, draftState } = override;
      const code = override.error ?? composerFailure.error;
      expect(error.diagnostics).toMatchObject({
        telemetry: { accounting: 'partial', action_count: 0 },
        error: code,
        phase: 'composer',
        step,
        draftState,
      });
      expect(error.message).toContain(code);
      if (step) expect(error.message).toContain(`step=${step}`);
      expect(error.message).not.toContain('textSha256');
      expect(await calls()).toHaveLength(1);
    }
  );
  it('validates the Scio environment contract and owns $HOME/.codex', () => {
    expect(validateLinuxChatgptConfig(config)).toMatchObject({
      home: root,
      codexHome: join(root, '.codex'),
    });
    expect(
      validateLinuxChatgptConfig({
        ...config,
        codexSetup: {
          configPath: join(root, '.codex', 'config.toml'),
          servers: [],
        },
      }).home
    ).toBe(root);
    expect(() =>
      validateLinuxChatgptConfig({
        ...config,
        codexSetup: { configPath: '/other/config.toml', servers: [] },
      })
    ).toThrow('owns $HOME/.codex');
    expect(() =>
      validateLinuxChatgptConfig({
        ...config,
        options: { ...config.options, environment: { HOME: '/normal/user' } },
      })
    ).toThrow('must not override');
  });
  it('sends exact prompt through stdin and reports no planner usage or cost', async () => {
    await helper();
    const prompt = '  α 😀\nline\n\nKeep trailing spaces.  \n';
    const result = await run('submit', prompt);
    expect(result.telemetry).toMatchObject({
      driver: 'linux-desktop',
      accounting: 'complete',
      action_count: 2,
      planner: { status: 'not-applicable' },
      cost: { status: 'not-applicable' },
    });
    const call = await record<{
      payload: unknown;
      argv: string[];
      env: string[];
      codexHome: string;
    }>();
    expect(call.payload).toEqual({ prompt, surface: 'chatgpt-work' });
    expect(call.argv).not.toContain(prompt);
    expect(call.env).not.toContain('ANTHROPIC_API_KEY');
    expect(call.env.filter((key) => key.startsWith('MST_'))).toEqual([]);
    expect(call.env).toEqual(
      expect.arrayContaining([
        'HOME',
        'DISPLAY',
        'DBUS_SESSION_BUS_ADDRESS',
        'CODEX_HOME',
        'XDG_DATA_HOME',
        'XDG_CACHE_HOME',
        'XDG_STATE_HOME',
      ])
    );
    expect(call.codexHome).toBe(join(root, '.codex'));
  });
  it.each([
    ['submit', 'exact α query\n', 'exact α query\n'],
    ['prepare', undefined, ''],
  ] as const)(
    'serves exactly one sha-bound draft hand-off over fd 3 (%s)',
    async (mode, prompt, draft) => {
      await helper();
      const opened: string[] = [];
      await run(mode, prompt, opener(opened));
      expect(opened).toEqual([draft]);
      const call = await record<{ argv: string[]; opened: boolean }>();
      expect(call.opened).toBe(true);
      expect(call.argv).toEqual(expect.arrayContaining(['--open-fd', '3']));
    }
  );
  it('refuses a mismatched draft hash and reports a failed hand-off', async () => {
    await helper('wrong-hash');
    const opened: string[] = [];
    await expect(run('submit', 'q', opener(opened))).rejects.toThrow(
      'helper_failed'
    );
    expect(opened).toEqual([]);
  });
  it('replies opened=false without leaking an opener failure', async () => {
    await helper();
    const error = await run('submit', 'q', opener([], true)).catch(String);
    expect(error).toContain('open=open_failed');
    expect(error).not.toContain('private');
  });
  it.each(['failure', 'malformed', 'wrong-surface', 'over-budget'])(
    'does not retry or expose raw output on %s',
    async (mode) => {
      await helper(mode);
      await expect(run('submit', 'private-query')).rejects.toThrow(
        'no retry attempted'
      );
      expect(await calls()).toHaveLength(1);
    }
  );
  it('passes surface to setup without a model prompt', async () => {
    await helper();
    config.options!.surface = 'codex';
    await run('prepare');
    expect((await record<{ payload: unknown }>()).payload).toEqual({
      surface: 'codex',
    });
  });
  it.each([
    ['an invalid Scio environment', 'q', 'AT_SPI_BUS_ADDRESS', 5000],
    [
      'oversized UTF-8 input',
      '😀'.repeat(600_000),
      'control message limit',
      5000,
    ],
    ['the deadline', 'q', 'deadline', -1],
  ] as const)('does not spawn on %s', async (_, prompt, message, deadline) => {
    await helper();
    if (message === 'AT_SPI_BUS_ADDRESS')
      delete (config.options!.desktopEnvironment as Record<string, string>)
        .AT_SPI_BUS_ADDRESS;
    await expect(
      runLinuxChatgptDesktop('submit', config, Date.now() + deadline, prompt)
    ).rejects.toThrow(message);
    await expect(calls()).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
