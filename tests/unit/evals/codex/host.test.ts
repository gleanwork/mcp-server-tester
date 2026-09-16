import { createHash, randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import type { ChildProcess } from 'node:child_process';
import type { ElectronApplication, Page } from '@playwright/test';
import { afterEach, expect, it, vi } from 'vitest';
import type {
  HostRunInput,
  HostRunResult,
} from '../../../../src/evals/evalFrameworkTypes.js';
import type {
  CodexElectronDOMObservation,
  CodexElectronSubmitReceipt,
} from '../../../../src/evals/codex/electronControl.js';
import {
  CodexElectronFailure,
  type CodexElectronLaunch,
  type CodexElectronOptions,
  type CodexElectronSession,
} from '../../../../src/evals/codex/electron.js';
import {
  CodexFirstHostSchema,
  createCodexDesktopHost,
  type CodexFirstHostConfig,
} from '../../../../src/evals/codex/host.js';
import { prepareCodexProfile } from '../../../../src/evals/codex/profile.js';
import {
  CODEX_DESKTOP_BUILD,
  type CodexNativeCollection,
  type CodexNativeRequest,
} from '../../../../src/evals/codex/nativeEvidence.js';

const roots: string[] = [];

afterEach(async () => {
  vi.useRealTimers();
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});

it('HostDefinition.run baselines before fresh workspace and performs one Playwright fill and Send click', async () => {
  const fixture = await hostHarness();

  const result = await fixture.run('first-live-shape');

  expect(result.error).toBeUndefined();
  expect(result.events).toHaveLength(1);
  expect(fixture.launches).toBe(1);
  expect(fixture.attempts[0]?.fills).toHaveLength(1);
  expect(fixture.attempts[0]?.clicks).toBe(1);
  expect(fixture.attempts[0]?.opens).toBe(1);
  expect(fixture.attempts[0]?.quitCalls).toBe(1);
  expect(fixture.attempts[0]?.settledCalls).toBeGreaterThanOrEqual(2);
  expect(fixture.attempts[0]?.events).toEqual([
    'baseline-seen-before-open',
    'approval-receipt-seen-before-trigger',
    'approval-trigger',
    'approval-option:Approve for me',
    'fill',
    'receipt-seen-before-click',
    'click',
    'quit',
  ]);
  await expect(stat(fixture.attempts[0]!.workspace)).rejects.toMatchObject({
    code: 'ENOENT',
  });
  expect(fixture.host.evidence).toBe('structured');

  const request = await fixture.readOutput<{
    attemptId: string;
    scenario: string;
    fullPrompt: string;
    correlationMarker: string;
    servers: HostRunInput['servers'];
  }>('first-live-shape', 'request.json');
  expect(request).toMatchObject({
    attemptId: 'first-live-shape',
    scenario: 'Find release 0.',
    servers: fixture.input.servers,
  });
  expect(request.fullPrompt).toBe(
    `${request.scenario}\n\n[Desktop evaluation correlation: ${request.correlationMarker}]`
  );
  expect(fixture.attempts[0]?.fills).toEqual([request.fullPrompt]);

  const receipt = await fixture.readOutput<
    CodexElectronSubmitReceipt & { profileId: string; version: number }
  >('first-live-shape', 'submit-receipt.json');
  expect(receipt).toEqual({
    version: 1,
    profileId: fixture.profileId,
    attemptId: 'first-live-shape',
    pid: 4201,
    browserWindowId: 71,
    webContentsId: 91,
    workspace: fixture.attempts[0]?.workspace,
    fullPromptSha256: createHash('sha256')
      .update(request.fullPrompt)
      .digest('hex'),
    inputMode: 'playwright-fill',
    readback: 'exact',
  });
  expect(await fixture.checkpoint('first-live-shape')).toMatchObject({
    attemptId: 'first-live-shape',
    state: 'closed',
    outcome: 'completed',
    receipt,
  });
  const armed = await fixture.readOutput<{
    id: string;
    state: string;
    host: string;
    isolationKey: string;
    policyId: string;
    ruleId: string;
    actionKind: string;
    actionHash: string;
    observationHash: string;
  }>('first-live-shape', 'approval-mode-armed.json');
  const applied = await fixture.readOutput<typeof armed & { state: string }>(
    'first-live-shape',
    'approval-mode-applied.json'
  );
  expect(armed).toMatchObject({
    state: 'armed',
    host: 'codex',
    isolationKey: `${fixture.profileId}:first-live-shape`,
    policyId: 'codex-guardian-approvals-current-task',
    ruleId: 'guardian-approvals-current-task',
    actionKind: 'host_permission_mode',
  });
  expect(applied).toMatchObject({
    id: armed.id,
    state: 'applied',
    actionHash: armed.actionHash,
    observationHash: armed.observationHash,
  });
  expect(
    await fixture.readOutput('first-live-shape', 'approval-mode.json')
  ).toEqual({
    version: 1,
    action: {
      kind: 'host_permission_mode',
      attributes: {
        surface: 'codex',
        mode: 'guardian-approvals',
        scope: 'current_task',
      },
    },
    status: 'configured',
    approvals: 1,
  });
  expect(
    (await stat(join(fixture.root, 'first-live-shape'))).mode & 0o777
  ).toBe(0o700);
  for (const name of [
    'approval-mode-armed.json',
    'approval-mode-applied.json',
    'approval-mode.json',
  ]) {
    const info = await stat(join(fixture.root, 'first-live-shape', name));
    expect(info.mode & 0o777).toBe(0o600);
  }
});

it('HostDefinition.run skips mutation only after positive guardian-mode observation', async () => {
  const fixture = await hostHarness({ initialApprovalMode: 'Approve for me' });

  const result = await fixture.run('already-configured');

  expect(result.error).toBeUndefined();
  expect(fixture.attempts[0]?.events).not.toContain('approval-trigger');
  expect(
    await fixture.readOutput('already-configured', 'approval-mode.json')
  ).toEqual({
    version: 1,
    action: {
      kind: 'host_permission_mode',
      attributes: {
        surface: 'codex',
        mode: 'guardian-approvals',
        scope: 'current_task',
      },
    },
    status: 'already-configured',
    approvals: 0,
  });
  await expect(
    stat(join(fixture.root, 'already-configured', 'approval-mode-armed.json'))
  ).rejects.toMatchObject({ code: 'ENOENT' });
});

it('HostDefinition.run fails closed on any other current permission mode', async () => {
  const fixture = await hostHarness({ initialApprovalMode: 'Full access' });

  const result = await fixture.run('unsafe-current-mode');

  expect(result.error).toMatch(/approval mode observation/);
  expect(fixture.attempts[0]?.fills).toHaveLength(0);
  expect(fixture.attempts[0]?.clicks).toBe(0);
  expect(fixture.attempts[0]?.events).not.toContain('approval-trigger');
  expect(
    await fixture.readOutput('unsafe-current-mode', 'failure.json')
  ).toMatchObject({ stage: 'approval mode observation' });
});

it('HostDefinition.run quarantines after opening a menu without the exact guardian option', async () => {
  const fixture = await hostHarness({ approvalMenu: ['Full access'] });

  const result = await fixture.run('missing-guardian-option');

  expect(result.error).toMatch(/approval mode dispatch/);
  expect(result.error).toMatch(/quarantined/i);
  expect(fixture.attempts[0]?.events).toContain(
    'approval-receipt-seen-before-trigger'
  );
  expect(fixture.attempts[0]?.events).toContain('approval-trigger');
  expect(fixture.attempts[0]?.events).not.toContain(
    'approval-option:Full access'
  );
  expect(fixture.attempts[0]?.quarantines).toBeGreaterThan(0);
  expect(
    await fixture.readOutput(
      'missing-guardian-option',
      'approval-mode-armed.json'
    )
  ).toMatchObject({ state: 'armed' });
  await expect(
    stat(
      join(
        fixture.root,
        'missing-guardian-option',
        'approval-mode-applied.json'
      )
    )
  ).rejects.toMatchObject({ code: 'ENOENT' });
});

it('HostDefinition.run reuses a clean profile for unique attempts and preserves prior receipts', async () => {
  const fixture = await hostHarness();

  await fixture.run('case-1');
  const first = await fixture.checkpoint('case-1');
  await fixture.run('case-2', 'Find release 1.');

  expect(fixture.launches).toBe(2);
  expect(fixture.attempts.map((attempt) => attempt.clicks)).toEqual([1, 1]);
  expect(await fixture.checkpoint('case-1')).toEqual(first);
  expect(await fixture.checkpoint('case-2')).toMatchObject({
    state: 'closed',
    outcome: 'completed',
  });
  const replay = await fixture.run('case-1', 'Do not replay.');
  expect(replay.error).toMatch(/attempt reservation/i);
  expect(fixture.launches).toBe(2);
  expect(await fixture.checkpoint('case-1')).toEqual(first);
});

it('HostDefinition.run persists and returns only allowlisted Electron readiness diagnostics with the safe substage', async () => {
  const privateError = new Error(
    'private renderer payload at /Users/private/profile'
  );
  privateError.name = 'TimeoutError';
  const fixture = await hostHarness({
    readinessFailure: new CodexElectronFailure(
      'private readiness message at /Users/private/profile',
      'window-readiness',
      privateError
    ),
  });

  const failed = await fixture.run('readiness-diagnostics');

  expect(failed.error).toBe(
    'Codex first-host failed during owned Electron readiness/window-readiness; error=TimeoutError; reason=timeout; no retry was attempted.'
  );
  expect(failed.error).not.toMatch(/private|payload|Users/);
  expect(
    await fixture.readOutput('readiness-diagnostics', 'failure.json')
  ).toEqual({
    version: 1,
    stage: 'owned Electron readiness/window-readiness',
    errorName: 'TimeoutError',
    reason: 'timeout',
  });
  expect(
    await fixture.readOutput<HostRunResult>(
      'readiness-diagnostics',
      'host-result.json'
    )
  ).toEqual(failed);
  expect(fixture.launches).toBe(1);
  expect(fixture.attempts[0]?.fills).toHaveLength(0);
  expect(fixture.attempts[0]?.clicks).toBe(0);
  expect(fixture.attempts[0]?.quitCalls).toBe(1);
});

it('HostDefinition.run closes a safe pre-submit failure after settled normal quit', async () => {
  const fixture = await hostHarness({ failFirstObservation: true });

  const failed = await fixture.run('safe-observation-failure');

  expect(failed.error).toMatch(/owned window observation/i);
  expect(failed.error).not.toMatch(/quarantin|retained/i);
  expect(fixture.attempts[0]?.fills).toHaveLength(0);
  expect(fixture.attempts[0]?.clicks).toBe(0);
  expect(fixture.attempts[0]?.quitCalls).toBe(1);
  expect(await fixture.checkpoint('safe-observation-failure')).toMatchObject({
    state: 'closed',
    outcome: 'failed',
  });
  expect(
    await readFile(
      join(fixture.root, 'profile', 'codex', 'config.toml'),
      'utf8'
    ).catch(() => '')
  ).toBe('');
  await expect(stat(fixture.attempts[0]!.workspace)).resolves.toBeDefined();
  await expect(
    stat(join(fixture.attempts[0]!.workspace, '.owner.json'))
  ).resolves.toBeDefined();

  const next = await fixture.run('safe-next');
  expect(next.error).toBeUndefined();
  expect(fixture.launches).toBe(2);
  expect(fixture.attempts[1]?.clicks).toBe(1);
});

it('HostDefinition.run quarantines an unknown submit without a second click or launch', async () => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
  const fixture = await hostHarness({ clickError: true });

  const result = await fixture.run('unknown-submit');

  expect(result.error).toMatch(/quarantin/i);
  expect(fixture.launches).toBe(1);
  expect(fixture.attempts[0]?.clicks).toBe(1);
  expect(fixture.attempts[0]?.quarantines).toBeGreaterThanOrEqual(1);
  expect(await fixture.checkpoint('unknown-submit')).toMatchObject({
    state: 'quarantined',
    outcome: 'failed',
    receipt: { attemptId: 'unknown-submit' },
  });
  expect(
    await readFile(
      join(fixture.root, 'profile', 'codex', 'config.toml'),
      'utf8'
    )
  ).toContain('mcp_servers.desktop_records');
  await expect(stat(fixture.attempts[0]!.workspace)).resolves.toBeDefined();

  const refused = await fixture.run('independent-but-same-profile');
  expect(refused.error).toMatch(/attempt reservation/i);
  expect(fixture.launches).toBe(1);
  expect(fixture.attempts[0]?.clicks).toBe(1);
});

