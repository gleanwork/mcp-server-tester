/**
 * The managed (third-party, gateway) Linux Cowork driver: bounded semantic UI
 * actions over the native AT-SPI seam. No lifecycle, answer parsing or retry
 * of an action. Account-backed Cowork uses linuxFirstPartyDriver.ts.
 */
import {
  LinuxUiError,
  type LinuxDriverOperation,
  type LinuxDriverReceipt,
  type LinuxUi,
  type LinuxUiNode,
} from './linuxUi.js';

/** An incomplete scan cannot establish that any control is safe to act on. */
const SCAN_INCOMPLETE = new Set([
  'accessibility_tree_budget',
  'accessibility_scan_timeout',
]);
/** Reads that can fail while the accessibility tree changes. */
const TRANSIENT = new Set([
  'accessibility_dbus_error',
  'accessibility_node_defunct',
  'accessibility_invalid_reply',
  'accessibility_tree_invalid',
]);
const SCAN_ATTEMPTS = 3;

function isTransientUiRead(error: unknown): boolean {
  return error instanceof LinuxUiError && TRANSIENT.has(error.code);
}
/** Claude Desktop truncates longer new-task links; paste those prompts instead. */
const DEEP_LINK_PROMPT_CHARS = 14_336;
const PASTE_CHECK_CHARS = 200;
const PASTE_TIMEOUT_MS = 30_000;
/** Give the primary new-task link time to replace the old composer. */
const RESET_DRAFT_GRACE_MS = 5_000;
const COMPOSER = 'Write your prompt to Claude';
const TEXT_ROLES = ['static', 'text', 'label', 'paragraph', 'heading'];
const OPTION_ROLES = [
  'radio button',
  'check box',
  'checkbox',
  'toggle button',
  'button',
];
const QUESTION_PAGE = /^(\d+) of (\d+)$/i;
const NOT_OPTION =
  /^(?:Skip|Next|Back|Previous|Continue|Submit|Send|Cancel|Dismiss|Create|Allow|Accept|Connect|Approve|Stop|Show|Copy|Edit|Retry|More options|Read aloud|Restart conversation|Add |Press and hold|Progress|Working folder|Context|Start task|Deny)(?:\b|,)/i;
const ADVANCE = /^(?:Submit|Send|Next|Continue)(?: answers?)?$/i;
const CARD_ACTIONS = ['Create', 'Update', 'Schedule', 'Run', 'Delete'];

class DriverFailure extends Error {}

export interface ThirdPartyPayload {
  prompt?: unknown;
  targetModel?: unknown;
  approveWriteTools?: unknown;
  inspectReadCard?: boolean;
  /** Look for the one-time card again. Never click and never fail closed. */
  observeReadCard?: boolean;
  readOnlyApproval?: { server: string; titles: readonly string[] };
  questions?: unknown;
}

export interface ThirdPartyReceipt extends LinuxDriverReceipt {
  stopped?: true;
  question?: 'not_found';
  /** Saw a possible one-time control; no action taken. */
  readCard?: true;
  /** The diagnosis files written. */
  files?: string[];
}

/** A control's label: its name without a trailing keyboard-shortcut digit. */
function label(node: LinuxUiNode): string {
  return node.name.replace(/ [0-9]$/, '');
}

/** Both controls must belong to the same visible permission panel. Text in the
 * conversation, tool description or arguments cannot identify an approval. */
function matchesReadCard(
  nodes: readonly LinuxUiNode[],
  once: LinuxUiNode,
  read: NonNullable<ThirdPartyPayload['readOnlyApproval']>
): boolean {
  if (
    label(once) !== 'Allow once' ||
    typeof read.server !== 'string' ||
    !Array.isArray(read.titles)
  )
    return false;
  const panels = nodes.filter(
    (n) =>
      n.visible &&
      n.showing &&
      n.role === 'panel' &&
      n.name.startsWith('Permission request: ')
  );
  if (panels.length !== 1) return false;
  const panel = panels[0]!;
  const title = panel.name.slice('Permission request: '.length);
  if (!read.titles.includes(title)) return false;
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const inside = (n: LinuxUiNode) => {
    const seen = new Set<string>();
    let parent = n.parentId;
    while (parent && !seen.has(parent)) {
      if (parent === panel.id) return true;
      seen.add(parent);
      parent = byId.get(parent)?.parentId;
    }
    return false;
  };
  const headers = nodes.filter(
    (n) =>
      n.visible &&
      n.showing &&
      n.role === 'button' &&
      n.name.startsWith('Claude wants to use ') &&
      inside(n)
  );
  return (
    inside(once) &&
    headers.length === 1 &&
    headers[0]!.name === `Claude wants to use ${title} from ${read.server}`
  );
}

