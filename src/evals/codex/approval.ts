import { createHash } from 'node:crypto';
import type { Locator } from '@playwright/test';
import type {
  ApprovalAction,
  ApprovalAdapter,
  ApprovalObservation,
  ApprovalPolicy,
} from '../approvalAutomation.js';
import type { CodexElectronSession } from './electron.js';

const PERMISSION_TRIGGER_SELECTOR =
  'button[data-composer-navigation-target="permissions"]:visible';
const PERMISSION_OPTION_SELECTOR =
  '[role="menuitem"]:visible, [role="menuitemradio"]:visible';
const ASK_FOR_APPROVAL = 'Ask for approval';
const APPROVE_FOR_ME = 'Approve for me';

export const CODEX_GUARDIAN_APPROVAL_POLICY: ApprovalPolicy = {
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
};

export interface CodexApprovalHandle {
  readonly pid: number;
  readonly browserWindowId: number;
  readonly webContentsId: number;
  readonly workspaceOwnershipId: string;
  readonly currentMode: 'ask-for-approval';
}

export interface CodexApprovalModeAdapter extends ApprovalAdapter<CodexApprovalHandle> {
  /** True only after a strict configured-state observation or verification. */
  isConfigured(): boolean;
  configurationSource(): 'observed' | 'verified' | null;
}

interface CodexApprovalDOMObservation {
  readonly route: string;
  /** Counts are saturated at two to keep renderer output bounded. */
  readonly composerRootCount: number;
  readonly triggerCount: number;
  readonly visibleTriggerCount: number;
  readonly enabledTriggerCount: number;
  /** At most 64 UTF-16 code units. */
  readonly selectedText: string;
}

interface CodexApprovalBrowserElement {
  readonly disabled?: boolean;
  readonly hidden?: boolean;
  readonly textContent: string | null;
  getAttribute(name: string): string | null;
  getClientRects(): ArrayLike<unknown>;
}

interface CodexApprovalBrowserGlobal {
  readonly document: {
    querySelectorAll(selector: string): ArrayLike<CodexApprovalBrowserElement>;
  };
  readonly location: { readonly href: string };
  getComputedStyle(element: CodexApprovalBrowserElement): {
    readonly display: string;
    readonly visibility: string;
  };
}

function readCodexApprovalDOM(): CodexApprovalDOMObservation {
  // Playwright serializes this function. Keep it self-contained and bounded.
  const browser = globalThis as unknown as CodexApprovalBrowserGlobal;
  const roots = browser.document.querySelectorAll(
    '[data-codex-composer-root][data-composer-placement="home"]'
  );
  const triggers = browser.document.querySelectorAll(
    'button[data-composer-navigation-target="permissions"]'
  );
  let visibleTriggerCount = 0;
  let enabledTriggerCount = 0;
  let selectedText = '';
  const inspected = Math.min(triggers.length, 2);
  for (let index = 0; index < inspected; index += 1) {
    const trigger = triggers[index];
    if (!trigger) continue;
    const style = browser.getComputedStyle(trigger);
    const visible =
      trigger.hidden !== true &&
      trigger.getAttribute('aria-hidden') !== 'true' &&
      trigger.getClientRects().length > 0 &&
      style.display !== 'none' &&
      style.visibility !== 'hidden';
    if (!visible) continue;
    visibleTriggerCount = Math.min(visibleTriggerCount + 1, 2);
    const enabled =
      trigger.disabled !== true &&
      trigger.getAttribute('aria-disabled') !== 'true';
    if (enabled) enabledTriggerCount = Math.min(enabledTriggerCount + 1, 2);
    if (visibleTriggerCount === 1)
      selectedText = (trigger.textContent ?? '').slice(0, 64);
  }
  return {
    route: browser.location.href.slice(0, 64),
    composerRootCount: Math.min(roots.length, 2),
    triggerCount: Math.min(triggers.length, 2),
    visibleTriggerCount,
    enabledTriggerCount,
    selectedText,
  };
}

