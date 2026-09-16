import { createHash } from 'node:crypto';
import { basename, isAbsolute, normalize } from 'node:path';
import type { Page } from '@playwright/test';
import type { CodexElectronSession } from './electron.js';

const HOME_COMPOSER_SELECTOR =
  '[data-codex-composer-root][data-composer-placement="home"]';
const COMPOSER_SELECTOR =
  '[data-codex-composer="true"][role="textbox"][contenteditable="true"]';
const FRESH_WORKSPACE_POLL_MS = 100;
const FRESH_WORKSPACE_TIMEOUT_MS = 30_000;

export interface CodexElectronDOMObservation {
  readonly route: string;
  readonly modeCodexCount: number;
  readonly homeComposerRootCount: number;
  readonly composerCount: number;
  readonly composerText: string;
  readonly composerPlainText: boolean;
  /** Saturated at 2; freshness requires exactly one verified target. */
  readonly workspaceProjectTargetCount: number;
  /** Bounded to 2 values of at most 512 UTF-16 code units each. */
  readonly workspaceProjectTargetNames: readonly string[];
  /** Bounded to 2 values of at most 256 UTF-16 code units each. */
  readonly workspaceProjectTargetTexts: readonly string[];
  /** Saturated at 2; freshness requires no branch/worktree evidence. */
  readonly forbiddenWorktreeCount: number;
  /** Saturated at 2; zero means the verified default local location. */
  readonly runLocationCount: number;
  /** Bounded to 2 values of at most 512 UTF-16 code units each. */
  readonly runLocationNames: readonly string[];
  /** Bounded to 2 values of at most 256 UTF-16 code units each. */
  readonly runLocationTexts: readonly string[];
  readonly footerCount: number;
  readonly footerText: string;
  /** Bounded to 32 values of at most 256 UTF-16 code units each. */
  readonly footerTexts?: readonly string[];
  readonly signInCount: number;
  readonly dialogCount: number;
  readonly turnCount: number;
  readonly generationCount: number;
  readonly queueCount: number;
  readonly attachmentCount: number;
  readonly sendButtonCount: number;
  readonly sendButtonEnabled: boolean;
}

export interface CodexElectronObservation extends CodexElectronDOMObservation {
  readonly pid: number;
  readonly browserWindowId: number;
  readonly webContentsId: number;
}

export interface CodexElectronSubmitReceipt {
  readonly attemptId: string;
  readonly pid: number;
  readonly browserWindowId: number;
  readonly webContentsId: number;
  readonly workspace: string;
  readonly fullPromptSha256: string;
  readonly inputMode: 'playwright-fill';
  readonly readback: 'exact';
}

export type CodexElectronSubmitAcknowledgement =
  | { readonly status: 'acknowledged' }
  | {
      readonly status: 'uncertain';
      readonly error: CodexElectronControlError;
    };

export interface CodexElectronControl {
  observe(): Promise<CodexElectronObservation>;
  openFreshWorkspace(path: string): Promise<void>;
  replacePrompt(text: string): Promise<void>;
  submitOnce(): Promise<CodexElectronSubmitAcknowledgement>;
}

export interface CodexElectronControlOptions {
  session: CodexElectronSession;
  attemptId: string;
  onFreshWorkspaceObservation?(
    this: void,
    diagnostic: CodexFreshWorkspaceDiagnostic
  ): void;
  beforeSubmit(this: void, receipt: CodexElectronSubmitReceipt): Promise<void>;
}

export interface CodexFreshWorkspaceDiagnostic {
  routeReady: boolean;
  modeCodexCount: number;
  homeComposerRootCount: number;
  composerCount: number;
  composerPlainText: boolean;
  composerEmpty: boolean;
  workspaceProjectTargetCount: number;
  workspaceNameMatches: boolean;
  workspaceTextMatches: boolean;
  forbiddenWorktreeCount: number;
  runLocationCount: number;
  localRunLocation: boolean;
  signInCount: number;
  dialogCount: number;
  turnCount: number;
  generationCount: number;
  queueCount: number;
  attachmentCount: number;
}