it('HostDefinition.run quarantines incomplete submitted evidence and preserves the receipt', async () => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
  const fixture = await hostHarness({ omitRollout: true });

  const result = await fixture.run('incomplete-evidence', undefined, {
    timeoutMs: 500,
    cleanupTimeoutMs: 300,
  });

  expect(result.error).toMatch(/quarantin/i);
  expect(fixture.attempts[0]?.clicks).toBe(1);
  expect(await fixture.checkpoint('incomplete-evidence')).toMatchObject({
    state: 'quarantined',
    receipt: { inputMode: 'playwright-fill' },
  });
  expect(
    await fixture.readOutput('incomplete-evidence', 'submit-receipt.json')
  ).toBeDefined();
});

it('HostDefinition.run retains and quarantines a fully evidenced workspace when its ownership marker is invalid', async () => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
  const fixture = await hostHarness({ invalidWorkspaceMarker: true });

  const result = await fixture.run('invalid-workspace-owner');

  expect(result.error).toMatch(/quarantin/i);
  expect(fixture.attempts[0]?.clicks).toBe(1);
  await expect(stat(fixture.attempts[0]!.workspace)).resolves.toBeDefined();
  expect(await fixture.checkpoint('invalid-workspace-owner')).toMatchObject({
    state: 'quarantined',
    outcome: 'completed',
  });
});

