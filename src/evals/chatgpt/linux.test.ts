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

describe('Linux ChatGPT runtime adapter', () => {
  it.each(['prepare', 'submit'] as const)(
    'rejects unknown receipt statuses during %s',
    async (mode) => {
      await helper('receipt', {
        status: 'inspected',
        surface: 'chatgpt-work',
        action_count: 1,
        duration_ms: 4,
        metadata: {
          setupOnly: true,
          serverRowObserved: false,
          connectionStatus: 'unknown',
          controls: [{ role: 'button', name: 'MCP servers' }],
        },
      });
      await expect(
        runLinuxChatgptDesktop(mode, config, Date.now() + 5000)
      ).rejects.toMatchObject({
        diagnostics: { phase: undefined, draftState: undefined },
        message: expect.stringContaining('missing_or_invalid_receipt'),
      });
      const calls = await readFile(join(root, 'calls.jsonl'), 'utf8');
      expect(calls.trim().split('\n')).toHaveLength(1);
    }
  );
  it.each([
    { setupControls: { setupOnly: true, controls: [] } },
    { composerCandidates: [] },
  ])('rejects removed diagnostic fields %#', async (removed) => {
    await helper('receipt', { ...composerFailure, ...removed });
    await expect(
      runLinuxChatgptDesktop('prepare', config, Date.now() + 5000)
    ).rejects.toMatchObject({
      diagnostics: { phase: undefined },
      message: expect.stringContaining('missing_or_invalid_receipt'),
    });
  });
  it.each([
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
  ])(
    'exposes only validated draft state in error metadata %#',
    async (draftState) => {
      await helper('receipt', {
        ...composerFailure,
        step: 'draft-surface',
        draftState,
      });
      const error: unknown = await runLinuxChatgptDesktop(
        'prepare',
        config,
        Date.now() + 5000
      ).catch((failure: unknown) => failure);
      expect(error).toBeInstanceOf(NativeChatgptDriverError);
      expect(error).toMatchObject({
        diagnostics: { draftState, step: 'draft-surface' },
      });
      expect((error as Error).message).not.toContain('textSha256');
      expect(
        (await readFile(join(root, 'calls.jsonl'), 'utf8')).trim().split('\n')
      ).toHaveLength(1);
    }
  );
  it.each([
    { ...unreadableDraftState, observedSurface: 'private surface' },
    { ...unreadableDraftState, composerRootCount: -1 },
    { ...unreadableDraftState, composerRootCount: 5001 },
    { ...unreadableDraftState, composerRootCount: 1.5 },
    { ...unreadableDraftState, sendControlCount: -1 },
    { ...unreadableDraftState, sendControlCount: 5001 },
    { ...unreadableDraftState, sendControlCount: 1.5 },
    { ...unreadableDraftState, textReadable: 'true' },
    { ...unreadableDraftState, textLength: 0 },
    { ...unreadableDraftState, textSha256: readableDraftState.textSha256 },
    { ...unreadableDraftState, embeddedObjectCount: 0 },
    { ...unreadableDraftState, newlineCount: 0 },
    { ...readableDraftState, composerRootCount: 0 },
    { ...readableDraftState, composerRootCount: 2 },
    { ...readableDraftState, textLength: undefined },
    { ...readableDraftState, textSha256: undefined },
    { ...readableDraftState, embeddedObjectCount: undefined },
    { ...readableDraftState, newlineCount: undefined },
    { ...readableDraftState, textLength: 2 * 1024 * 1024 + 1 },
    { ...readableDraftState, textLength: -1 },
    { ...readableDraftState, textLength: 1.5 },
    { ...readableDraftState, textSha256: 'private hash' },
    { ...readableDraftState, textSha256: 'A'.repeat(64) },
    { ...readableDraftState, embeddedObjectCount: -1 },
    { ...readableDraftState, newlineCount: 1.5 },
    {
      ...readableDraftState,
      textLength: 1,
      embeddedObjectCount: 1,
      newlineCount: 1,
    },
    ...['text', 'name', 'url', 'prompt', 'config', 'credentials'].map(
      (key) => ({
        ...readableDraftState,
        [key]: 'private UI value',
      })
    ),
    null,
    {},
  ])(
    'rejects malformed or private draft diagnostics %#',
    async (draftState) => {
      await helper('receipt', { ...composerFailure, draftState });
      const error: unknown = await runLinuxChatgptDesktop(
        'prepare',
        config,
        Date.now() + 5000
      ).catch((failure: unknown) => failure);
      expect(error).toBeInstanceOf(NativeChatgptDriverError);
      expect(error).toMatchObject({
        diagnostics: {
          draftState: undefined,
          phase: undefined,
          step: undefined,
        },
      });
      expect((error as Error).message).toContain('missing_or_invalid_receipt');
      expect(JSON.stringify(error)).not.toContain('private');
      expect((error as Error).message).not.toContain('private');
    }
  );
  it.each(['ready', 'submitted'])(
    'rejects draft diagnostics on %s receipts',
    async (status) => {
      await helper('receipt', {
        status,
        surface: 'chatgpt-work',
        action_count: 1,
        duration_ms: 1,
        draftState: readableDraftState,
      });
      const error: unknown = await runLinuxChatgptDesktop(
        status === 'ready' ? 'prepare' : 'submit',
        config,
        Date.now() + 5000,
        'private prompt'
      ).catch((failure: unknown) => failure);
      expect(error).toMatchObject({ diagnostics: { draftState: undefined } });
      expect((error as Error).message).toContain('missing_or_invalid_receipt');
    }
  );
  it.each([
    'helper_missing',
    'helper_failed',
    'helper_timeout',
    'profession_geometry_invalid',
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
  it.each(['draft-open', 'draft-surface', 'draft-readback', 'send'])(
    'preserves fixed failure step %s',
    async (step) => {
      await helper('receipt', { ...composerFailure, step });
      const error: unknown = await runLinuxChatgptDesktop(
        'prepare',
        config,
        Date.now() + 5000
      ).catch((failure: unknown) => failure);
      expect(error).toBeInstanceOf(NativeChatgptDriverError);
      expect(error).toMatchObject({ diagnostics: { phase: 'composer', step } });
      expect((error as Error).message).toContain(`step=${step}`);
      expect(
        (await readFile(join(root, 'calls.jsonl'), 'utf8')).trim().split('\n')
      ).toHaveLength(1);
    }
  );
  it('accepts composer failures without draft state', async () => {
    await helper('receipt', composerFailure);
    await expect(
      runLinuxChatgptDesktop('prepare', config, Date.now() + 5000)
    ).rejects.toMatchObject({
      diagnostics: {
        telemetry: { accounting: 'partial', action_count: 0 },
        error: 'state_transition_unobserved',
        phase: 'composer',
        step: undefined,
        draftState: undefined,
      },
    });
  });
  it.each([
    { step: 'private_step_text' },
    { step: null },
    { step: 'draft-open', phase: 'surface' },
    { step: 'draft-open', phase: undefined },
    { step: 'draft-open', status: 'ready', phase: undefined },
    { step: 'draft-open', status: 'submitted', phase: 'composer' },
    { error: 'private_error_text' },
    { error: 'AttributeError: private prompt' },
    { phase: 'private_phase_text' },
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
        diagnostics: { phase: undefined, step: undefined },
      });
      expect((error as Error).message).toContain('missing_or_invalid_receipt');
      expect(JSON.stringify(error)).not.toContain('private');
      expect((error as Error).message).not.toContain('private');
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
    const result = await runLinuxChatgptDesktop(
      'submit',
      config,
      Date.now() + 5000,
      prompt
    );
    expect(result.telemetry).toMatchObject({
      driver: 'linux-desktop',
      accounting: 'complete',
      action_count: 2,
      planner: { status: 'not-applicable' },
      cost: { status: 'not-applicable' },
    });
    const record = JSON.parse(
      (await readFile(join(root, 'calls.jsonl'), 'utf8')).trim()
    ) as {
      payload: unknown;
      argv: string[];
      env: string[];
      codexHome: string;
    };
    expect(record.payload).toEqual({ prompt, surface: 'chatgpt-work' });
    expect(record.argv).not.toContain(prompt);
    expect(record.env).not.toContain('ANTHROPIC_API_KEY');
    expect(record.env.filter((key) => key.startsWith('MST_'))).toEqual([]);
    expect(record.env).toEqual(
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
    expect(record.codexHome).toBe(join(root, '.codex'));
  });
  it('serves exactly one sha-bound draft hand-off over fd 3', async () => {
    await helper();
    const prompt = 'exact α query\n';
    const opened: string[] = [];
    await runLinuxChatgptDesktop(
      'submit',
      config,
      Date.now() + 5000,
      prompt,
      opener(opened)
    );
    expect(opened).toEqual([prompt]);
    const record = JSON.parse(
      (await readFile(join(root, 'calls.jsonl'), 'utf8')).trim()
    ) as { argv: string[]; opened: boolean };
    expect(record.opened).toBe(true);
    expect(record.argv).toEqual(expect.arrayContaining(['--open-fd', '3']));
    const prepared: string[] = [];
    await runLinuxChatgptDesktop(
      'prepare',
      config,
      Date.now() + 5000,
      undefined,
      opener(prepared)
    );
    expect(prepared).toEqual(['']);
  });
  it('refuses a mismatched draft hash and reports a failed hand-off', async () => {
    await helper('wrong-hash');
    const opened: string[] = [];
    await expect(
      runLinuxChatgptDesktop(
        'submit',
        config,
        Date.now() + 5000,
        'private-query',
        opener(opened)
      )
    ).rejects.toThrow('helper_failed');
    expect(opened).toEqual([]);
  });
  it('replies opened=false without leaking an opener failure', async () => {
    await helper();
    const error: unknown = await runLinuxChatgptDesktop(
      'submit',
      config,
      Date.now() + 5000,
      'private-query',
      opener([], true)
    ).catch((failure: unknown) => failure);
    expect(String(error)).toContain('open=open_failed');
    expect(String(error)).not.toContain('private');
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
  it('blocks an invalid Scio environment before spawning', async () => {
    await helper();
    delete (config.options!.desktopEnvironment as Record<string, string>)
      .AT_SPI_BUS_ADDRESS;
    await expect(
      runLinuxChatgptDesktop(
        'submit',
        config,
        Date.now() + 5000,
        'private-query'
      )
    ).rejects.toThrow('AT_SPI_BUS_ADDRESS');
    await expect(readFile(join(root, 'calls.jsonl'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });
  it('rejects oversized UTF-8 input before spawning', async () => {
    await helper();
    await expect(
      runLinuxChatgptDesktop(
        'submit',
        config,
        Date.now() + 5000,
        '😀'.repeat(600_000)
      )
    ).rejects.toThrow('control message limit');
    await expect(readFile(join(root, 'calls.jsonl'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
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