export class CodexElectronControlError extends Error {
  constructor(
    message: string,
    readonly uncertain = false
  ) {
    super(message);
    this.name = 'CodexElectronControlError';
  }
}

interface ElectronOpenUrlApp {
  emit(
    event: 'open-url',
    nativeEvent: { preventDefault(): void },
    href: string
  ): boolean;
}

interface ElectronOpenUrlResult {
  handled: boolean;
  prevented: boolean;
}

interface BrowserNodeFacade {
  readonly nodeType: number;
  readonly tagName?: string;
  readonly textContent: string | null;
  readonly childNodes: ArrayLike<BrowserNodeFacade>;
}

interface BrowserElementFacade extends BrowserNodeFacade {
  readonly disabled?: boolean;
  getAttribute(name: string): string | null;
  querySelectorAll(selector: string): ArrayLike<BrowserElementFacade>;
}

interface BrowserGlobalFacade {
  readonly document: BrowserElementFacade;
  readonly location: { readonly href: string };
}

function readCodexDOM(): CodexElectronDOMObservation {
  // Playwright serializes this function. Keep it self-contained: no captured
  // constants, imported helpers, or nested functions that esbuild can rename.
  const browser = globalThis as unknown as BrowserGlobalFacade;
  const document = browser.document;
  const roots = document.querySelectorAll(
    '[data-codex-composer-root][data-composer-placement="home"]'
  );
  const root = roots.length === 1 ? roots[0] : undefined;
  const composers = root
    ? root.querySelectorAll(
        '[data-codex-composer="true"][role="textbox"][contenteditable="true"]'
      )
    : [];
  const composer = composers.length === 1 ? composers[0] : undefined;
  const navigationTargets = root
    ? root.querySelectorAll('[data-composer-navigation-target]')
    : [];
  let workspaceProjectTargetCount = 0;
  const workspaceProjectTargetNames: string[] = [];
  const workspaceProjectTargetTexts: string[] = [];
  let forbiddenWorktreeCount = 0;
  let runLocationCount = 0;
  const runLocationNames: string[] = [];
  const runLocationTexts: string[] = [];
  const navigationTargetLimit = 32;
  for (
    let index = 0;
    index < navigationTargets.length && index < navigationTargetLimit;
    index += 1
  ) {
    const target = navigationTargets[index];
    if (!target) continue;
    const kind = target.getAttribute('data-composer-navigation-target') ?? '';
    const name = (target.getAttribute('aria-label') ?? '').slice(0, 512);
    const rawText = target.textContent ?? '';
    const text =
      rawText.length > 256
        ? rawText.slice(0, 256)
        : rawText.trim().slice(0, 256);
    if (kind === 'workspace-project') {
      workspaceProjectTargetCount = Math.min(
        workspaceProjectTargetCount + 1,
        2
      );
      if (workspaceProjectTargetNames.length < 2) {
        workspaceProjectTargetNames.push(name);
        workspaceProjectTargetTexts.push(text);
      }
    }
    if (kind === 'run-location') {
      runLocationCount = Math.min(runLocationCount + 1, 2);
      if (runLocationNames.length < 2) {
        runLocationNames.push(name);
        runLocationTexts.push(text);
      }
    }
    if (
      /(?:^|[^a-z])(branch|worktree)(?:$|[^a-z])/i.test(kind) ||
      /(?:^|[^a-z])(branch|worktree)(?:$|[^a-z])/i.test(name) ||
      /(?:^|[^a-z])(branch|worktree)(?:$|[^a-z])/i.test(text) ||
      (kind === 'run-location' &&
        /(?:^|[^a-z])(remote|cloud)(?:$|[^a-z])/i.test(text))
    )
      forbiddenWorktreeCount = Math.min(forbiddenWorktreeCount + 1, 2);
  }
  if (navigationTargets.length > navigationTargetLimit) {
    workspaceProjectTargetCount = 2;
    forbiddenWorktreeCount = 2;
    runLocationCount = 2;
  }
  const footers = document.querySelectorAll(
    '[data-composer-footer-collapse] [data-tooltip-overflow-target="true"]'
  );
  const footerTexts: string[] = [];
  for (let index = 0; index < footers.length && index < 32; index += 1)
    footerTexts.push((footers[index]?.textContent ?? '').slice(0, 256));

  let composerPlainText = composer !== undefined;
  let composerText = '';
  if (composer) {
    const pending: Array<{
      node?: BrowserNodeFacade;
      text?: string;
      emitBreak?: boolean;
    }> = [];
    for (let index = composer.childNodes.length - 1; index >= 0; index -= 1) {
      const child = composer.childNodes[index];
      if (!child) continue;
      pending.push({
        node: child,
        emitBreak: !(
          composer.childNodes.length === 1 && child.tagName === 'BR'
        ),
      });
      const previous = index > 0 ? composer.childNodes[index - 1] : undefined;
      if (child.tagName === 'P' && previous?.tagName === 'P')
        pending.push({ text: '\n' });
    }
    let visited = 0;
    while (pending.length > 0 && composerPlainText) {
      const entry = pending.pop();
      if (!entry) {
        composerPlainText = false;
      } else if (entry.text !== undefined) {
        composerText += entry.text;
      } else {
        const node = entry.node;
        visited += 1;
        if (!node || visited > 16_384) {
          composerPlainText = false;
        } else if (node.nodeType === 3) {
          composerText += node.textContent ?? '';
        } else if (node.nodeType !== 1) {
          composerPlainText = false;
        } else if (node.tagName === 'BR') {
          if (node.childNodes.length !== 0) composerPlainText = false;
          else if (entry.emitBreak !== false) composerText += '\n';
        } else if (node.tagName === 'P') {
          for (let index = node.childNodes.length - 1; index >= 0; index -= 1) {
            const child = node.childNodes[index];
            if (child)
              pending.push({
                node: child,
                emitBreak: !(
                  node.childNodes.length === 1 && child.tagName === 'BR'
                ),
              });
          }
        } else {
          composerPlainText = false;
        }
      }
    }
    if (!composerPlainText) composerText = composer.textContent ?? '';
  }

  const interactive = document.querySelectorAll('button, a');
  let signInCount = 0;
  for (let index = 0; index < interactive.length; index += 1) {
    const element = interactive[index];
    if (!element) continue;
    const ariaLabel = element.getAttribute('aria-label');
    const exactName = ariaLabel ?? element.textContent?.trim() ?? '';
    if (exactName === 'Sign in' || exactName === 'Log in') signInCount += 1;
  }

  const buttons = root ? root.querySelectorAll('button') : [];
  let sendButton: BrowserElementFacade | undefined;
  let sendButtonCount = 0;
  for (let index = 0; index < buttons.length; index += 1) {
    const button = buttons[index];
    if (!button) continue;
    const ariaLabel = button.getAttribute('aria-label');
    const exactName = ariaLabel ?? button.textContent?.trim() ?? '';
    if (exactName === 'Send') {
      sendButtonCount += 1;
      sendButton = button;
    }
  }

  return {
    route: browser.location.href,
    modeCodexCount: document.querySelectorAll(
      'button[aria-label="Switch mode, current mode: Codex"]'
    ).length,
    homeComposerRootCount: roots.length,
    composerCount: composers.length,
    composerText,
    composerPlainText,
    workspaceProjectTargetCount,
    workspaceProjectTargetNames,
    workspaceProjectTargetTexts,
    forbiddenWorktreeCount,
    runLocationCount,
    runLocationNames,
    runLocationTexts,
    footerCount: footers.length,
    footerText:
      footers.length === 1 ? (footers[0]?.textContent ?? '').slice(0, 256) : '',
    footerTexts,
    signInCount,
    dialogCount: document.querySelectorAll('[role="dialog"]').length,
    turnCount: document.querySelectorAll(
      '[data-turn-id], [data-testid^="conversation-turn"], [data-message-author-role]'
    ).length,
    generationCount: document.querySelectorAll(
      '[aria-label="Stop generating"], [data-is-generating="true"], [data-generating="true"], [data-testid="stop-button"]'
    ).length,
    queueCount: document.querySelectorAll(
      '[data-queued="true"], [data-testid="queued-message"], [data-testid="prompt-queue"]'
    ).length,
    attachmentCount: document.querySelectorAll(
      '[data-attachment-id], [data-testid="attachment"], [data-testid="attachment-chip"], [aria-label^="Remove attachment"]'
    ).length,
    sendButtonCount,
    sendButtonEnabled:
      sendButtonCount === 1 &&
      sendButton !== undefined &&
      sendButton.disabled !== true,
  };
}