it('HostDefinition.run quarantines an abnormal Electron shutdown and retains fixture configuration', async () => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
  const fixture = await hostHarness({ shutdownStatus: 'quarantined' });

  const result = await fixture.run('abnormal-shutdown');

  expect(result.error).toMatch(/quarantin/i);
  expect(fixture.attempts[0]?.clicks).toBe(1);
  expect(fixture.attempts[0]?.quitCalls).toBe(1);
  expect(await fixture.checkpoint('abnormal-shutdown')).toMatchObject({
    state: 'quarantined',
    outcome: 'completed',
  });
  expect(
    await readFile(
      join(fixture.root, 'profile', 'codex', 'config.toml'),
      'utf8'
    )
  ).toContain('mcp_servers.desktop_records');
});

it('HostDefinition.run refuses unsafe prior attempt state without launching', async () => {
  const fixture = await hostHarness();
  const profile = await prepareCodexProfile(join(fixture.root, 'profile'));
  await mkdir(join(profile.root, '.host-attempts'), {
    mode: 0o700,
  }).catch(() => {});
  // An unsafe prior directory forces bounded prelaunch failure without Electron.
  await mkdir(join(profile.root, '.host-attempts', 'unknown'), { mode: 0o700 });

  const result = await fixture.run('no-late-launch', undefined, {
    timeoutMs: 50,
  });

  expect(result.error).toMatch(/attempt reservation/i);
  expect(fixture.launches).toBe(0);
});