function normalized(text: string): string {
  return text.split(/\s+/u).filter(Boolean).join(' ');
}

interface Filter {
  enabled?: boolean;
  showing?: boolean;
  /** Also match the whole name, not only the label. */
  raw?: boolean;
}

/** Visible controls matching names and roles. */
function controls(
  nodes: readonly LinuxUiNode[],
  names: readonly string[] | ((name: string) => boolean),
  roles: readonly string[],
  { enabled = true, showing = true, raw = false }: Filter = {}
): LinuxUiNode[] {
  const test =
    typeof names === 'function'
      ? names
      : (name: string) => names.includes(name);
  return nodes.filter(
    (node) =>
      roles.includes(node.role) &&
      (test(label(node)) || (raw && test(node.name))) &&
      node.visible &&
      (!showing || node.showing) &&
      (!enabled || node.enabled)
  );
}

/** Whether the first option's label (or label and description) names this control. */
function firstOptionOwner(labels: readonly string[], name: string): boolean {
  const first = labels[0]!;
  const starts = (value: string) =>
    name === value || name.startsWith(`${value} `);
  return (
    starts(first) &&
    !labels.some((value) => value.length > first.length && starts(value))
  );
}

function questionPage(texts: readonly string[], count: number): number | null {
  const marks = new Set<string>();
  for (const text of texts) {
    const match = QUESTION_PAGE.exec(text);
    if (match) marks.add(`${Number(match[1])}/${Number(match[2])}`);
  }
  if (!marks.size) return count === 1 ? 0 : null;
  if (marks.size !== 1) return null;
  const [page, total] = [...marks][0]!.split('/').map(Number) as [
    number,
    number,
  ];
  return total === count && page >= 1 && page <= total ? page - 1 : null;
}

function validQuestions(value: unknown): value is { labels: string[] }[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every(
      (question: unknown) =>
        typeof question === 'object' &&
        question !== null &&
        'labels' in question &&
        Array.isArray(question.labels) &&
        question.labels.length > 0 &&
        question.labels.every(
          (item: unknown) => typeof item === 'string' && item.trim().length > 0
        )
    )
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}

class ThirdPartyDriver {
  readonly started = Date.now();
  actions = 0;
  /** Scans end a little before the call does, so a hitl check can still report. */
  readonly scanDeadline: number;

  constructor(
    readonly ui: LinuxUi,
    readonly deadlineAt: number,
    readonly maxActions: number
  ) {
    this.scanDeadline =
      deadlineAt - Math.min(500, (deadlineAt - this.started) / 10);
  }

  receipt(status: ThirdPartyReceipt['status']): ThirdPartyReceipt {
    return {
      status,
      action_count: this.actions,
      duration_ms: Math.max(0, Date.now() - this.started),
    };
  }

  remaining(): number {
    const ms = this.deadlineAt - Date.now();
    if (ms <= 0) throw new DriverFailure('deadline_exceeded');
    return ms;
  }

  async pause(): Promise<void> {
    await sleep(Math.min(100, this.remaining()));
  }

  async action(operation: () => Promise<void>): Promise<void> {
    this.remaining();
    if (this.actions >= this.maxActions)
      throw new DriverFailure('action_budget_exhausted');
    // Count the attempt, including one whose acknowledgement is uncertain.
    this.actions += 1;
    await operation();
  }

  /** One complete snapshot, bounded by the scan deadline. */
  async scan(): Promise<readonly LinuxUiNode[]> {
    return scanLinuxUi(this.ui, this.scanDeadline);
  }

  /**
   * A scan inside a submit wait. Running out of time there is the call's
   * deadline, not an incomplete scan to report.
   */
  async poll(): Promise<readonly LinuxUiNode[]> {
    this.remaining();
    try {
      return await this.scan();
    } catch (error) {
      if (
        error instanceof LinuxUiError &&
        error.code === 'accessibility_scan_timeout'
      )
        throw new DriverFailure('deadline_exceeded');
      throw error;
    }
  }