function sameBoundedTexts(
  first: readonly string[] | undefined,
  second: readonly string[] | undefined
): boolean {
  if (first === undefined || second === undefined) return first === second;
  if (first.length !== second.length) return false;
  for (let index = 0; index < first.length; index += 1)
    if (first[index] !== second[index]) return false;
  return true;
}

function sameDOM(
  first: CodexElectronDOMObservation,
  second: CodexElectronDOMObservation
): boolean {
  return (
    first.route === second.route &&
    first.modeCodexCount === second.modeCodexCount &&
    first.homeComposerRootCount === second.homeComposerRootCount &&
    first.composerCount === second.composerCount &&
    first.composerText === second.composerText &&
    first.composerPlainText === second.composerPlainText &&
    first.workspaceProjectTargetCount === second.workspaceProjectTargetCount &&
    sameBoundedTexts(
      first.workspaceProjectTargetNames,
      second.workspaceProjectTargetNames
    ) &&
    sameBoundedTexts(
      first.workspaceProjectTargetTexts,
      second.workspaceProjectTargetTexts
    ) &&
    first.forbiddenWorktreeCount === second.forbiddenWorktreeCount &&
    first.runLocationCount === second.runLocationCount &&
    sameBoundedTexts(first.runLocationNames, second.runLocationNames) &&
    sameBoundedTexts(first.runLocationTexts, second.runLocationTexts) &&
    first.footerCount === second.footerCount &&
    first.footerText === second.footerText &&
    sameBoundedTexts(first.footerTexts, second.footerTexts) &&
    first.signInCount === second.signInCount &&
    first.dialogCount === second.dialogCount &&
    first.turnCount === second.turnCount &&
    first.generationCount === second.generationCount &&
    first.queueCount === second.queueCount &&
    first.attachmentCount === second.attachmentCount &&
    first.sendButtonCount === second.sendButtonCount &&
    first.sendButtonEnabled === second.sendButtonEnabled
  );
}