it('HostDefinition.run retains pending renderer work, requests cleanup once, and never submits late', async () => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
  const fill = deferred<void>();
  const settled = deferred<void>();
  const fixture = await hostHarness({
    pendingFill: fill,
    pendingSettled: settled,
  });

  const pending = fixture.run('pending-fill', undefined, {
    timeoutMs: 500,
    cleanupTimeoutMs: 300,
  });
  await vi.waitFor(() => expect(fixture.attempts[0]?.fills).toHaveLength(1), {
    timeout: 3000,
  });
  const result = await pending;

  expect(result.error).toMatch(/quarantin/i);
  expect(fixture.attempts[0]?.fills).toHaveLength(1);
  expect(fixture.attempts[0]?.clicks).toBe(0);
  expect(fixture.attempts[0]?.settledCalls).toBeGreaterThanOrEqual(1);
  expect(fixture.attempts[0]?.quitCalls).toBe(1);
  fill.resolve();
  settled.resolve();
  await new Promise((resolve) => setImmediate(resolve));
  expect(fixture.attempts[0]?.clicks).toBe(0);
  expect(fixture.launches).toBe(1);
});

it('HostDefinition.run rejects runtime/selectors, missing attempt IDs, and environment input before launch', async () => {
  const fixture = await hostHarness();
  const base = fixture.config('invalid');
  expect(CodexFirstHostSchema.safeParse(base).success).toBe(true);
  expect(
    CodexFirstHostSchema.safeParse({ ...base, runtimePath: '/obsolete' })
      .success
  ).toBe(false);
  expect(
    CodexFirstHostSchema.safeParse({ ...base, selectors: '/obsolete.json' })
      .success
  ).toBe(false);
  expect(
    CodexFirstHostSchema.safeParse({ ...base, attemptId: undefined }).success
  ).toBe(false);

  const result = await fixture.host.run!(
    { ...fixture.input, env: { TOKEN: 'forbidden' } },
    base,
    { manifest: { name: 'host-test', datasets: [] } }
  );
  expect(result.error).toMatch(/preflight/i);
  expect(fixture.launches).toBe(0);
});

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

