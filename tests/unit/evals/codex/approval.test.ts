import { runInNewContext } from 'node:vm';
import type { Locator, Page } from '@playwright/test';
import { describe, expect, it } from 'vitest';
import type { ApprovalObservation } from '../../../../src/evals/approvalAutomation.js';
import {
  CODEX_GUARDIAN_APPROVAL_POLICY,
  createCodexGuardianApprovalAdapter,
  type CodexApprovalHandle,
} from '../../../../src/evals/codex/approval.js';
import type { CodexElectronSession } from '../../../../src/evals/codex/electron.js';

interface ModeSnapshot {
  route: string;
  composerRootCount: number;
  triggerCount: number;
  visibleTriggerCount: number;
  enabledTriggerCount: number;
  selectedText: string;
}

interface ControlState {
  text: string;
  visible?: boolean;
  enabled?: boolean;
  clicks: number;
}

function snapshot(
  selectedText: string,
  overrides: Partial<ModeSnapshot> = {}
): ModeSnapshot {
  return {
    route: 'app://-/index.html',
    composerRootCount: 1,
    triggerCount: 1,
    visibleTriggerCount: 1,
    enabledTriggerCount: 1,
    selectedText,
    ...overrides,
  };
}

function locator(controls: ControlState[]): Locator {
  return {
    async count() {
      return controls.length;
    },
    async isVisible() {
      return controls[0]?.visible !== false;
    },
    async isEnabled() {
      return controls[0]?.enabled !== false;
    },
    async textContent() {
      return controls[0]?.text ?? null;
    },
    async click() {
      if (!controls[0]) throw new Error('missing control');
      controls[0].clicks += 1;
    },
    filter(options: { hasText?: string; has?: Locator }) {
      return locator(
        controls.filter((control) =>
          options.has !== undefined
            ? control.text.includes('Approve for me')
            : options.hasText === undefined
              ? true
              : control.text.includes(options.hasText)
        )
      );
    },
  } as unknown as Locator;
}

function browserDOM(
  selectedText: string,
  options: { triggerCount?: number; visible?: boolean; enabled?: boolean } = {}
) {
  const triggerCount = options.triggerCount ?? 1;
  const triggers = Array.from({ length: triggerCount }, () => ({
    textContent: selectedText,
    disabled: options.enabled === false,
    hidden: false,
    getAttribute(name: string) {
      return name === 'aria-disabled' && options.enabled === false
        ? 'true'
        : null;
    },
    getClientRects() {
      return options.visible === false ? [] : [{}];
    },
  }));
  return {
    location: { href: 'app://-/index.html' },
    document: {
      querySelectorAll(selector: string) {
        return selector.includes('data-composer-placement') ? [{}] : triggers;
      },
    },
    getComputedStyle() {
      return {
        display: options.visible === false ? 'none' : 'block',
        visibility: 'visible',
      };
    },
  };
}

function fixture(
  options: {
    observations?: ModeSnapshot[];
    regroundedTrigger?: Partial<ControlState>;
    menu?: Array<Partial<ControlState> & { text: string }>;
    proof?: Record<string, unknown>;
    browser?: object;
  } = {}
) {
  const observations = [
    ...(options.observations ?? [
      snapshot('Ask for approval'),
      snapshot('Approve for me'),
    ]),
  ];
  const trigger: ControlState = {
    text: 'Ask for approval',
    visible: true,
    enabled: true,
    clicks: 0,
    ...options.regroundedTrigger,
  };
  const menu: ControlState[] = (
    options.menu ?? [{ text: 'Approve for me' }, { text: 'Full access' }]
  ).map((control) => ({
    visible: true,
    enabled: true,
    clicks: 0,
    ...control,
  }));
  let readDOMCalls = 0;
  let runOnceCalls = 0;
  const page = {
    locator(selector: string) {
      if (selector.includes('data-composer-navigation-target'))
        return locator([trigger]);
      if (selector.includes('menuitem')) return locator(menu);
      throw new Error(`unexpected selector: ${selector}`);
    },
    getByText(text: string, query: { exact: boolean }) {
      if (!query.exact) throw new Error('exact text is required');
      return locator(menu.filter((control) => control.text === text));
    },
  } as unknown as Page;
  const proof = Object.freeze({
    pid: 42,
    browserWindowId: 7,
    webContentsId: 9,
    owned: true,
    destroyed: false,
    webContentsDestroyed: false,
    visible: true,
    focused: true,
    readyRoute: true,
    appContents: true,
    ...options.proof,
  });
  const session = {
    process: { pid: 42 },
    native: { pid: 42 },
    windowProof: proof,
    workspacePath: '/tmp/codex-electron-workspace-test',
    workspaceOwnership: {
      kind: 'codex-electron-workspace',
      version: 1,
      id: '7ecf4887-1087-4686-96e6-82ebc11cc57f',
      path: '/tmp/codex-electron-workspace-test',
      markerPath: '/tmp/codex-electron-workspace-test/.owner.json',
      uid: 501,
    },
    async readDOM<T>(reader: () => T | Promise<T>): Promise<T> {
      readDOMCalls += 1;
      if (options.browser)
        return runInNewContext(
          `(${reader.toString()})()`,
          options.browser
        ) as T;
      const next =
        observations.length > 1 ? observations.shift() : observations[0];
      if (!next) throw new Error('missing observation');
      return next as T;
    },
    async runOnce<T>(
      action: (window: Page, remainingMs: number) => Promise<T>
    ): Promise<T> {
      runOnceCalls += 1;
      return action(page, 1000);
    },
  } as unknown as CodexElectronSession;
  const stages: string[] = [];
  const adapter = createCodexGuardianApprovalAdapter({
    session,
    onStage(stage) {
      stages.push(stage);
    },
  });
  return {
    adapter,
    trigger,
    menu,
    stages,
    get readDOMCalls() {
      return readDOMCalls;
    },
    get runOnceCalls() {
      return runOnceCalls;
    },
  };
}