function hasFreshIdentity(
  observation: CodexElectronDOMObservation,
  workspaceBasename: string
): boolean {
  const exactWorkspaceName = `Change project: ${workspaceBasename}`;
  const hasExactWorkspaceProject =
    observation.workspaceProjectTargetCount === 1 &&
    observation.workspaceProjectTargetNames.length === 1 &&
    observation.workspaceProjectTargetNames[0] === exactWorkspaceName &&
    observation.workspaceProjectTargetTexts.length === 1 &&
    observation.workspaceProjectTargetTexts[0] === workspaceBasename;
  const hasVerifiedRunLocation =
    observation.runLocationCount === 0 ||
    (observation.runLocationCount === 1 &&
      observation.runLocationNames.length === 1 &&
      observation.runLocationNames[0] === 'Select where to run the chat' &&
      observation.runLocationTexts.length === 1 &&
      /(?:^|[^A-Za-z])Local(?:$|[^A-Za-z])/.test(
        observation.runLocationTexts[0] ?? ''
      ) &&
      !/(?:^|[^a-z])(remote|cloud|worktree)(?:$|[^a-z])/i.test(
        observation.runLocationTexts[0] ?? ''
      ));
  return (
    observation.route === 'app://-/index.html' &&
    observation.modeCodexCount === 1 &&
    observation.homeComposerRootCount === 1 &&
    observation.composerCount === 1 &&
    hasExactWorkspaceProject &&
    observation.forbiddenWorktreeCount === 0 &&
    hasVerifiedRunLocation &&
    observation.signInCount === 0 &&
    observation.dialogCount === 0 &&
    observation.turnCount === 0 &&
    observation.generationCount === 0 &&
    observation.queueCount === 0 &&
    observation.attachmentCount === 0
  );
}

