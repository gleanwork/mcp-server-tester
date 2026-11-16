/**
 * Bounded ChatGPT setup and submission over AT-SPI. MST owns the app and the
 * draft hand-off.
 *
 * No inference API, shell, arbitrary keyboard input, answer extraction, or
 * action retry. A receipt never carries query text or accessible names. The
 * draft is opened by one request to the MST parent (the `--open-fd` channel);
 * MST performs the codex://new deep-link hand-off and replies with a fixed
 * receipt.
 */
import { createHash } from 'node:crypto';
import { AtspiError } from '../linuxAtspiBus.js';
import { hasLoneSurrogate } from '../urlComponent.js';
import {
  LINUX_CHATGPT_ERROR_CODES,
  type LinuxChatgptErrorCode,
} from './linuxContract.js';

export class DriverFailure extends Error {}

export type ChatgptSurface = 'chatgpt-work' | 'codex';

const SURFACES: Record<ChatgptSurface, string> = {
  'chatgpt-work': 'ChatGPT Work',
  codex: 'Codex',
};
const MODE_LABELS: Record<ChatgptSurface, string> = {
  'chatgpt-work': `Switch mode, current mode: ${SURFACES['chatgpt-work']}`,
  codex: `Switch mode, current mode: ${SURFACES.codex}`,
};
const ALL_MODE_LABELS = Object.values(MODE_LABELS);
const MENU_LABELS: Record<ChatgptSurface, string> = {
  'chatgpt-work': 'ChatGPT Work Create, learn, and explore',
  codex: 'Codex Build, debug, and ship',
};
const BUTTONS = ['button', 'push button'];
export const INPUT_LIMIT = 2 * 1024 * 1024;
/**
 * After the one deep-link hand-off the draft usually appears in 1-3 s, but
 * live runs rarely exceeded 10 s. Waiting is read-only; the hand-off is never
 * repeated.
 */
export const DRAFT_POLLS = 300;
/**
 * Read-only settle before a later submission (2 seconds). The previous
 * conversation view never shows the new-chat surface, so this is not a gate.
 */
export const IDLE_POLLS = 20;
/**
 * The app routes each deep link asynchronously and does not order them. If
 * the setup route lands after the first submission's route, it replaces that
 * draft with an empty new chat. Setup observes read-only for 5 seconds after
 * its hand-off so that its route lands first. Nothing is repeated.
 */
export const SETUP_SETTLE_POLLS = 50;
/**
 * A fresh profile can open a model announcement ("Introducing ...") over the
 * main window right after the first-run screens. It is modal: while it is
 * open the window's other controls, the mode switch among them, leave the
 * AT-SPI tree. Its keep-the-model button is the only one MST presses; it
 * never picks the announced model.
 */
const ANNOUNCEMENT_KEEP = 'Continue with current model';
const PROFESSION_ROLES = ['radio button', 'toggle button'];

/** One node of a snapshot. `ancestors` are indices into the same snapshot. */
export interface ChatgptNode {
  ancestors: readonly number[];
  name: string;
  role: string;
  showing: boolean;
  visible: boolean;
  enabled: boolean;
  sensitive: boolean;
  /** An editor role with the EDITABLE state and the Text interface. */
  editable: boolean;
  editableState: boolean;
  editableInterface: boolean;
  textInterface: boolean;
  selected: boolean;
}

/** The native desktop the driver reads and acts on. Every call is bounded. */
export interface ChatgptLinuxDesktop<N extends ChatgptNode = ChatgptNode> {
  /** Fails before any UI action when MST's hand-off channel is missing. */
  requireHelpers(): void;
  /** One complete snapshot of the single ChatGPT app, or [] while it has none. */
  snapshot(): Promise<N[]>;
  /** The one action of `control` whose name is in `allowed`. Never retried. */
  activate(control: N, allowed: readonly string[]): Promise<void>;
  /** The composer's exact text, at most `limit` UTF-8 bytes. Never exported. */
  text(control: N, limit?: number): Promise<string>;
  /** One request to MST to open a draft holding `prompt`. Once per process. */
  openPrompt(prompt: string): Promise<void>;
  /** One real mouse click on the profession choice, at its live geometry. */
  selectProfession(nodes: readonly N[], choice: N): Promise<void>;
}

