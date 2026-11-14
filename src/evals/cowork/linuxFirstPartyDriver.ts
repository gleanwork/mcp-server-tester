import { constants } from 'node:fs';
import { stat, writeFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import {
  LinuxUiError,
  type LinuxDriverOperation,
  type LinuxDriverPayload,
  type LinuxDriverReceipt,
  type LinuxUi,
  type LinuxUiNode,
} from './linuxUi.js';

const COMPOSER = 'Write your prompt to Claude';
const HEADER =
  /^Model: ((?:Opus|Sonnet|Haiku) [0-9]+\.[0-9]+)(?: (?:Low|Medium|High|Max))?$/;
const OPTION = /^((?:Opus|Sonnet|Haiku) [0-9]+\.[0-9]+)(?=$| )/;
const SCAN_INCOMPLETE = new Set([
  'accessibility_tree_budget',
  'accessibility_scan_timeout',
]);
const TRANSPORT_ERRORS = new Set([
  ...SCAN_INCOMPLETE,
  'desktop_missing_or_ambiguous',
  'accessibility_unavailable',
  'action_acknowledgement_uncertain',
  'reveal_failed',
  'clipboard_unavailable',
  'composer_not_focused',
  'invalid_url_opener',
  'deadline_exceeded',
  'accessibility_dbus_unavailable',
  'invalid_dbus_address',
  'accessibility_bus_disconnected',
  'accessibility_dbus_error',
  'accessibility_bus_closed',
  'accessibility_invalid_reply',
  'accessibility_node_defunct',
  'accessibility_tree_invalid',
  'accessibility_unknown_node',
  'open_cowork_failed',
]);
const PERSISTENT = [
  'Allow',
  'Always allow',
  'Allow always',
  'Full access',
  'Allow full access',
];
const WRITE_CARDS = ['Create', 'Update', 'Schedule', 'Run', 'Delete'];
const UNSAFE_QUESTION = [
  ...PERSISTENT,
  ...WRITE_CARDS,
  'Allow once',
  'Start task',
  'Send message',
  'Connect',
  'Approve',
  'Accept',
  'Deny',
  'Cancel',
  'Stop',
];
const TEXT_ROLES = ['static', 'text', 'label', 'paragraph', 'heading'];
const OPTION_ROLES = [
  'radio button',
  'check box',
  'checkbox',
  'toggle button',
  'button',
];
const NOT_OPTION =
  /^(?:Skip|Next|Back|Previous|Continue|Submit|Send|Cancel|Dismiss|Create|Allow|Accept|Connect|Approve|Stop|Show|Copy|Edit|Retry|More options|Read aloud|Restart conversation|Add |Press and hold|Progress|Working folder|Context|Start task|Deny)(?:\b|,)/i;
const ADVANCE = /^(?:Submit|Send|Next|Continue)(?: answers?)?$/i;
const PAGE = /^(\d+) of (\d+)$/i;

class DriverFailure extends Error {}

function normalized(text: string): string {
  return text.trim().replace(/\s+/gu, ' ');
}

function label(node: LinuxUiNode): string {
  return node.name.replace(/ [0-9]$/, '');
}

function controls(
  nodes: readonly LinuxUiNode[],
  names: readonly string[] | ((name: string) => boolean),
  roles: readonly string[] = ['button'],
  enabled = true,
  showing = true
): LinuxUiNode[] {
  return nodes.filter(
    (node) =>
      node.visible &&
      (!showing || node.showing) &&
      (!enabled || node.enabled) &&
      roles.includes(node.role) &&
      (typeof names === 'function'
        ? names(label(node))
        : names.includes(label(node)))
  );
}

function targetLabel(target: string): string {
  const match = /^claude-(opus|sonnet|haiku)-([0-9]+)-([0-9]+)$/.exec(target);
  if (!match || target.length > 128)
    throw new DriverFailure('invalid_target_model');
  const family = match[1]!;
  return `${family[0]!.toUpperCase()}${family.slice(1)} ${match[2]}.${match[3]}`;
}

interface Surface {
  entry: LinuxUiNode;
  header: LinuxUiNode;
  model: string;
}

class FirstPartyDriver {
  readonly started = Date.now();
  actions = 0;

  constructor(
    readonly ui: LinuxUi,
    readonly deadlineAt: number,
    readonly maxActions: number
  ) {}

  receipt(status: LinuxDriverReceipt['status']): LinuxDriverReceipt {
    return {
      status,
      action_count: this.actions,
      duration_ms: Math.max(0, Date.now() - this.started),
    };
  }

  check(until = this.deadlineAt, code = 'deadline_exceeded'): void {
    if (Date.now() >= this.deadlineAt)
      throw new DriverFailure('deadline_exceeded');
    if (Date.now() >= until) throw new DriverFailure(code);
  }

  /** A stalled native call must not extend a read-only stage or the overall call. */
  async bounded<T>(
    operation: () => Promise<T>,
    until = this.deadlineAt,
    code = 'deadline_exceeded'
  ): Promise<T> {
    this.check(until, code);
    const end = Math.min(until, this.deadlineAt);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const result = await Promise.race([
        operation(),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(
            () =>
              reject(
                new DriverFailure(
                  end === this.deadlineAt ? 'deadline_exceeded' : code
                )
              ),
            end - Date.now()
          );
        }),
      ]);
      this.check(until, code);
      return result;
    } finally {
      clearTimeout(timer);
    }
  }

  async action(operation: () => Promise<void>): Promise<void> {
    this.check();
    if (this.actions >= this.maxActions)
      throw new DriverFailure('action_budget_exhausted');
    // Count the attempt, including a native action with an uncertain acknowledgement.
    this.actions += 1;
    await this.bounded(operation);
  }

  async poll<T>(
    milliseconds: number,
    code: string,
    inspect: (nodes: readonly LinuxUiNode[], until: number) => Promise<T | null>
  ): Promise<T> {
    const until = Math.min(this.deadlineAt, Date.now() + milliseconds);
    let defunct = false;
    while (Date.now() < until) {
      this.check(until, code);
      let nodes: readonly LinuxUiNode[] | undefined;
      try {
        nodes = await this.bounded(() => this.ui.snapshot(), until, code);
      } catch (error) {
        // Claude destroys a view's nodes while navigating (for example, from a
        // finished task to a new one), so a walk can reach a node that is
        // gone. A snapshot is read-only: scan again rather than fail the stage.
        if (
          !(error instanceof LinuxUiError) ||
          error.code !== 'accessibility_node_defunct'
        )
          throw error;
      }
      defunct = nodes === undefined;
      const result = nodes ? await inspect(nodes, until) : null;
      if (result !== null) return result;
      this.check(until, code);
      await new Promise<void>((resolve) =>
        setTimeout(resolve, Math.min(100, until - Date.now()))
      );
    }
    if (Date.now() >= this.deadlineAt)
      throw new DriverFailure('deadline_exceeded');
    // A tree that never settled is the cause, not the stage's own condition.
    if (defunct) throw new LinuxUiError('accessibility_node_defunct');
    throw new DriverFailure(code);
  }

  async surface(
    nodes: readonly LinuxUiNode[],
    empty = false,
    until = this.deadlineAt,
    code = 'deadline_exceeded'
  ): Promise<Surface> {
    const cowork = controls(nodes, ['Cowork'], ['radio button'], false);
    const chat = controls(nodes, ['Chat'], ['radio button'], false);
    if (
      cowork.length !== 1 ||
      chat.length !== 1 ||
      !cowork[0]!.selected ||
      chat[0]!.selected
    ) {
      throw new DriverFailure('first_party_cowork_not_ready');
    }
    const entries = controls(nodes, [COMPOSER], ['entry']);
    if (entries.length !== 1)
      throw new DriverFailure('composer_missing_or_ambiguous');
    const headers = controls(nodes, (name) => name.startsWith('Model:'));
    const model =
      headers.length === 1 ? HEADER.exec(label(headers[0]!))?.[1] : undefined;
    if (!model) throw new DriverFailure('model_control_missing_or_ambiguous');
    if (controls(nodes, ['Stop response', 'Stop task']).length)
      throw new DriverFailure('first_party_task_running');
    const entry = entries[0]!;
    if (
      empty &&
      (await this.bounded(() => this.ui.readText(entry), until, code)).trim()
    ) {
      throw new DriverFailure('composer_not_empty');
    }
    return { entry, header: headers[0]!, model };
  }

  async waitEmpty(): Promise<Surface> {
    return this.poll(
      10_000,
      'first_party_cowork_not_ready',
      async (nodes, until) => {
        try {
          return await this.surface(
            nodes,
            true,
            until,
            'first_party_cowork_not_ready'
          );
        } catch (error) {
          if (
            error instanceof DriverFailure &&
            [
              'first_party_cowork_not_ready',
              'composer_missing_or_ambiguous',
              'model_control_missing_or_ambiguous',
              'composer_not_empty',
            ].includes(error.message)
          )
            return null;
          throw error;
        }
      }
    );
  }

  async probe(): Promise<LinuxDriverReceipt> {
    await this.surface(await this.bounded(() => this.ui.snapshot()), true);
    return this.receipt('ready');
  }

  async reset(): Promise<LinuxDriverReceipt> {
    const nodes = await this.bounded(() => this.ui.snapshot());
    if (controls(nodes, ['Stop response', 'Stop task']).length)
      throw new DriverFailure('first_party_task_running');
    await this.action(() => this.ui.openCowork());
    await this.waitEmpty();
    return this.receipt('ready');
  }

  async selectModel(target: string, current: Surface): Promise<void> {
    if (current.model === target) return;
    await this.action(() => this.ui.activate(current.header));
    const option = await this.poll(
      10_000,
      'model_unavailable_or_ambiguous',
      async (nodes) => {
        const options = controls(nodes, () => true, ['radio menu item']);
        const matches = options.filter(
          (item) => OPTION.exec(label(item))?.[1] === target
        );
        if (matches.length > 1 || (options.length && !matches.length))
          throw new DriverFailure('model_unavailable_or_ambiguous');
        return matches[0] ?? null;
      }
    );
    await this.action(() => this.ui.activate(option));
    await this.poll(
      10_000,
      'model_selection_not_confirmed',
      async (nodes, until) => {
        const surface = await this.surface(
          nodes,
          true,
          until,
          'model_selection_not_confirmed'
        );
        return surface.model === target &&
          !controls(nodes, () => true, ['radio menu item']).length
          ? surface
          : null;
      }
    );
  }

  async submit(payload: LinuxDriverPayload): Promise<LinuxDriverReceipt> {
    const prompt = payload.prompt;
    if (typeof prompt !== 'string' || !prompt.trim())
      throw new DriverFailure('invalid_prompt');
    const target =
      payload.targetModel === undefined
        ? undefined
        : targetLabel(payload.targetModel);
    await this.action(() => this.ui.openCowork());
    const initial = await this.waitEmpty();
    if (target !== undefined) await this.selectModel(target, initial);
    const nodes = await this.bounded(() => this.ui.snapshot());
    const before = await this.surface(nodes, true);
    if (controls(nodes, () => true, ['radio menu item']).length)
      throw new DriverFailure('model_selection_not_confirmed');
    if (target !== undefined && before.model !== target)
      throw new DriverFailure('model_changed_before_submit');
    await this.action(() => this.ui.paste(before.entry, prompt));
    const tail = normalized(prompt).slice(-200);
    // AT-SPI can omit the start of long rendered drafts. Session binding checks
    // the complete submitted prompt; this guard checks the same tail as Python.
    await this.poll(30_000, 'prompt_not_pasted', async (snapshot, until) => {
      const surface = await this.surface(
        snapshot,
        false,
        until,
        'prompt_not_pasted'
      );
      if (surface.model !== before.model)
        throw new DriverFailure('model_changed_before_submit');
      const text = await this.bounded(
        () => this.ui.readText(surface.entry),
        until,
        'prompt_not_pasted'
      );
      return normalized(text).endsWith(tail) ? true : null;
    });
    let revealed = false;
    await this.poll(
      10_000,
      'submission_control_missing',
      async (snapshot, until) => {
        const surface = await this.surface(
          snapshot,
          false,
          until,
          'submission_control_missing'
        );
        if (surface.model !== before.model)
          throw new DriverFailure('model_changed_before_submit');
        const text = await this.bounded(
          () => this.ui.readText(surface.entry),
          until,
          'submission_control_missing'
        );
        if (!normalized(text).endsWith(tail))
          throw new DriverFailure('prompt_changed_before_submit');
        const starts = controls(
          snapshot,
          ['Start task'],
          ['button'],
          true,
          false
        );
        if (starts.length > 1)
          throw new DriverFailure('submission_control_ambiguous');
        const start = starts[0];
        if (start?.showing) {
          // One native submission. Never retry or press Enter after uncertainty.
          await this.action(() => this.ui.activate(start));
          return true;
        }
        if (start && !revealed) {
          revealed = true;
          await this.action(() => this.ui.reveal(start));
        }
        return null;
      }
    );
    return this.receipt('submitted');
  }

  async hitl(approveWrites: boolean): Promise<LinuxDriverReceipt> {
    const nodes = await this.bounded(() => this.ui.snapshot());
    const folders = controls(nodes, ['Choose folder']);
    if (folders.length) {
      const denies = controls(nodes, ['Deny']);
      if (folders.length !== 1 || denies.length !== 1)
        throw new DriverFailure('folder_request_ambiguous');
      await this.action(() => this.ui.activate(denies[0]!));
      return { ...this.receipt('hitl_checked'), denied: 'folder_request' };
    }
    const once = controls(nodes, ['Allow once']);
    if (once.length > 1) throw new DriverFailure('approval_control_ambiguous');
    if (once.length) {
      if (!approveWrites)
        throw new DriverFailure('approval_requires_explicit_write_policy');
      await this.action(() => this.ui.activate(once[0]!));
    } else if (
      controls(nodes, PERSISTENT).length ||
      (controls(nodes, ['Cancel']).length &&
        controls(nodes, WRITE_CARDS).length)
    ) {
      throw new DriverFailure('account_approval_scope_unsupported');
    }
    return this.receipt('hitl_checked');
  }

  async answer(
    questions: LinuxDriverPayload['questions']
  ): Promise<LinuxDriverReceipt> {
    if (!validQuestions(questions))
      throw new DriverFailure('invalid_questions');
    const nodes = await this.bounded(() => this.ui.snapshot());
    if (controls(nodes, unsafeQuestionAction, OPTION_ROLES).length)
      throw new DriverFailure('account_question_action_conflict');
    // Page totals are literal text, not keyboard shortcut suffixes.
    const markers = controls(nodes, () => true, TEXT_ROLES, false).filter(
      (item) => PAGE.test(item.name.trim())
    );
    const pages = new Set(
      markers.map((item) => item.name.trim().toLowerCase())
    );
    let page = questions.length === 1 ? 0 : undefined;
    if (pages.size) {
      const match = pages.size === 1 ? PAGE.exec([...pages][0]!) : null;
      page =
        match &&
        Number(match[2]) === questions.length &&
        Number(match[1]) >= 1 &&
        Number(match[1]) <= questions.length
          ? Number(match[1]) - 1
          : undefined;
    }
    const idle = this.receipt('hitl_checked');
    if (page === undefined) return idle;
    const labels: string[] = questions[page]!.labels.map(normalized);
    const first = labels[0]!;
    // Exact labels do not bypass the account approval denylist either.
    if (unsafeQuestionAction(first))
      throw new DriverFailure('account_question_action_conflict');
    const matches = questionOptions(nodes, labels, first);
    if (matches.length !== 1) return idle;
    let target = matches[0]!;
    // Apply scope proof to selection as well as advancement: a unique exact
    // label elsewhere in the app is not evidence of a question option.
    const byId = new Map(nodes.map((item) => [item.id, item]));
    const scope =
      target.parentId === undefined
        ? undefined
        : questionScope(nodes, byId, target, labels);
    if (target.parentId !== undefined && !scope) return idle;
    let answered: 'option' | 'advance' = 'option';
    if (target.selected) {
      const advance = controls(nodes, (name) =>
        ADVANCE.test(name.trim())
      ).filter(
        (item) => scope === undefined || withinContainer(byId, item, scope)
      );
      if (advance.length !== 1) return idle;
      target = advance[0]!;
      answered = 'advance';
    }
    await this.action(() => this.ui.activate(target));
    return { ...this.receipt('hitl_checked'), answered };
  }

  async diagnose(directory: string | undefined): Promise<LinuxDriverReceipt> {
    if (
      typeof directory !== 'string' ||
      !isAbsolute(directory) ||
      !(await this.bounded(() => stat(directory))).isDirectory()
    )
      throw new DriverFailure('invalid_directory');
    const nodes = await this.bounded(() => this.ui.snapshot());
    const dump =
      nodes
        .slice(0, 5000)
        .filter((item) => item.showing && item.name)
        .map(
          (item) =>
            `${item.role.replace(/[\r\n]/g, ' ').slice(0, 80)}: ${item.name.replace(/[\r\n]/g, ' ').slice(0, 200)}${item.enabled ? '' : ' [disabled]'}`
        )
        .join('\n') + '\n';
    // Never follow an existing dump symlink or collect a screenshot/account data.
    await this.bounded(() =>
      writeFile(join(directory, 'accessibility.txt'), dump, {
        flag:
          constants.O_WRONLY |
          constants.O_CREAT |
          constants.O_TRUNC |
          constants.O_NOFOLLOW,
        mode: 0o600,
      })
    );
    return this.receipt('diagnosed');
  }
}