interface HarnessOptions {
  readinessFailure?: CodexElectronFailure;
  failFirstObservation?: boolean;
  clickError?: boolean;
  omitRollout?: boolean;
  pendingFill?: ReturnType<typeof deferred<void>>;
  pendingSettled?: ReturnType<typeof deferred<void>>;
  shutdownStatus?: 'exited' | 'quarantined';
  invalidWorkspaceMarker?: boolean;
  initialApprovalMode?: string;
  approvalMenu?: string[];
}

interface AttemptRecord {
  attemptId: string;
  workspace: string;
  fills: string[];
  clicks: number;
  opens: number;
  quitCalls: number;
  settledCalls: number;
  quarantines: number;
  events: string[];
}

async function hostHarness(options: HarnessOptions = {}) {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), 'codex-host-test-'))
  );
  roots.push(root);
  const executablePath = join(root, 'ChatGPT.app/Contents/MacOS/ChatGPT');
  await mkdir(join(root, 'ChatGPT.app/Contents/MacOS'), { recursive: true });
  await writeFile(executablePath, 'offline fixture; never execute', {
    mode: 0o700,
  });
  const input: HostRunInput = {
    scenario: 'Find release 0.',
    servers: [
      {
        transport: 'stdio',
        label: 'desktop_records',
        command: process.execPath,
        args: ['--import', '/absolute/fixture-loader.js'],
        cwd: root,
      },
      {
        transport: 'stdio',
        label: 'desktop_decoy',
        command: process.execPath,
        args: ['/absolute/fixture-server.js'],
        cwd: root,
      },
    ],
  };
  let currentAttemptId = '';
  let launches = 0;
  let failObservation = options.failFirstObservation === true;
  const attempts: AttemptRecord[] = [];
  let profileId = '';

  function config(
    attemptId: string,
    budgets: Partial<CodexFirstHostConfig> = {}
  ): CodexFirstHostConfig {
    return {
      type: 'codex-desktop-first',
      attemptId,
      executablePath,
      profilePath: join(root, 'profile'),
      outputDir: join(root, attemptId),
      timeoutMs: 1000,
      cleanupTimeoutMs: 1000,
      appVersion: CODEX_DESKTOP_BUILD,
      ...budgets,
    };
  }

  function launchElectron(
    launchOptions: CodexElectronOptions
  ): CodexElectronLaunch {
    launches += 1;
    const attemptId = currentAttemptId;
    const attempt: AttemptRecord = {
      attemptId,
      workspace: '',
      fills: [],
      clicks: 0,
      opens: 0,
      quitCalls: 0,
      settledCalls: 0,
      quarantines: 0,
      events: [],
    };
    attempts.push(attempt);
    let dom: CodexElectronDOMObservation;
    const ready = (async (): Promise<CodexElectronSession> => {
      if (options.readinessFailure) throw options.readinessFailure;
      const profile = await prepareCodexProfile(launchOptions.profilePath);
      profileId = profile.id;
      expect(launchOptions.profileOwner).toMatchObject({
        profileId: profile.id,
        ownerId: expect.stringMatching(/^[a-f0-9-]{36}$/),
      });
      const workspace = await realpath(
        await mkdtemp(join(tmpdir(), 'codex-electron-workspace-'))
      );
      roots.push(workspace);
      const workspaceOwner = {
        kind: 'codex-electron-workspace' as const,
        version: 1 as const,
        id: randomUUID(),
        path: workspace,
        uid: process.getuid!(),
      };
      const markerPath = join(workspace, '.owner.json');
      await writeFile(
        markerPath,
        JSON.stringify(
          options.invalidWorkspaceMarker
            ? { ...workspaceOwner, path: join(workspace, 'wrong') }
            : workspaceOwner
        ),
        { mode: 0o600 }
      );
      attempt.workspace = workspace;
      dom = readyDOM(basename(workspace));
      let approvalMode = options.initialApprovalMode ?? 'Ask for approval';
      let approvalMenuOpen = false;
      const composer = {
        async fill(text: string) {
          attempt.fills.push(text);
          attempt.events.push('fill');
          if (options.pendingFill) await options.pendingFill.promise;
          dom = readyDOM(basename(workspace), { composerText: text });
        },
      };
      const send = {
        async click() {
          attempt.clicks += 1;
          attempt.events.push('receipt-seen-before-click');
          await readFile(join(root, attemptId, 'submit-receipt.json'));
          attempt.events.push('click');
          if (options.clickError) throw new Error('click acknowledgement lost');
        },
      };
      const rootLocator = {
        locator() {
          return composer;
        },
        getByRole() {
          return send;
        },
      };
      function permissionLocator(values: string[]) {
        return {
          async count() {
            return values.length;
          },
          async isVisible() {
            return values.length === 1;
          },
          async isEnabled() {
            return values.length === 1;
          },
          async textContent() {
            return values[0] ?? null;
          },
          async click() {
            const value = values[0];
            if (!value) throw new Error('missing permission control');
            if (value === approvalMode) {
              await readFile(join(root, attemptId, 'approval-mode-armed.json'));
              attempt.events.push('approval-receipt-seen-before-trigger');
              attempt.events.push('approval-trigger');
              approvalMenuOpen = true;
              return;
            }
            attempt.events.push(`approval-option:${value}`);
            approvalMode = value;
            approvalMenuOpen = false;
          },
          filter(filter: { hasText?: string; has?: unknown }) {
            return permissionLocator(
              values.filter((value) =>
                filter.has !== undefined
                  ? value.includes('Approve for me')
                  : filter.hasText === undefined
                    ? true
                    : value.includes(filter.hasText)
              )
            );
          },
        };
      }
      const page = {
        locator(selector: string) {
          if (selector.includes('data-composer-navigation-target'))
            return permissionLocator([approvalMode]);
          if (selector.includes('menuitem'))
            return permissionLocator(
              approvalMenuOpen
                ? (options.approvalMenu ?? ['Approve for me', 'Full access'])
                : []
            );
          return rootLocator;
        },
        getByText(text: string, query: { exact: boolean }) {
          if (!query.exact) throw new Error('exact text is required');
          return permissionLocator(
            approvalMenuOpen &&
              (
                options.approvalMenu ?? ['Approve for me', 'Full access']
              ).includes(text)
              ? [text]
              : []
          );
        },
      } as unknown as Page;
      const application = Object.assign(new EventEmitter(), {
        async evaluate() {
          attempt.opens += 1;
          await readFile(join(root, attemptId, 'baseline.json'));
          attempt.events.push('baseline-seen-before-open');
          return { handled: true, prevented: true };
        },
      }) as unknown as ElectronApplication;
      const proof = Object.freeze({
        pid: 4200 + launches,
        browserWindowId: 70 + launches,
        webContentsId: 90 + launches,
        owned: true,
        destroyed: false,
        webContentsDestroyed: false,
        visible: true,
        focused: true,
        readyRoute: true,
        appContents: true,
      });
      const session = {
        profile,
        process: {
          pid: proof.pid,
          exited: Promise.resolve({ code: 0, signal: null }),
        },
        exited: Promise.resolve({
          code: 0,
          signal: null,
          status: 'exited',
        }),
        application,
        child: {} as ChildProcess,
        window: page,
        windowProof: proof,
        native: {
          pid: proof.pid,
          executablePath: launchOptions.executablePath,
          userData: profile.paths.electron,
          home: profile.paths.home,
          envHome: profile.paths.home,
          codexHome: profile.paths.codex,
          workspacePath: workspace,
        },
        workspacePath: workspace,
        workspaceOwnership: { ...workspaceOwner, markerPath },
        async readDOM<T>(reader: () => T | Promise<T>): Promise<T> {
          if (failObservation) {
            failObservation = false;
            throw new Error('safe read failed');
          }
          if (reader.name === 'readCodexApprovalDOM')
            return {
              route: 'app://-/index.html',
              composerRootCount: 1,
              triggerCount: 1,
              visibleTriggerCount: 1,
              enabledTriggerCount: 1,
              selectedText: approvalMode,
            } as T;
          return dom as T;
        },
        async runOnce<T>(
          action: (window: Page, remainingMs: number) => Promise<T>
        ): Promise<T> {
          return action(page, 1000);
        },
        async quarantine() {
          attempt.quarantines += 1;
        },
      } as unknown as CodexElectronSession;
      return session;
    })();
    return {
      ready,
      child: undefined,
      async settled() {
        attempt.settledCalls += 1;
        if (options.pendingSettled) await options.pendingSettled.promise;
        await ready.catch(() => {});
      },
      async quit() {
        attempt.quitCalls += 1;
        attempt.events.push('quit');
        return {
          status: options.shutdownStatus ?? 'exited',
          exit: { code: 0, signal: null },
        };
      },
    };
  }

  const host = createCodexDesktopHost({
    launchElectron,
    baselineNativeState: async (
      nativeProfile,
      nativeWorkspace,
      appVersion = CODEX_DESKTOP_BUILD
    ) => ({
      profileId: nativeProfile.id,
      appVersion,
      root: nativeProfile.paths.codex,
      workspace: nativeWorkspace,
      threadIds: [],
      capturedAt: new Date().toISOString(),
    }),
    collectNativeEvidence: async (_nativeProfile, _baseline, nativeRequest) =>
      fakeNativeCollection(nativeRequest, options.omitRollout === true),
  });
  return {
    root,
    host,
    input,
    attempts,
    get launches() {
      return launches;
    },
    get profileId() {
      return profileId;
    },
    config,
    run(
      attemptId: string,
      scenario = input.scenario,
      budgets: Partial<CodexFirstHostConfig> = {}
    ): Promise<HostRunResult> {
      currentAttemptId = attemptId;
      return host.run!({ ...input, scenario }, config(attemptId, budgets), {
        manifest: { name: 'host-test', datasets: [] },
      });
    },
    async checkpoint(attemptId: string): Promise<Record<string, unknown>> {
      return JSON.parse(
        await readFile(
          join(root, 'profile', '.host-attempts', attemptId, 'checkpoint.json'),
          'utf8'
        )
      ) as Record<string, unknown>;
    },
    async readOutput<T = unknown>(attemptId: string, name: string): Promise<T> {
      return JSON.parse(
        await readFile(join(root, attemptId, name), 'utf8')
      ) as T;
    },
  };
}

