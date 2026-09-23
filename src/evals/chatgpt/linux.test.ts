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
  await writeFile(join(root, 'url-opener'), '#!/bin/sh\nexit 1\n', {
    mode: 0o700,
  });
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
        MST_CHATGPT_URL_OPENER: join(root, 'url-opener'),
        XDG_DATA_HOME: join(root, '.local/share'),
        XDG_CACHE_HOME: join(root, '.cache'),
        XDG_STATE_HOME: join(root, '.local/state'),
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
fs.appendFileSync(${JSON.stringify(join(root, 'calls.jsonl'))}, JSON.stringify({ payload, argv: process.argv.slice(2), env: Object.keys(process.env), codexHome: process.env.CODEX_HOME, opener: process.env.MST_CHATGPT_URL_OPENER })+'\\n');
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
      opener: string;
    };
    expect(record.payload).toEqual({ prompt, surface: 'chatgpt-work' });
    expect(record.argv).not.toContain(prompt);
    expect(record.env).not.toContain('ANTHROPIC_API_KEY');
    expect(record.env).toEqual(
      expect.arrayContaining([
        'HOME',
        'DISPLAY',
        'DBUS_SESSION_BUS_ADDRESS',
        'CODEX_HOME',
        'MST_CHATGPT_URL_OPENER',
        'XDG_DATA_HOME',
        'XDG_CACHE_HOME',
        'XDG_STATE_HOME',
      ])
    );
    expect(record.codexHome).toBe(join(root, '.codex'));
    expect(record.opener).toBe(join(root, 'url-opener'));
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
  it.each([
    '',
    'relative-helper',
    '/nonexistent/mst-opener',
    'directory',
    'not-executable',
  ])('blocks invalid opener %s before spawning', async (path) => {
    await helper();
    const notExecutable = join(root, 'not-executable');
    await writeFile(notExecutable, '', { mode: 0o600 });
    config.options!.desktopEnvironment = {
      ...(config.options!.desktopEnvironment as object),
      MST_CHATGPT_URL_OPENER:
        path === 'directory'
          ? root
          : path === 'not-executable'
            ? notExecutable
            : path,
    };
    await expect(
      runLinuxChatgptDesktop(
        'submit',
        config,
        Date.now() + 5000,
        'private-query'
      )
    ).rejects.toThrow('MST_CHATGPT_URL_OPENER');
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