async function observed(f: ReturnType<typeof fixture>) {
  return (await f.adapter.observe()) as ApprovalObservation<CodexApprovalHandle>;
}

describe('Codex guardian-approvals adapter', () => {
  it('observes, re-grounds, selects Approve for me once, and positively verifies', async () => {
    const f = fixture();

    const observation = await observed(f);

    expect(observation.action).toEqual({
      kind: 'host_permission_mode',
      attributes: {
        surface: 'codex',
        mode: 'guardian-approvals',
        scope: 'current_task',
      },
    });
    await f.adapter.approve(observation);
    await expect(f.adapter.verify(observation)).resolves.toBe('applied');
    expect(f.adapter.isConfigured()).toBe(true);
    expect(f.adapter.configurationSource()).toBe('verified');
    expect(f.runOnceCalls).toBe(1);
    expect(f.readDOMCalls).toBe(2);
    expect(f.trigger.clicks).toBe(1);
    expect(
      f.menu.find((control) => control.text === 'Approve for me')?.clicks
    ).toBe(1);
    expect(
      f.menu.find((control) => control.text === 'Full access')?.clicks
    ).toBe(0);
    expect(f.stages).toEqual(['observation', 'dispatch', 'verification']);
  });

  it('skips only after an exact positive configured-state observation', async () => {
    const f = fixture({ observations: [snapshot('Approve for me')] });

    await expect(f.adapter.observe()).resolves.toBeNull();

    expect(f.adapter.isConfigured()).toBe(true);
    expect(f.adapter.configurationSource()).toBe('observed');
    expect(f.runOnceCalls).toBe(0);
  });

  it('uses a self-contained bounded DOM reader for the exact pinned trigger', async () => {
    const f = fixture({ browser: browserDOM('Approve for me') });

    await expect(f.adapter.observe()).resolves.toBeNull();

    expect(f.readDOMCalls).toBe(1);
    expect(f.adapter.configurationSource()).toBe('observed');
  });

  it('saturates duplicate renderer controls and refuses them', async () => {
    const f = fixture({
      browser: browserDOM('Ask for approval', { triggerCount: 20 }),
    });

    await expect(f.adapter.observe()).rejects.toThrow(/control/);

    expect(f.runOnceCalls).toBe(0);
  });

  it.each([
    ['Full access mode', snapshot('Full access')],
    ['duplicate triggers', snapshot('Ask for approval', { triggerCount: 2 })],
    [
      'hidden trigger',
      snapshot('Ask for approval', { visibleTriggerCount: 0 }),
    ],
    [
      'disabled trigger',
      snapshot('Ask for approval', { enabledTriggerCount: 0 }),
    ],
    ['wrong route', snapshot('Ask for approval', { route: 'app://-/other' })],
  ])('refuses %s before mutation', async (_name, state) => {
    const f = fixture({ observations: [state] });

    await expect(f.adapter.observe()).rejects.toThrow();

    expect(f.runOnceCalls).toBe(0);
    expect(f.adapter.isConfigured()).toBe(false);
  });

  it('refuses a stale re-grounded trigger without clicking', async () => {
    const f = fixture({ regroundedTrigger: { text: 'Approve for me' } });
    const observation = await observed(f);

    await expect(f.adapter.approve(observation)).rejects.toThrow(/actionable/);

    expect(f.runOnceCalls).toBe(1);
    expect(f.trigger.clicks).toBe(0);
    expect(f.menu.every((control) => control.clicks === 0)).toBe(true);
  });

  it('never selects Full access when the exact guardian option is absent', async () => {
    const f = fixture({ menu: [{ text: 'Full access' }] });
    const observation = await observed(f);

    await expect(f.adapter.approve(observation)).rejects.toThrow(/actionable/);

    expect(f.trigger.clicks).toBe(1);
    expect(f.menu[0]?.clicks).toBe(0);
    expect(f.runOnceCalls).toBe(1);
  });

  it('requires positive post-click mode text and does not infer from disappearance', async () => {
    const f = fixture({
      observations: [
        snapshot('Ask for approval'),
        snapshot('', {
          triggerCount: 0,
          visibleTriggerCount: 0,
          enabledTriggerCount: 0,
        }),
      ],
    });
    const observation = await observed(f);
    await f.adapter.approve(observation);

    await expect(f.adapter.verify(observation)).resolves.toBe('unknown');

    expect(f.adapter.isConfigured()).toBe(false);
  });

  it('rejects a session without exact owned renderer semantics', () => {
    expect(() => fixture({ proof: { owned: false } })).toThrow(
      /owned Codex renderer/
    );
  });

  it('exports a max-one exact guardian policy', () => {
    expect(CODEX_GUARDIAN_APPROVAL_POLICY).toEqual({
      id: 'codex-guardian-approvals-current-task',
      maxTotalApprovals: 1,
      rules: [
        {
          id: 'guardian-approvals-current-task',
          kind: 'host_permission_mode',
          match: {
            surface: 'codex',
            mode: 'guardian-approvals',
            scope: 'current_task',
          },
          maxUses: 1,
        },
      ],
    });
  });
});