function freshWorkspaceDiagnostic(
  observation: CodexElectronDOMObservation,
  workspaceBasename: string
): CodexFreshWorkspaceDiagnostic {
  return {
    routeReady: observation.route === 'app://-/index.html',
    modeCodexCount: observation.modeCodexCount,
    homeComposerRootCount: observation.homeComposerRootCount,
    composerCount: observation.composerCount,
    composerPlainText: observation.composerPlainText,
    composerEmpty: observation.composerText === '',
    workspaceProjectTargetCount: observation.workspaceProjectTargetCount,
    workspaceNameMatches:
      observation.workspaceProjectTargetNames.length === 1 &&
      observation.workspaceProjectTargetNames[0] ===
        `Change project: ${workspaceBasename}`,
    workspaceTextMatches:
      observation.workspaceProjectTargetTexts.length === 1 &&
      observation.workspaceProjectTargetTexts[0] === workspaceBasename,
    forbiddenWorktreeCount: observation.forbiddenWorktreeCount,
    runLocationCount: observation.runLocationCount,
    localRunLocation:
      observation.runLocationCount === 0 ||
      (observation.runLocationNames.length === 1 &&
        observation.runLocationNames[0] === 'Select where to run the chat' &&
        observation.runLocationTexts.length === 1 &&
        /(?:^|[^A-Za-z])Local(?:$|[^A-Za-z])/.test(
          observation.runLocationTexts[0] ?? ''
        ) &&
        !/(?:^|[^a-z])(remote|cloud|worktree)(?:$|[^a-z])/i.test(
          observation.runLocationTexts[0] ?? ''
        )),
    signInCount: observation.signInCount,
    dialogCount: observation.dialogCount,
    turnCount: observation.turnCount,
    generationCount: observation.generationCount,
    queueCount: observation.queueCount,
    attachmentCount: observation.attachmentCount,
  };
}

function controlError(
  error: unknown,
  message: string
): CodexElectronControlError {
  return error instanceof CodexElectronControlError
    ? error
    : new CodexElectronControlError(message);
}

async function delay(ms: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, ms));
}