  async probe(): Promise<ThirdPartyReceipt> {
    const nodes = await this.scan();
    // A visible Start task proves the managed surface even while disabled.
    // A selected Cowork radio alone also exists on hosted first-party UI.
    const starts = controls(nodes, ['Start task'], ['button'], {
      enabled: false,
    });
    if (starts.length === 1) return this.receipt('ready');
    // Legacy desktops may start outside Cowork; submit selects that mode and
    // then requires Start task before inserting any prompt.
    const radios = controls(nodes, ['Cowork'], ['radio button']);
    if (!starts.length && radios.length === 1 && !radios[0]!.selected)
      return this.receipt('ready');
    if (
      !starts.length &&
      !radios.length &&
      controls(nodes, ['Cowork'], ['button']).length === 1
    )
      return this.receipt('ready');
    throw new DriverFailure('cowork_not_ready');
  }

  /** A disabled or offscreen Stop response is not evidence of an idle app. */
  stopControls(nodes: readonly LinuxUiNode[]): LinuxUiNode[] {
    return controls(nodes, ['Stop response'], ['button'], {
      enabled: false,
      showing: false,
    });
  }

  /** Stop a failed case's task before leaving it. Never sends. */
  async stopRunningTask(): Promise<boolean> {
    const stops = this.stopControls(await this.scan());
    if (!stops.length) return false;
    if (stops.length !== 1) throw new DriverFailure('stop_control_ambiguous');
    const stop = stops[0]!;
    if (!stop.enabled || !stop.showing)
      throw new DriverFailure('task_not_stopped');
    await this.action(() => this.ui.activate(stop));
    for (;;) {
      if (Date.now() >= this.scanDeadline)
        throw new DriverFailure('task_not_stopped');
      if (!this.stopControls(await this.scan()).length) break;
      await this.pause();
    }
    return true;
  }

  async reset(): Promise<ThirdPartyReceipt> {
    // Stop, then open an empty new-task link. If it leaves a draft, try the
    // parameterless managed route once. Neither link sends or types.
    const stopped = await this.stopRunningTask();
    const ready = (): ThirdPartyReceipt => ({
      ...this.receipt('ready'),
      ...(stopped ? { stopped: true as const } : {}),
    });
    await this.action(() => this.ui.openNewTask(''));
    const navigatedAt = Date.now();
    const recoverAt =
      navigatedAt +
      Math.min(RESET_DRAFT_GRACE_MS, (this.scanDeadline - navigatedAt) / 2);
    let draft = false;
    let recovered = false;
    let composerReadFailures = 0;
    for (;;) {
      if (Date.now() >= this.scanDeadline)
        throw new DriverFailure(
          draft ? 'draft_not_cleared' : 'deadline_exceeded'
        );
      const nodes = await this.scan();
      // An uncertain submission can become visible while we're resetting.
      if (this.stopControls(nodes).length)
        throw new DriverFailure('task_not_stopped');
      const starts = controls(nodes, ['Start task'], ['button'], {
        enabled: false,
        showing: false,
      });
      const entries = controls(nodes, [COMPOSER], ['entry'], {
        enabled: false,
        showing: false,
      });
      // Navigation can leave an old, offscreen composer in the tree. If no
      // entry is showing, a sole offscreen composer can still hold the draft.
      const showing = entries.filter((node) => node.showing);
      const composers = showing.length ? showing : entries;
      const entry = composers.length === 1 ? composers[0] : undefined;
      // The sidebar button proves nothing. An unselected mode radio lets the
      // next submit select Cowork, unless a draft has already been seen.
      const radios =
        !starts.length && !draft
          ? controls(nodes, ['Cowork'], ['radio button'], { enabled: false })
          : [];
      const start = starts.length === 1 ? starts[0] : undefined;
      if (start?.enabled) draft = true;
      else if (start || (radios.length === 1 && !radios[0]!.selected)) {
        if (!draft && !entries.length && !composerReadFailures) return ready();
        if (entry) {
          // Start task can be disabled during navigation even with a draft.
          let text: string;
          try {
            text = await this.ui.readText(entry);
          } catch (error) {
            // A vanished node must be found again in a fresh snapshot. This
            // retries only the read, never the navigation or a submit.
            if (
              !isTransientUiRead(error) ||
              ++composerReadFailures >= SCAN_ATTEMPTS
            )
              throw error;
            continue;
          }
          composerReadFailures = 0;
          if (!text.trim()) {
            this.remaining();
            return ready();
          }
          draft = true;
        }
      }
      if (start && draft && entry && !recovered && Date.now() >= recoverAt) {
        await this.action(() => this.ui.openBlankManagedTask());
        recovered = true;
        continue;
      }
      await this.pause();
    }
  }