function validQuestions(
  value: unknown
): value is NonNullable<LinuxDriverPayload['questions']> {
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

function unsafeQuestionAction(value: string): boolean {
  const text = normalized(value).toLowerCase();
  return UNSAFE_QUESTION.some(
    (name) =>
      text === name.toLowerCase() || text.startsWith(`${name.toLowerCase()} `)
  );
}

function questionOptions(
  nodes: readonly LinuxUiNode[],
  labels: readonly string[],
  wanted: string
): LinuxUiNode[] {
  const options = controls(nodes, () => true, OPTION_ROLES);
  const exact = options.filter(
    (item) =>
      normalized(label(item)) === wanted || normalized(item.name) === wanted
  );
  if (exact.length) return exact;
  const starts = (name: string, value: string) =>
    name === value || name.startsWith(`${value} `);
  return options.filter((item) => {
    const name = normalized(label(item));
    return (
      starts(name, wanted) &&
      !NOT_OPTION.test(name) &&
      !labels.some(
        (other) => other.length > wanted.length && starts(name, other)
      )
    );
  });
}

function withinContainer(
  byId: ReadonlyMap<string, LinuxUiNode>,
  node: LinuxUiNode,
  id: string
): boolean {
  const visited = new Set<string>();
  let parent = node.parentId;
  while (parent && !visited.has(parent) && visited.size < 64) {
    if (parent === id) return true;
    visited.add(parent);
    parent = byId.get(parent)?.parentId;
  }
  return false;
}

function questionScope(
  nodes: readonly LinuxUiNode[],
  byId: ReadonlyMap<string, LinuxUiNode>,
  target: LinuxUiNode,
  labels: readonly string[]
): string | undefined {
  const visited = new Set<string>();
  let parent = target.parentId;
  while (parent && !visited.has(parent) && visited.size < 64) {
    visited.add(parent);
    const container = byId.get(parent);
    if (
      !container ||
      ['application', 'frame', 'document web', 'document frame'].includes(
        container.role
      )
    )
      return undefined;
    const children = nodes.filter((item) =>
      withinContainer(byId, item, parent!)
    );
    // A nested radio group can have its advance button in the surrounding form.
    // Do not walk out of a complete semantic question into unrelated page chrome.
    const complete = labels.every(
      (value) => questionOptions(children, labels, value).length === 1
    );
    if (
      complete &&
      (!target.selected ||
        controls(children, (name) => ADVANCE.test(name.trim())).length ||
        ['section', 'form', 'dialog'].includes(container.role))
    )
      return parent;
    parent = container.parentId;
  }
  return undefined;
}

/** Account-backed Cowork policy over the native UI seam; the caller owns ui.close(). */
export async function runFirstPartyLinux(
  operation: LinuxDriverOperation,
  payload: LinuxDriverPayload,
  ui: LinuxUi,
  options: { deadlineAt: number; maxActions: number }
): Promise<LinuxDriverReceipt> {
  const driver = new FirstPartyDriver(
    ui,
    options.deadlineAt,
    options.maxActions
  );
  try {
    if (
      !Number.isFinite(options.deadlineAt) ||
      !Number.isInteger(options.maxActions) ||
      options.maxActions < 1 ||
      options.maxActions > 64
    ) {
      throw new DriverFailure('invalid_budget');
    }
    driver.check();
    switch (operation) {
      case 'probe':
        return await driver.probe();
      case 'reset':
        return await driver.reset();
      case 'submit':
        return await driver.submit(payload);
      case 'hitl':
        return await driver.hitl(payload.approveWrites === true);
      case 'answer':
        return await driver.answer(payload.questions);
      case 'diagnose':
        return await driver.diagnose(payload.dir);
      default:
        throw new DriverFailure('invalid_operation');
    }
  } catch (error) {
    if (
      (operation === 'hitl' || operation === 'answer') &&
      driver.actions === 0 &&
      error instanceof LinuxUiError &&
      SCAN_INCOMPLETE.has(error.code)
    ) {
      return { ...driver.receipt('hitl_checked'), scan: 'incomplete' };
    }
    const code =
      error instanceof DriverFailure
        ? error.message
        : error instanceof LinuxUiError && TRANSPORT_ERRORS.has(error.code)
          ? error.code
          : 'desktop_driver_failed';
    return { ...driver.receipt('failed'), error: code };
  }
}