/** No launch, auth, model, scoring, native input, retry, or quit API. */
export function createCodexElectronControl(
  options: CodexElectronControlOptions
): CodexElectronControl {
  const { session, attemptId, beforeSubmit } = options;
  if (
    !session ||
    typeof session.readDOM !== 'function' ||
    typeof session.runOnce !== 'function' ||
    !session.application ||
    typeof attemptId !== 'string' ||
    !/^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/.test(attemptId) ||
    typeof beforeSubmit !== 'function'
  )
    throw new TypeError(
      'An owned Electron session, attempt ID, and durable beforeSubmit callback are required'
    );

  const initialProof = session.windowProof;
  const pid = initialProof.pid;
  const browserWindowId = initialProof.browserWindowId;
  const webContentsId = initialProof.webContentsId;
  const ownedWorkspace = session.workspacePath;
  const workspaceBasename = basename(ownedWorkspace);
  if (
    !Number.isSafeInteger(pid) ||
    pid <= 0 ||
    !Number.isSafeInteger(browserWindowId) ||
    browserWindowId <= 0 ||
    !Number.isSafeInteger(webContentsId) ||
    webContentsId <= 0 ||
    !initialProof.owned ||
    initialProof.destroyed ||
    initialProof.webContentsDestroyed ||
    session.native?.pid !== pid ||
    session.native?.workspacePath !== ownedWorkspace ||
    session.workspaceOwnership?.kind !== 'codex-electron-workspace' ||
    session.workspaceOwnership.version !== 1 ||
    session.workspaceOwnership.path !== ownedWorkspace ||
    !/^[a-f0-9-]{36}$/.test(session.workspaceOwnership.id) ||
    !isAbsolute(session.workspaceOwnership.markerPath) ||
    session.workspaceOwnership.markerPath !== `${ownedWorkspace}/.owner.json` ||
    !Number.isSafeInteger(session.workspaceOwnership.uid) ||
    session.workspaceOwnership.uid < 0 ||
    !isAbsolute(ownedWorkspace) ||
    normalize(ownedWorkspace) !== ownedWorkspace ||
    workspaceBasename.length < 12 ||
    workspaceBasename.length > 255 ||
    !/^[A-Za-z0-9._-]+$/.test(workspaceBasename)
  )
    throw new TypeError(
      'A canonical owned fresh workspace and live window identity are required'
    );

  let openAttempted = false;
  let workspaceOpen = false;
  let fillAttempted = false;
  let prompt: string | undefined;
  let submitAttempted = false;

  function requireCurrentProof(): void {
    const proof = session.windowProof;
    if (
      proof.pid !== pid ||
      proof.browserWindowId !== browserWindowId ||
      proof.webContentsId !== webContentsId ||
      !proof.owned ||
      proof.destroyed ||
      proof.webContentsDestroyed ||
      proof.readyRoute !== true ||
      proof.appContents !== true
    )
      throw new CodexElectronControlError(
        'Owned Codex window identity changed'
      );
  }

  async function observe(): Promise<CodexElectronObservation> {
    requireCurrentProof();
    const dom = await session.readDOM(readCodexDOM);
    requireCurrentProof();
    return Object.freeze({
      pid,
      browserWindowId,
      webContentsId,
      ...dom,
    });
  }

  function requireFresh(observation: CodexElectronDOMObservation): void {
    if (
      !hasFreshIdentity(observation, workspaceBasename) ||
      !observation.composerPlainText
    )
      throw new CodexElectronControlError(
        'Codex home composer freshness guard failed'
      );
  }

  function requireExactPrompt(observation: CodexElectronDOMObservation): void {
    requireFresh(observation);
    if (
      prompt === undefined ||
      !observation.composerPlainText ||
      observation.composerText !== prompt
    )
      throw new CodexElectronControlError(
        'Full prompt DOM readback did not match'
      );
  }

  return {
    observe,
    async openFreshWorkspace(path) {
      if (workspaceOpen)
        throw new CodexElectronControlError('Workspace is already open');
      if (openAttempted)
        throw new CodexElectronControlError(
          'Workspace open was already attempted'
        );
      if (
        path !== ownedWorkspace ||
        !isAbsolute(path) ||
        normalize(path) !== path ||
        path.includes('\0')
      )
        throw new CodexElectronControlError(
          'Workspace must exactly match the owned session'
        );
      openAttempted = true;
      const url = new URL('codex://new');
      url.searchParams.set('path', path);
      let acknowledgement: ElectronOpenUrlResult;
      try {
        acknowledgement = await session.runOnce(async () =>
          session.application.evaluate(
            (
              { app }: { app: ElectronOpenUrlApp },
              href: string
            ): ElectronOpenUrlResult => {
              let prevented = false;
              const handled = app.emit(
                'open-url',
                {
                  preventDefault() {
                    prevented = true;
                  },
                },
                href
              );
              return { handled, prevented };
            },
            url.href
          )
        );
      } catch (error) {
        throw controlError(error, 'Codex workspace deep link failed');
      }
      if (!acknowledgement.handled || !acknowledgement.prevented)
        throw new CodexElectronControlError(
          'Codex workspace deep link was not acknowledged'
        );
      let first: CodexElectronObservation;
      const freshDeadline = Date.now() + FRESH_WORKSPACE_TIMEOUT_MS;
      for (;;) {
        first = await observe();
        options.onFreshWorkspaceObservation?.(
          freshWorkspaceDiagnostic(first, workspaceBasename)
        );
        if (
          hasFreshIdentity(first, workspaceBasename) &&
          first.composerPlainText
        )
          break;
        if (Date.now() >= freshDeadline)
          throw new CodexElectronControlError(
            'Codex fresh workspace did not become ready within its bound'
          );
        await delay(
          Math.min(FRESH_WORKSPACE_POLL_MS, freshDeadline - Date.now())
        );
      }
      await delay(FRESH_WORKSPACE_POLL_MS);
      const second = await observe();
      if (!sameDOM(first, second))
        throw new CodexElectronControlError(
          'Codex home composer is not fresh and stable'
        );
      workspaceOpen = true;
    },
    async replacePrompt(text) {
      if (!workspaceOpen)
        throw new CodexElectronControlError('Fresh workspace is not open');
      if (fillAttempted)
        throw new CodexElectronControlError(
          'Prompt fill was already attempted'
        );
      if (
        typeof text !== 'string' ||
        text.length === 0 ||
        !text.trim() ||
        Buffer.byteLength(text, 'utf8') > 16 * 1024 * 1024
      )
        throw new CodexElectronControlError(
          'A nonempty prompt within the fill limit is required'
        );
      if (text.includes('\r'))
        throw new CodexElectronControlError('Prompt must use LF line endings');
      fillAttempted = true;
      const before = await observe();
      requireFresh(before);
      try {
        await session.runOnce(async (page: Page) => {
          await page
            .locator(HOME_COMPOSER_SELECTOR)
            .locator(COMPOSER_SELECTOR)
            .fill(text);
        });
      } catch (error) {
        throw controlError(error, 'Playwright prompt fill failed');
      }
      const after = await observe();
      if (!hasFreshIdentity(after, workspaceBasename))
        throw new CodexElectronControlError(
          'Codex home composer freshness guard failed'
        );
      if (!after.composerPlainText || after.composerText !== text)
        throw new CodexElectronControlError(
          'Full prompt DOM readback did not match'
        );
      prompt = text;
    },
    async submitOnce() {
      if (submitAttempted)
        throw new CodexElectronControlError('Submit was already attempted');
      submitAttempted = true;
      if (!workspaceOpen || prompt === undefined)
        throw new CodexElectronControlError(
          'An exact prompt must be staged before submit'
        );
      const beforeReceipt = await observe();
      requireExactPrompt(beforeReceipt);
      if (
        beforeReceipt.sendButtonCount !== 1 ||
        !beforeReceipt.sendButtonEnabled
      )
        throw new CodexElectronControlError(
          'Exactly one enabled Send button is required'
        );
      try {
        await beforeSubmit({
          attemptId,
          pid,
          browserWindowId,
          webContentsId,
          workspace: ownedWorkspace,
          fullPromptSha256: createHash('sha256').update(prompt).digest('hex'),
          inputMode: 'playwright-fill',
          readback: 'exact',
        });
      } catch {
        throw new CodexElectronControlError(
          'Durable beforeSubmit receipt failed',
          true
        );
      }
      const beforeClick = await observe();
      requireExactPrompt(beforeClick);
      if (beforeClick.sendButtonCount !== 1 || !beforeClick.sendButtonEnabled)
        throw new CodexElectronControlError(
          'Exactly one enabled Send button is required'
        );
      try {
        await session.runOnce(async (page: Page) => {
          await page
            .locator(HOME_COMPOSER_SELECTOR)
            .getByRole('button', { name: 'Send', exact: true })
            .click();
        });
        return { status: 'acknowledged' };
      } catch {
        return {
          status: 'uncertain',
          error: new CodexElectronControlError(
            'Submit acknowledgement is uncertain; do not retry',
            true
          ),
        };
      }
    },
  };
}