  async selectCowork(): Promise<void> {
    const requested = new Set<'radio' | 'tab' | 'link'>();
    for (;;) {
      const nodes = await this.poll();
      // Only the third-party Start task proves mode. A disabled or offscreen
      // one counts, but a hosted selected Cowork radio does not.
      const starts = controls(nodes, ['Start task'], ['button'], {
        enabled: false,
        showing: false,
      });
      if (starts.length > 1)
        throw new DriverFailure('submission_control_ambiguous');
      if (starts.length) return;
      const radios = controls(nodes, ['Cowork'], ['radio button']);
      if (radios.length > 1)
        throw new DriverFailure('cowork_control_ambiguous');
      if (radios.length) {
        if (!radios[0]!.selected && !requested.has('radio')) {
          requested.add('radio');
          await this.action(() => this.ui.activate(radios[0]!));
        }
      } else {
        const tabs = controls(nodes, ['Cowork'], ['button']);
        if (tabs.length > 1)
          throw new DriverFailure('cowork_control_ambiguous');
        if (tabs.length && !requested.has('tab')) {
          requested.add('tab');
          await this.action(() => this.ui.activate(tabs[0]!));
        } else if (!tabs.length && !requested.has('link')) {
          // Desktop's November 2026 UI has no Cowork control: its mode switch
          // says Claude / Code, and the sidebar has no Cowork button. The
          // previous case's task view (its composer has no Start task) leaves
          // only the empty new-task link, as reset uses, to reach Cowork's
          // composer.
          requested.add('link');
          await this.action(() => this.ui.openNewTask(''));
        }
      }
      await this.pause();
    }
  }

  async waitForEmptyComposer(): Promise<void> {
    for (;;) {
      const nodes = await this.poll();
      const starts = controls(nodes, ['Start task'], ['button'], {
        enabled: false,
        showing: false,
      });
      if (
        starts.length === 1 &&
        !controls(nodes, ['Start task'], ['button'], { showing: false }).length
      )
        return;
      await this.pause();
    }
  }

  /** Paste once into the empty composer. Synthesized typing drops long strings. */
  async pastePrompt(prompt: string, timeoutMs: number): Promise<void> {
    const entries = controls(await this.scan(), [COMPOSER], ['entry']);
    if (entries.length !== 1)
      throw new DriverFailure('composer_missing_or_ambiguous');
    const entry = entries[0]!;
    if ((await this.ui.readText(entry)).trim())
      throw new DriverFailure('composer_not_empty');
    await this.ui.paste(entry, prompt);
    // Rendering need not keep all whitespace or the start of a long prompt.
    // Native-session binding checks the complete, unchanged prompt.
    const tail = normalized(prompt).slice(-PASTE_CHECK_CHARS);
    const until = Date.now() + timeoutMs;
    for (;;) {
      const matches = controls(await this.scan(), [COMPOSER], ['entry']);
      if (
        matches.length === 1 &&
        normalized(await this.ui.readText(matches[0]!)).endsWith(tail)
      )
        return;
      if (Date.now() > until) throw new DriverFailure('prompt_not_pasted');
      await sleep(Math.min(200, until - Date.now()));
    }
  }