export interface DriverClock {
  now(): number;
  sleep(ms: number): Promise<void>;
}

const REAL_CLOCK: DriverClock = {
  now: () => performance.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, Math.max(0, ms))),
};

export function available(node: ChatgptNode, enabled = true): boolean {
  return (
    node.showing &&
    node.visible &&
    (!enabled || (node.enabled && node.sensitive))
  );
}

function controls<N extends ChatgptNode>(
  nodes: readonly N[],
  names: readonly string[],
  roles: readonly string[] = BUTTONS,
  enabled = true
): N[] {
  return nodes.filter(
    (node) =>
      available(node, enabled) &&
      roles.includes(node.role) &&
      names.includes(node.name)
  );
}

export function unique<T>(items: readonly T[], code: string): T {
  if (items.length !== 1) throw new DriverFailure(code);
  return items[0]!;
}

/**
 * Chromium exposes an editable entry and editable paragraphs inside it.
 * Select the containing editor by live ancestry, not role priority or order.
 */
function editorRoots<N extends ChatgptNode>(nodes: readonly N[]): N[] {
  const eligible = new Set<number>();
  nodes.forEach((node, index) => {
    if (available(node) && node.editable) eligible.add(index);
  });
  return nodes.filter(
    (node, index) =>
      eligible.has(index) &&
      !node.ancestors.some((parent) => eligible.has(parent))
  );
}

/** Separate editors (including dialogs) stay ambiguous and cannot authorize input. */
export function composer<N extends ChatgptNode>(nodes: readonly N[]): N {
  return unique(editorRoots(nodes), 'composer_missing_or_ambiguous');
}

/**
 * The composer shows `code` as a code span, so AT-SPI text omits its two
 * backticks. Match exactly that rendering: single backticks, not part of a
 * longer run, around text without backticks or newlines.
 */