function fakeNativeCollection(
  request: CodexNativeRequest,
  incomplete: boolean
): CodexNativeCollection {
  const evidence = incomplete
    ? {
        qualification: 'unqualified' as const,
        reason: 'No complete native evidence in the offline lifecycle fixture.',
        profileId: request.profileId,
        appVersion: request.appVersion,
        promptSha256: request.promptSha256,
        terminal: false as const,
      }
    : {
        qualification: 'qualified' as const,
        reason: 'Offline lifecycle fixture is complete and correlated.',
        profileId: request.profileId,
        appVersion: request.appVersion,
        sessionId: 'native-thread',
        workspace: request.workspace,
        promptSha256: request.promptSha256,
        terminal: true as const,
        trace: {
          finalText: 'Synthetic answer',
          events: [
            {
              kind: 'tool_call' as const,
              source: 'mcp' as const,
              server: 'desktop_records',
              name: 'lookup_record',
              arguments: { namespace: 'releases', reference: 'direct' },
              output: JSON.stringify({
                content: [{ type: 'text', text: 'Synthetic answer' }],
                structuredContent: { status: 'found' },
                isError: false,
              }),
              id: 'call-1',
            },
          ],
        },
      };
  return {
    evidence,
    database: {
      format: 'codex-desktop-sqlite-v1',
      state: 'state_5.sqlite',
      history: 'thread_history_1.sqlite',
    },
  };
}

function readyDOM(
  workspaceName: string,
  overrides: Partial<CodexElectronDOMObservation> = {}
): CodexElectronDOMObservation {
  return {
    route: 'app://-/index.html',
    modeCodexCount: 1,
    homeComposerRootCount: 1,
    composerCount: 1,
    composerText: '',
    composerPlainText: true,
    workspaceProjectTargetCount: 1,
    workspaceProjectTargetNames: [`Change project: ${workspaceName}`],
    workspaceProjectTargetTexts: [workspaceName],
    forbiddenWorktreeCount: 0,
    runLocationCount: 0,
    runLocationNames: [],
    runLocationTexts: [],
    footerCount: 1,
    footerText: workspaceName,
    signInCount: 0,
    dialogCount: 0,
    turnCount: 0,
    generationCount: 0,
    queueCount: 0,
    attachmentCount: 0,
    sendButtonCount: 1,
    sendButtonEnabled: true,
    ...overrides,
  };
}