  async submit(payload: ThirdPartyPayload): Promise<ThirdPartyReceipt> {
    const prompt = payload.prompt;
    if (typeof prompt !== 'string' || !prompt.trim())
      throw new DriverFailure('invalid_prompt');
    // Managed model selection belongs to settings, never an account picker.
    if (payload.targetModel !== undefined && payload.targetModel !== null)
      throw new DriverFailure('managed_model_requires_settings');
    await this.selectCowork();
    if ([...prompt].length <= DEEP_LINK_PROMPT_CHARS) {
      await this.action(() => this.ui.openNewTask(prompt));
    } else {
      await this.action(() => this.ui.openNewTask(''));
      await this.waitForEmptyComposer();
      await this.action(() =>
        this.pastePrompt(prompt, Math.min(this.remaining(), PASTE_TIMEOUT_MS))
      );
    }
    let revealed = false;
    for (;;) {
      const nodes = await this.poll();
      const starts = controls(nodes, ['Start task'], ['button']);
      if (starts.length > 1)
        throw new DriverFailure('submission_control_ambiguous');
      if (starts.length) {
        // Exactly one submit attempt. No key fallback or action retry.
        await this.action(() => this.ui.activate(starts[0]!));
        return this.receipt('submitted');
      }
      const hidden = controls(nodes, ['Start task'], ['button'], {
        showing: false,
      });
      if (hidden.length === 1 && !revealed) {
        revealed = true;
        await this.action(() => this.ui.reveal(hidden[0]!));
        continue;
      }
      await this.pause();
    }
  }

  /** Take one unambiguous first-option or advance action on a question form. */
  async answer(questions: unknown): Promise<ThirdPartyReceipt> {
    if (!validQuestions(questions))
      throw new DriverFailure('invalid_questions');
    const notFound = (): ThirdPartyReceipt => ({
      ...this.receipt('hitl_checked'),
      question: 'not_found',
    });
    let target: LinuxUiNode;
    let answered: 'option' | 'advance' = 'option';
    try {
      const nodes = await this.scan();
      const texts = controls(
        nodes,
        (name) => QUESTION_PAGE.test(name.trim()),
        TEXT_ROLES,
        { enabled: false, raw: true }
      ).map((node) => node.name.trim());
      const page = questionPage(texts, questions.length);
      if (page === null) return notFound();
      const labels = questions[page]!.labels.map(normalized);
      const exact = controls(
        nodes,
        (name) => normalized(name) === labels[0],
        OPTION_ROLES,
        { raw: true }
      );
      const options = exact.length
        ? exact
        : controls(
            nodes,
            (name) =>
              firstOptionOwner(labels, normalized(name)) &&
              !NOT_OPTION.test(name),
            OPTION_ROLES,
            { raw: true }
          );
      if (options.length !== 1) return notFound();
      target = options[0]!;
      if (target.selected) {
        const advance = controls(nodes, (name) => ADVANCE.test(name.trim()), [
          'button',
        ]);
        if (advance.length !== 1) return notFound();
        target = advance[0]!;
        answered = 'advance';
      }
    } catch (error) {
      if (error instanceof LinuxUiError && SCAN_INCOMPLETE.has(error.code))
        return { ...this.receipt('hitl_checked'), scan: 'incomplete' };
      throw error;
    }
    await this.action(() => this.ui.activate(target));
    return { ...this.receipt('hitl_checked'), answered };
  }

  async hitl(payload: ThirdPartyPayload): Promise<ThirdPartyReceipt> {
    const approveWrites = payload.approveWriteTools === true;
    const read = payload.readOnlyApproval;
    const names = ['Allow once', 'Allow'];
    if (approveWrites)
      names.push(
        'Always allow',
        'Allow always',
        'Full access',
        'Allow full access'
      );
    let found: LinuxUiNode[];
    let nodes: readonly LinuxUiNode[];
    try {
      nodes = await this.scan();
      // A headless run has no user folder to grant. Denial grants nothing.
      const folder = controls(nodes, ['Choose folder'], ['button']);
      if (folder.length) {
        const denies = controls(nodes, ['Deny'], ['button']);
        if (folder.length !== 1 || denies.length !== 1)
          throw new DriverFailure('folder_request_ambiguous');
        await this.action(() => this.ui.activate(denies[0]!));
        return { ...this.receipt('hitl_checked'), denied: 'folder_request' };
      }
      found = controls(nodes, names, ['button']);
      // Managed Cowork's built-in writes use named cards beside Cancel.
      if (!found.length && controls(nodes, ['Cancel'], ['button']).length)
        found = controls(nodes, CARD_ACTIONS, ['button']);
    } catch (error) {
      if (error instanceof LinuxUiError && SCAN_INCOMPLETE.has(error.code))
        return { ...this.receipt('hitl_checked'), scan: 'incomplete' };
      throw error;
    }
    if (!found.length) return this.receipt('hitl_checked');
    const once = found.filter((node) => label(node) === 'Allow once');
    const selected = once.length === 1 ? once : found;
    // The audit may still be catching up, or Allow once may still be
    // showing after a click. Report the card and leave it alone.
    if (!approveWrites && payload.observeReadCard === true)
      return found.length === 1 && once.length === 1
        ? { ...this.receipt('hitl_checked'), readCard: true }
        : this.receipt('hitl_checked');
    if (selected.length !== 1)
      throw new DriverFailure('approval_control_ambiguous');
    // A card can appear between the last audit poll and this scan. Ask the
    // parent to verify it, then rescan before selecting any control.
    if (
      !approveWrites &&
      payload.inspectReadCard === true &&
      found.length === 1 &&
      once.length === 1
    )
      return { ...this.receipt('hitl_checked'), readCard: true };
    if (
      !approveWrites &&
      (!read ||
        found.length !== 1 ||
        !matchesReadCard(nodes, selected[0]!, read))
    )
      throw new DriverFailure('approval_requires_explicit_write_policy');
    await this.action(() => this.ui.activate(selected[0]!));
    return this.receipt('hitl_checked');
  }
}