const INLINE_CODE = /(?<!`)`([^`\n]+)`(?!`)/g;

/**
 * The same bounded representation as native exact-prompt correlation. Never
 * trims the text or alters the prompt handed to MST for the deep link. The
 * sent message is still correlated with the exact prompt from the native
 * transcript.
 */
export function matchesPrompt(text: string, prompt: string): boolean {
  const candidates = new Set([prompt, prompt.replace(INLINE_CODE, '$1')]);
  return [...candidates].some(
    (value) => text === value || text === `${value}\n`
  );
}

function sha256(text: string): Buffer {
  return createHash('sha256').update(text, 'utf8').digest();
}

function isErrorCode(code: string): code is LinuxChatgptErrorCode {
  return (LINUX_CHATGPT_ERROR_CODES as readonly string[]).includes(code);
}

/** A receipt's error: only contract codes, never native or private detail. */
export function errorCode(error: unknown): LinuxChatgptErrorCode {
  const code =
    error instanceof DriverFailure
      ? error.message
      : error instanceof AtspiError
        ? error.code
        : undefined;
  return code !== undefined && isErrorCode(code)
    ? code
    : 'desktop_driver_failed';
}

function codeOf(error: unknown): string | undefined {
  return error instanceof DriverFailure
    ? error.message
    : error instanceof AtspiError
      ? error.code
      : undefined;
}

/** Transient while the draft's accessibility tree changes; only predicate reads may tolerate them. */
const TRANSIENT_READS = new Set([
  'composer_missing_or_ambiguous',
  'send_missing_or_ambiguous',
  'composer_text_unavailable',
]);
const SURFACE_OVERLAP = new Set([
  'composer_missing_or_ambiguous',
  'send_missing_or_ambiguous',
]);

export interface DraftState {
  observedSurface: ChatgptSurface | 'unknown' | 'ambiguous';
  composerRootCount: number;
  sendControlCount: number;
  textReadable: boolean;
  textLength?: number;
  textSha256?: string;
  embeddedObjectCount?: number;
  newlineCount?: number;
}

export interface ChatgptReceipt {
  status: 'ready' | 'submitted' | 'failed';
  action_count: number;
  duration_ms: number;
  surface?: ChatgptSurface;
  phase?: string;
  step?: string;
  draftState?: DraftState;
  error?: LinuxChatgptErrorCode;
}

function isSurface(value: unknown): value is ChatgptSurface {
  return value === 'chatgpt-work' || value === 'codex';
}

type Predicate<N> = (nodes: N[]) => Promise<boolean> | boolean;

export interface DriverOptions {
  clock?: DriverClock;
  /** Read-only polls after setup's hand-off; tests set 0 to model a late route. */
  setupSettlePolls?: number;
}

export class ChatgptDriver<N extends ChatgptNode = ChatgptNode> {
  readonly started: number;
  readonly deadline: number;
  actions = 0;
  phase: string | undefined;
  step: string | undefined;
  lastSnapshot: N[] | undefined;
  readonly clock: DriverClock;
  private readonly setupSettlePolls: number;

  constructor(
    readonly desktop: ChatgptLinuxDesktop<N>,
    timeoutMs: number,
    readonly maxActions: number,
    options: DriverOptions = {}
  ) {
    this.clock = options.clock ?? REAL_CLOCK;
    this.setupSettlePolls = options.setupSettlePolls ?? SETUP_SETTLE_POLLS;
    this.started = this.clock.now();
    this.deadline = this.started + timeoutMs;
  }

  check(): void {
    if (this.clock.now() >= this.deadline)
      throw new DriverFailure('deadline_exceeded');
  }

  async action(operation: () => Promise<void>): Promise<void> {
    this.check();
    if (this.actions >= this.maxActions)
      throw new DriverFailure('action_budget_exhausted');
    this.actions += 1;
    await operation();
  }

  async click(
    node: N,
    allowed: readonly string[] = ['click', 'press']
  ): Promise<void> {
    await this.action(() => this.desktop.activate(node, allowed));
  }

  async snapshot(): Promise<N[]> {
    this.check();
    const nodes = await this.desktop.snapshot();
    this.lastSnapshot = nodes;
    this.check();
    return nodes;
  }

  /**
   * Polls only: an acknowledged action that does not change state is NOT
   * retried. The cold-app wait gets 30 seconds; all waits share the overall
   * deadline.
   */
  async wait(predicate: Predicate<N>, polls = 100): Promise<N[]> {
    const waitDeadline = Math.min(
      this.deadline,
      this.clock.now() + polls * 100
    );
    let ambiguity: DriverFailure | undefined;
    for (let poll = 0; poll < polls; poll++) {
      let nodes: N[];
      try {
        nodes = await this.snapshot();
      } catch (error) {
        if (codeOf(error) === 'deadline_exceeded' && ambiguity) throw ambiguity;
        throw error;
      }
      if (this.clock.now() >= waitDeadline) break;
      let matched: boolean;
      try {
        matched = await predicate(nodes);
      } catch (error) {
        // Only predicate reads may tolerate transient editor/Send overlap or
        // text RPC failures while the draft's accessibility tree changes.
        // Snapshot failures and every action stay fail-closed, with no retry.
        const code = codeOf(error);
        if (code === undefined || !TRANSIENT_READS.has(code)) throw error;
        ambiguity ??= new DriverFailure(code);
        await this.clock.sleep(
          Math.min(100, Math.max(0, waitDeadline - this.clock.now()))
        );
        continue;
      }
      ambiguity = undefined;
      if (matched) return nodes;
      await this.clock.sleep(
        Math.min(100, Math.max(0, waitDeadline - this.clock.now()))
      );
    }
    if (ambiguity) throw ambiguity;
    throw new DriverFailure('state_transition_unobserved');
  }

  /**
   * Read-only observation for a fixed time. It never acts, matches, or
   * retries, and it shares the overall deadline.
   */
  async settle(polls: number): Promise<void> {
    const settleDeadline = this.clock.now() + polls * 100;
    for (let poll = 0; poll < polls; poll++) {
      await this.snapshot();
      const remaining = settleDeadline - this.clock.now();
      if (remaining <= 0) break;
      await this.clock.sleep(Math.min(100, remaining));
    }
  }

  /**
   * In-memory SHA-256 of the unique composer's text, or undefined. Read-only;
   * it is never exported and it cannot authorize an action.
   */
  async composerDigest(nodes: N[]): Promise<Buffer | undefined> {
    try {
      const roots = editorRoots(nodes);
      if (roots.length !== 1) return undefined;
      const text = await this.desktop.text(roots[0]!);
      return typeof text === 'string' ? sha256(text) : undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * True only if the last snapshot is a ready surface whose composer text is
   * still exactly the text from before the hand-off (for example, only the
   * empty-chat placeholder). Diagnosis only: nothing is reopened or retried.
   */
  async promptNotApplied(baseline: Buffer | undefined): Promise<boolean> {
    const nodes = this.lastSnapshot;
    if (!baseline || !nodes) return false;
    try {
      if (!this.readyAny(nodes)) return false;
    } catch {
      return false;
    }
    const digest = await this.composerDigest(nodes);
    return digest !== undefined && digest.equals(baseline);
  }

  selected(nodes: readonly N[], surface: ChatgptSurface): boolean {
    const switches = controls(nodes, ALL_MODE_LABELS);
    return switches.length === 1 && switches[0]!.name === MODE_LABELS[surface];
  }

  async selectSurface(nodes: N[], surface: ChatgptSurface): Promise<N[]> {
    if (this.selected(nodes, surface)) return nodes;
    const toggle = unique(
      controls(nodes, ALL_MODE_LABELS),
      'mode_missing_or_ambiguous'
    );
    await this.click(toggle, ['open']);
    const menu = await this.wait(
      (ns) => controls(ns, [MENU_LABELS[surface]], ['menu item']).length > 0
    );
    const item = unique(
      controls(menu, [MENU_LABELS[surface]], ['menu item']),
      'surface_item_ambiguous'
    );
    await this.click(item, ['select']);
    return this.wait((ns) => this.selected(ns, surface));
  }

  /** Only in a snapshot already taken, so it adds no polls; one click, never retried. */
  async dismissAnnouncement(nodes: N[]): Promise<N[]> {
    const keep = controls(nodes, [ANNOUNCEMENT_KEEP]);
    if (!keep.length) return nodes;
    await this.click(unique(keep, 'announcement_ambiguous'));
    return this.wait(
      (ns) =>
        !controls(ns, [ANNOUNCEMENT_KEEP]).length &&
        controls(ns, ALL_MODE_LABELS).length > 0
    );
  }

  ready(nodes: readonly N[], surface: ChatgptSurface): boolean {
    if (!this.selected(nodes, surface)) return false;
    const editors = editorRoots(nodes);
    const sends = controls(nodes, ['Send'], BUTTONS, false);
    if (!editors.length || !sends.length) return false;
    unique(editors, 'composer_missing_or_ambiguous');
    unique(sends, 'send_missing_or_ambiguous');
    return true;
  }

  /** Python's `any(...)`: stops at the first surface that is ready. */
  readyAny(nodes: readonly N[]): boolean {
    return (Object.keys(SURFACES) as ChatgptSurface[]).some((candidate) =>
      this.ready(nodes, candidate)
    );
  }

  async prepare(surface: unknown): Promise<ChatgptReceipt> {
    if (!isSurface(surface)) throw new DriverFailure('invalid_surface');
    this.desktop.requireHelpers();
    this.phase = 'waiting-for-initial-ui';
    const firstScreens = [
      'Leave a note on my Desktop',
      'Go to ChatGPT',
      ANNOUNCEMENT_KEEP,
      ...ALL_MODE_LABELS,
    ];
    let nodes = await this.wait(
      (ns) =>
        controls(ns, ['Engineering'], PROFESSION_ROLES).length > 0 ||
        controls(ns, firstScreens).length > 0,
      300
    );
    const engineering = controls(nodes, ['Engineering'], PROFESSION_ROLES);
    if (engineering.length) {
      this.phase = 'profession-selected';
      const choice = unique(engineering, 'profession_ambiguous');
      if (!choice.selected) {
        const observed = nodes;
        await this.action(() =>
          this.desktop.selectProfession(observed, choice)
        );
      }
      // Chromium can keep the checked bit stale after a real selection.
      // Observe the same profession page and enabled Continue, not that bit.
      this.phase = 'continue-ready';
      nodes = await this.wait(
        (ns) =>
          controls(ns, ['Engineering'], PROFESSION_ROLES).length === 1 &&
          controls(ns, ['Continue']).length > 0
      );
      await this.click(
        unique(controls(nodes, ['Continue']), 'continue_missing_or_ambiguous')
      );
      this.phase = 'intro-dismiss';
      nodes = await this.wait(
        (ns) =>
          !controls(ns, ['Engineering'], PROFESSION_ROLES).length &&
          controls(ns, firstScreens).length > 0
      );
    }
    this.phase = 'intro-dismiss';
    // Only skip the observed, specific product-introduction screen.
    if (
      controls(nodes, ['Leave a note on my Desktop']).length &&
      controls(nodes, ['Turn this spreadsheet into a chart']).length
    ) {
      await this.click(
        unique(controls(nodes, ['Skip']), 'skip_missing_or_ambiguous')
      );
      nodes = await this.wait(
        (ns) => controls(ns, ['Go to ChatGPT']).length > 0
      );
    }
    if (
      controls(nodes, ['Go to ChatGPT']).length &&
      controls(nodes, ['Keep setting up']).length
    ) {
      await this.click(
        unique(
          controls(nodes, ['Go to ChatGPT']),
          'intro_confirmation_ambiguous'
        )
      );
      nodes = await this.wait(
        (ns) => controls(ns, [ANNOUNCEMENT_KEEP, ...ALL_MODE_LABELS]).length > 0
      );
    }
    this.phase = 'announcement';
    nodes = await this.dismissAnnouncement(nodes);
    this.phase = 'surface';
    await this.selectSurface(nodes, surface);
    this.phase = 'composer';
    await this.wait((ns) => this.ready(ns, surface));
    this.step = 'draft-open';
    await this.action(() => this.desktop.openPrompt(''));
    this.step = 'draft-surface';
    // The pre-hand-off UI is already ready, so readiness cannot show that the
    // setup route landed. Wait read-only so it cannot replace the first draft.
    await this.settle(this.setupSettlePolls);
    // Setup has no user prompt to match. A new chat can expose a visible
    // placeholder as Text; ready means controls and surface, not verified
    // emptiness.
    nodes = await this.wait(
      (ns) => this.readyAny(ns) || controls(ns, [ANNOUNCEMENT_KEEP]).length > 0,
      DRAFT_POLLS
    );
    // The announcement can open late, over the draft: the settle has seen it by now.
    nodes = await this.dismissAnnouncement(nodes);
    await this.selectSurface(nodes, surface);
    this.step = 'draft-readback';
    await this.wait((ns) => this.ready(ns, surface));
    this.step = undefined;
    return this.receipt('ready', surface);
  }

  async submit(prompt: unknown, surface: unknown): Promise<ChatgptReceipt> {
    if (typeof prompt !== 'string' || !prompt.trim())
      throw new DriverFailure('invalid_prompt');
    if (!isSurface(surface)) throw new DriverFailure('invalid_surface');
    this.desktop.requireHelpers();
    // Setup ran once for the batch. A visible switch in another mode blocks
    // submission. After a previous turn the app stays on that conversation,
    // which has no mode switch. The case deep link opens a new chat; the
    // draft checks below verify the surface and exact prompt before the one
    // send. Nothing is sent here.
    this.phase = 'surface';
    let nodes = await this.snapshot();
    if (
      controls(nodes, ALL_MODE_LABELS).length &&
      !this.selected(nodes, surface)
    )
      throw new DriverFailure('surface_mismatch');
    let initialReady: boolean;
    try {
      initialReady = this.ready(nodes, surface);
    } catch (error) {
      if (!SURFACE_OVERLAP.has(codeOf(error) ?? '')) throw error;
      // The first snapshot can straddle a renderer transition too. Give it
      // the same read-only settle; persistent ambiguity blocks actions.
      nodes = await this.wait((ns) => this.ready(ns, surface), IDLE_POLLS);
      initialReady = true;
    }
    if (!initialReady) {
      // Brief read-only settle only; a conversation view never becomes ready.
      try {
        nodes = await this.wait((ns) => this.ready(ns, surface), IDLE_POLLS);
      } catch (error) {
        const code = codeOf(error) ?? '';
        if (
          code !== 'state_transition_unobserved' &&
          !SURFACE_OVERLAP.has(code)
        )
          throw error;
        nodes = this.lastSnapshot ?? nodes;
      }
      if (
        controls(nodes, ALL_MODE_LABELS).length &&
        !this.selected(nodes, surface)
      )
        throw new DriverFailure('surface_mismatch');
    }
    this.phase = 'composer';
    const baseline = await this.composerDigest(nodes);
    this.step = 'draft-open';
    await this.action(() => this.desktop.openPrompt(prompt));
    this.step = 'draft-surface';
    try {
      nodes = await this.wait(
        async (ns) =>
          this.readyAny(ns) &&
          matchesPrompt(await this.desktop.text(composer(ns)), prompt),
        DRAFT_POLLS
      );
    } catch (error) {
      // Same fail-closed outcome; a more specific code when the app never
      // applied the prompt. No reopen, refill, or typing.
      if (
        codeOf(error) === 'state_transition_unobserved' &&
        (await this.promptNotApplied(baseline))
      )
        throw new DriverFailure('draft_prompt_not_applied');
      throw error;
    }
    // A deep link may change mode. One fixed UI selection is allowed, but it
    // must preserve the draft. Never reopen, refill, or fall back on loss.
    await this.selectSurface(nodes, surface);
    this.step = 'draft-readback';
    nodes = await this.wait(
      async (ns) =>
        this.ready(ns, surface) &&
        matchesPrompt(await this.desktop.text(composer(ns)), prompt) &&
        controls(ns, ['Send']).length === 1
    );
    // Exactly one send. No retry, Enter fallback, or resubmission on a missing transcript.
    this.step = 'send';
    await this.click(
      unique(controls(nodes, ['Send']), 'send_missing_or_ambiguous')
    );
    this.step = undefined;
    return this.receipt('submitted', surface);
  }

  /**
   * Failure-only, read-only evidence from the last complete snapshot. Never
   * serializes nodes, names, URLs, prompt or config values, or error detail.
   */
  async draftState(): Promise<DraftState | undefined> {
    const nodes = this.lastSnapshot;
    if (!nodes) return undefined;
    const roots = editorRoots(nodes);
    const switches = controls(nodes, ALL_MODE_LABELS);
    let observed: DraftState['observedSurface'] = 'unknown';
    if (switches.length > 1) observed = 'ambiguous';
    else if (switches.length === 1)
      observed =
        (Object.keys(MODE_LABELS) as ChatgptSurface[]).find(
          (surface) => MODE_LABELS[surface] === switches[0]!.name
        ) ?? 'unknown';
    const state: DraftState = {
      observedSurface: observed,
      composerRootCount: roots.length,
      sendControlCount: controls(nodes, ['Send'], BUTTONS, false).length,
      textReadable: false,
    };
    if (roots.length !== 1) return state;
    try {
      const text = await this.desktop.text(roots[0]!, INPUT_LIMIT);
      if (typeof text !== 'string') return state;
      const points = [...text];
      if (points.length > INPUT_LIMIT) return state;
      if (hasLoneSurrogate(text)) return state;
      const encoded = Buffer.from(text, 'utf8');
      if (encoded.length > INPUT_LIMIT) return state;
      // Length and counts are Unicode code points; the hash is exact UTF-8 bytes.
      return {
        ...state,
        textReadable: true,
        textLength: points.length,
        textSha256: createHash('sha256').update(encoded).digest('hex'),
        embeddedObjectCount: points.filter((char) => char === '\ufffc').length,
        newlineCount: points.filter((char) => char === '\n').length,
      };
    } catch {
      // Diagnostics must not replace the original failure or expose its text.
      return state;
    }
  }

  async receipt(
    status: ChatgptReceipt['status'],
    surface?: ChatgptSurface
  ): Promise<ChatgptReceipt> {
    const draftState =
      status === 'failed' ? await this.draftState() : undefined;
    return {
      status,
      action_count: this.actions,
      duration_ms: Math.max(0, this.clock.now() - this.started),
      ...(surface ? { surface } : {}),
      ...(status === 'failed' && this.phase ? { phase: this.phase } : {}),
      ...(status === 'failed' && this.step ? { step: this.step } : {}),
      ...(draftState ? { draftState } : {}),
    };
  }
}