export function createCodexGuardianApprovalAdapter(options: {
  session: CodexElectronSession;
  onStage?(stage: 'observation' | 'dispatch' | 'verification'): void;
}): CodexApprovalModeAdapter {
  const { session } = options;
  requireOwnedRenderer(session);
  let configuredSource: 'observed' | 'verified' | null = null;

  return {
    observe,
    approve,
    verify,
    isConfigured() {
      return configuredSource !== null;
    },
    configurationSource() {
      return configuredSource;
    },
  };

  async function observe(): Promise<ApprovalObservation<CodexApprovalHandle> | null> {
    options.onStage?.('observation');
    const state = await observeStrictMode(session);
    if (state === APPROVE_FOR_ME) {
      configuredSource = 'observed';
      return null;
    }
    if (state !== ASK_FOR_APPROVAL)
      throw new Error('Codex permission mode is not the exact expected mode.');
    const proof = requireOwnedRenderer(session);
    const action = guardianAction();
    return {
      id: hash(
        `${proof.pid}\n${proof.browserWindowId}\n${proof.webContentsId}\n${session.workspaceOwnership.id}\n${state}`
      ),
      action,
      handle: {
        pid: proof.pid,
        browserWindowId: proof.browserWindowId,
        webContentsId: proof.webContentsId,
        workspaceOwnershipId: session.workspaceOwnership.id,
        currentMode: 'ask-for-approval',
      },
    };
  }

  async function approve(
    observation: ApprovalObservation<CodexApprovalHandle>
  ): Promise<void> {
    options.onStage?.('dispatch');
    requireObservation(session, observation);
    await session.runOnce(async (window, remainingMs) => {
      const deadline = Date.now() + remainingMs;
      const trigger = window.locator(PERMISSION_TRIGGER_SELECTOR);
      await requireExactActionable(trigger, ASK_FOR_APPROVAL);
      await trigger.click({ timeout: remaining(deadline) });

      const label = window.getByText(APPROVE_FOR_ME, { exact: true });
      await requireExactActionable(label, APPROVE_FOR_ME);
      const option = window
        .locator(PERMISSION_OPTION_SELECTOR)
        .filter({ has: label });
      await requireUniqueActionable(option);
      await option.click({ timeout: remaining(deadline) });
    });
  }

  async function verify(): Promise<'applied' | 'not_applied' | 'unknown'> {
    options.onStage?.('verification');
    let state: string;
    try {
      state = await observeStrictMode(session);
    } catch {
      return 'unknown';
    }
    if (state === APPROVE_FOR_ME) {
      configuredSource = 'verified';
      return 'applied';
    }
    return state === ASK_FOR_APPROVAL ? 'not_applied' : 'unknown';
  }
}

async function observeStrictMode(
  session: CodexElectronSession
): Promise<string> {
  requireOwnedRenderer(session);
  const observation = await session.readDOM(readCodexApprovalDOM);
  requireOwnedRenderer(session);
  if (
    observation.route !== 'app://-/index.html' ||
    observation.composerRootCount !== 1 ||
    observation.triggerCount !== 1 ||
    observation.visibleTriggerCount !== 1 ||
    observation.enabledTriggerCount !== 1
  )
    throw new Error('Unverified Codex permission mode control.');
  return observation.selectedText;
}

function requireOwnedRenderer(session: CodexElectronSession) {
  const proof = session.windowProof;
  if (
    proof.pid !== session.process.pid ||
    proof.pid !== session.native.pid ||
    !Number.isInteger(proof.pid) ||
    proof.pid < 1 ||
    !Number.isInteger(proof.browserWindowId) ||
    proof.browserWindowId < 1 ||
    !Number.isInteger(proof.webContentsId) ||
    proof.webContentsId < 1 ||
    proof.owned !== true ||
    proof.destroyed !== false ||
    proof.webContentsDestroyed !== false ||
    proof.visible !== true ||
    proof.focused !== true ||
    proof.readyRoute !== true ||
    proof.appContents !== true ||
    session.workspaceOwnership.path !== session.workspacePath
  )
    throw new Error('Unverified owned Codex renderer.');
  return proof;
}

function requireObservation(
  session: CodexElectronSession,
  observation: ApprovalObservation<CodexApprovalHandle>
): void {
  const proof = requireOwnedRenderer(session);
  const expected = guardianAction();
  if (
    observation.action.kind !== expected.kind ||
    observation.action.attributes.surface !== expected.attributes.surface ||
    observation.action.attributes.mode !== expected.attributes.mode ||
    observation.action.attributes.scope !== expected.attributes.scope ||
    Object.keys(observation.action.attributes).length !== 3 ||
    observation.handle.pid !== proof.pid ||
    observation.handle.browserWindowId !== proof.browserWindowId ||
    observation.handle.webContentsId !== proof.webContentsId ||
    observation.handle.workspaceOwnershipId !== session.workspaceOwnership.id ||
    observation.handle.currentMode !== 'ask-for-approval'
  )
    throw new Error('Stale or invalid Codex permission mode observation.');
}

async function requireExactActionable(
  locator: Locator,
  exactText: string
): Promise<void> {
  await requireUniqueActionable(locator);
  if ((await locator.textContent()) !== exactText)
    throw new Error('Codex permission control is not uniquely actionable.');
}

async function requireUniqueActionable(locator: Locator): Promise<void> {
  if (
    (await locator.count()) !== 1 ||
    !(await locator.isVisible()) ||
    !(await locator.isEnabled())
  )
    throw new Error('Codex permission control is not uniquely actionable.');
}

function guardianAction(): ApprovalAction {
  return {
    kind: 'host_permission_mode',
    attributes: {
      surface: 'codex',
      mode: 'guardian-approvals',
      scope: 'current_task',
    },
  };
}

function remaining(deadline: number): number {
  const value = deadline - Date.now();
  if (!(value > 0))
    throw new Error('Codex permission action deadline exceeded.');
  return value;
}

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