/** A failure's code for the receipt: only codes MST defines, never native detail. */
function failureCode(error: unknown): string {
  const code =
    error instanceof DriverFailure
      ? error.message
      : error instanceof LinuxUiError
        ? error.code
        : undefined;
  return code && /^[a-z_]{1,64}$/.test(code) ? code : 'desktop_driver_failed';
}

/** Managed Cowork policy over the native UI seam; the caller owns ui.close(). */
export async function runThirdPartyLinux(
  operation: Exclude<LinuxDriverOperation, 'diagnose'>,
  payload: ThirdPartyPayload,
  ui: LinuxUi,
  options: { deadlineAt: number; maxActions: number }
): Promise<ThirdPartyReceipt> {
  const driver = new ThirdPartyDriver(
    ui,
    options.deadlineAt,
    options.maxActions
  );
  try {
    switch (operation) {
      case 'probe':
        return await driver.probe();
      case 'reset':
        return await driver.reset();
      case 'submit':
        return await driver.submit(payload);
      case 'hitl':
        return await driver.hitl(payload);
      case 'answer':
        return await driver.answer(payload.questions);
      default:
        throw new DriverFailure('invalid_operation');
    }
  } catch (error) {
    return { ...driver.receipt('failed'), error: failureCode(error) };
  }
}

/** The accessibility dump a failed case keeps: every showing, named node, indented by depth. */
/**
 * One complete snapshot by `deadline`. A snapshot only reads, so a transient
 * failure rescans, at most SCAN_ATTEMPTS times: the driver's scans and the
 * failure diagnosis both read a tree that may still be changing.
 */
export async function scanLinuxUi(
  ui: LinuxUi,
  deadline: number
): Promise<readonly LinuxUiNode[]> {
  for (let attempt = 1; ; attempt++) {
    if (Date.now() >= deadline)
      throw new LinuxUiError('accessibility_scan_timeout');
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        ui.snapshot(),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(
            () => reject(new LinuxUiError('accessibility_scan_timeout')),
            deadline - Date.now()
          );
        }),
      ]);
    } catch (error) {
      if (attempt >= SCAN_ATTEMPTS || !isTransientUiRead(error)) throw error;
    } finally {
      clearTimeout(timer);
    }
  }
}

export function accessibilityText(nodes: readonly LinuxUiNode[]): string {
  const depth = new Map<string, number>();
  const lines: string[] = [];
  for (const node of nodes.slice(0, 5000)) {
    const level =
      node.parentId === undefined ? 0 : (depth.get(node.parentId) ?? 0) + 1;
    depth.set(node.id, level);
    if (!node.showing || !node.name) continue;
    lines.push(
      `${'  '.repeat(Math.min(level, 16))}${node.role}: ${node.name.replace(/[\r\n]/g, ' ').slice(0, 200)}${node.enabled ? '' : ' [disabled]'}`
    );
  }
  return `${lines.join('\n')}\n`;
}

export { failureCode as thirdPartyFailureCode };
