import { createHash } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import type {
  ApprovalAction,
  ApprovalAdapter,
  ApprovalJson,
  ApprovalObservation,
} from '../approvalAutomation.js';
import { isRecord } from './deadline.js';

export interface CoworkApprovalHandle {
  elementIndex: number;
  elementToken: string;
  snapshotId: string;
  serverDisplayName: string;
  tool: string;
}

export interface CoworkModeApprovalHandle {
  elementIndex: number;
  elementToken: string;
  snapshotId: string;
}

interface CoworkApprovalSnapshot {
  snapshotId: string;
  elements: Record<string, unknown>[];
}

export function createCuaCoworkAutoModeAdapter(options: {
  pid: number;
  windowId: number;
  call(
    name: string,
    args: Record<string, unknown>
  ): Promise<Record<string, unknown>>;
}): ApprovalAdapter<CoworkModeApprovalHandle> {
  if (!positiveInteger(options.pid) || !positiveInteger(options.windowId))
    throw new TypeError('Invalid CoWork mode adapter configuration.');
  return {
    async observe() {
      const state = await modeSnapshot(options);
      const pickers = state.elements.filter(
        (element) =>
          element.role === 'AXPopUpButton' &&
          /^Manually approve(?:\b|,)/i.test(text(element.label).trim())
      );
      if (pickers.length !== 1)
        throw new Error('Unverified CoWork manual approval picker.');
      const picker = pickers[0]!;
      requireActionable(picker, 'CoWork manual approval picker');
      return {
        id: hash(`${state.snapshotId}\n${picker.element_token}`),
        action: {
          kind: 'host_permission_mode',
          attributes: {
            surface: 'cowork',
            mode: 'automatic',
            scope: 'current_task',
          },
        },
        handle: {
          elementIndex: picker.element_index,
          elementToken: picker.element_token,
          snapshotId: state.snapshotId,
        },
      };
    },
    async approve(observation) {
      await acknowledgedElementClick(options, observation.handle);
      const menu = await modeSnapshot(options);
      const choices = menu.elements.filter(
        (element) =>
          element.role === 'AXMenuItem' &&
          /^Automatically approve(?:\b|,)/i.test(text(element.label).trim())
      );
      const choice = choices[0];
      if (choices.length !== 1 || !choice)
        throw new Error('Unverified CoWork automatic approval choice.');
      requireActionable(choice, 'CoWork automatic approval choice');
      await acknowledgedElementClick(options, {
        elementIndex: choice.element_index,
        elementToken: choice.element_token,
        snapshotId: menu.snapshotId,
      });
    },
    async verify() {
      const state = await modeSnapshot(options);
      const configured = state.elements.filter(
        (element) =>
          element.role === 'AXPopUpButton' &&
          /^Automatically approve(?:\b|,)/i.test(text(element.label).trim())
      );
      return configured.length === 1 ? 'applied' : 'unknown';
    },
  };
}

export function createCuaCoworkApprovalAdapter(options: {
  pid: number;
  windowId: number;
  call(
    name: string,
    args: Record<string, unknown>
  ): Promise<Record<string, unknown>>;
  servers: Array<{ label: string; displayName: string }>;
  verificationTimeoutMs?: number;
  pollIntervalMs?: number;
}): ApprovalAdapter<CoworkApprovalHandle> {
  const verificationTimeoutMs = options.verificationTimeoutMs ?? 5000;
  const pollIntervalMs = options.pollIntervalMs ?? 100;
  if (
    !positiveInteger(options.pid) ||
    !positiveInteger(options.windowId) ||
    options.servers.length < 1 ||
    new Set(options.servers.map((server) => server.label)).size !==
      options.servers.length ||
    options.servers.some(
      (server) => !server.label.trim() || !server.displayName.trim()
    ) ||
    !Number.isInteger(verificationTimeoutMs) ||
    verificationTimeoutMs < 1 ||
    !Number.isInteger(pollIntervalMs) ||
    pollIntervalMs < 1
  )
    throw new TypeError('Invalid CoWork approval adapter configuration.');

  return { observe, approve, verify };

  async function observe(): Promise<ApprovalObservation<CoworkApprovalHandle> | null> {
    const initial = await snapshot();
    const initialButtons = approvalButtons(initial.elements);
    if (initialButtons.length === 0) return null;
    if (initialButtons.length !== 1)
      throw new Error('Ambiguous CoWork approval controls.');
    const state = await snapshot();
    const buttons = approvalButtons(state.elements);
    const button = buttons[0];
    if (buttons.length !== 1 || !button)
      throw new Error('CoWork approval card changed before grounding.');
    requireActionable(button, 'CoWork approval control');
    const card = matchingCard(button, state.elements);
    const observationId = hash(
      `${state.snapshotId}\n${button.element_token}\n${canonical(card.action)}`
    );
    return {
      id: observationId,
      action: card.action,
      handle: {
        elementIndex: button.element_index,
        elementToken: button.element_token,
        snapshotId: state.snapshotId,
        serverDisplayName: card.serverDisplayName,
        tool: text(card.action.attributes.tool),
      },
    };
  }

  async function approve(
    observation: ApprovalObservation<CoworkApprovalHandle>
  ): Promise<void> {
    await acknowledgedElementClick(options, observation.handle);
  }

  async function verify(
    observation: ApprovalObservation<CoworkApprovalHandle>
  ): Promise<'applied' | 'not_applied' | 'unknown'> {
    const deadline = Date.now() + verificationTimeoutMs;
    do {
      await sleep(Math.min(pollIntervalMs, verificationTimeoutMs));
      const state = await snapshot();
      const buttonsAfter = approvalButtons(state.elements);
      if (buttonsAfter.length > 1)
        throw new Error('Ambiguous CoWork approval controls after dispatch.');
      if (buttonsAfter.length === 1) {
        const current = matchingCard(buttonsAfter[0]!, state.elements);
        if (canonical(current.action) !== canonical(observation.action))
          return 'applied';
        continue;
      }
      const allText = state.elements.map(elementText).join('\n');
      const positive = [
        `Using ${observation.handle.serverDisplayName}`,
        `Used ${observation.handle.serverDisplayName}`,
      ].some((value) => normalize(allText).includes(normalize(value)));
      if (positive) return 'applied';
    } while (Date.now() < deadline);
    const final = await snapshot();
    const sameRequest = approvalButtons(final.elements).some(
      (button) =>
        canonical(matchingCard(button, final.elements).action) ===
        canonical(observation.action)
    );
    return sameRequest ? 'not_applied' : 'unknown';
  }

  async function snapshot(): Promise<CoworkApprovalSnapshot> {
    const raw = await options.call('get_window_state', {
      pid: options.pid,
      window_id: options.windowId,
      include_screenshot: false,
      max_elements: 2000,
    });
    if (
      raw.pid !== options.pid ||
      raw.window_id !== options.windowId ||
      raw.degraded === true ||
      typeof raw.snapshot_id !== 'string' ||
      !raw.snapshot_id ||
      !Array.isArray(raw.elements) ||
      !raw.elements.every(isRecord) ||
      raw.returned_element_count !== raw.elements.length ||
      (typeof raw.element_count === 'number' &&
        raw.element_count !== raw.elements.length)
    )
      throw new Error('Unverified or incomplete CoWork approval snapshot.');
    return {
      snapshotId: raw.snapshot_id,
      elements: raw.elements,
    };
  }

  function matchingCard(
    button: Record<string, unknown>,
    elements: Record<string, unknown>[]
  ): {
    action: ApprovalAction;
    serverDisplayName: string;
  } {
    const buttonFrame = frame(button);
    const headings = elements.flatMap((element) => {
      const elementFrame = frame(element);
      if (!elementFrame) return [];
      const normalized = normalize(elementText(element));
      return options.servers.flatMap((server) => {
        const match = new RegExp(
          `Claude wants to use\\s+([A-Za-z0-9_.-]+)\\s+from\\s+${escapeRegex(
            server.displayName
          )}`,
          'i'
        ).exec(normalized);
        return match?.[1]
          ? [{ element, frame: elementFrame, server, tool: match[1] }]
          : [];
      });
    });
    const identities = new Set(
      headings.map((heading) => `${heading.server.label}:${heading.tool}`)
    );
    if (!buttonFrame || identities.size !== 1)
      throw new Error('CoWork approval card identity is unverified.');
    const heading = headings
      .filter(
        (candidate) =>
          candidate.frame.y < buttonFrame.y &&
          buttonFrame.x >= candidate.frame.x - 10 &&
          buttonFrame.x + buttonFrame.w <=
            candidate.frame.x + candidate.frame.w + 10
      )
      .sort((left, right) => right.frame.w - left.frame.w)[0];
    if (!heading)
      throw new Error('CoWork approval card geometry is unverified.');
    const parsedArguments = new Map<string, Record<string, ApprovalJson>>();
    for (const element of elements) {
      const elementFrame = frame(element);
      if (
        !elementFrame ||
        elementFrame.y <= heading.frame.y ||
        elementFrame.y >= buttonFrame.y ||
        elementFrame.x < heading.frame.x - 10 ||
        elementFrame.x + elementFrame.w > heading.frame.x + heading.frame.w + 10
      )
        continue;
      for (const value of [element.label, element.value]) {
        if (typeof value !== 'string' || !value.trim().startsWith('{'))
          continue;
        const parsed = parseArguments(value);
        parsedArguments.set(canonical(parsed), parsed);
      }
    }
    if (parsedArguments.size !== 1)
      throw new Error('CoWork approval arguments are ambiguous.');
    return {
      serverDisplayName: heading.server.displayName,
      action: {
        kind: 'mcp_tool_call',
        attributes: {
          server: heading.server.label,
          tool: heading.tool,
          arguments: [...parsedArguments.values()][0]!,
        },
      },
    };
  }
}

function approvalButtons(
  elements: Record<string, unknown>[]
): Record<string, unknown>[] {
  return elements.filter(
    (element) =>
      element.role === 'AXButton' &&
      /^Allow once(?:\b|,)/i.test(text(element.label).trim())
  );
}

async function modeSnapshot(options: {
  pid: number;
  windowId: number;
  call(
    name: string,
    args: Record<string, unknown>
  ): Promise<Record<string, unknown>>;
}): Promise<CoworkApprovalSnapshot> {
  const raw = await options.call('get_window_state', {
    pid: options.pid,
    window_id: options.windowId,
    include_screenshot: false,
    max_elements: 2000,
  });
  if (
    raw.pid !== options.pid ||
    raw.window_id !== options.windowId ||
    raw.degraded === true ||
    typeof raw.snapshot_id !== 'string' ||
    !raw.snapshot_id ||
    !Array.isArray(raw.elements) ||
    !raw.elements.every(isRecord) ||
    raw.returned_element_count !== raw.elements.length ||
    (typeof raw.element_count === 'number' &&
      raw.element_count !== raw.elements.length)
  )
    throw new Error('Unverified or incomplete CoWork mode snapshot.');
  return {
    snapshotId: raw.snapshot_id,
    elements: raw.elements,
  };
}

function requireActionable(
  element: Record<string, unknown>,
  description: string
): asserts element is Record<string, unknown> & {
  element_index: number;
  element_token: string;
} {
  if (
    element.enabled !== true ||
    !Array.isArray(element.actions) ||
    !element.actions.includes('AXPress') ||
    !nonNegativeInteger(element.element_index) ||
    typeof element.element_token !== 'string' ||
    !element.element_token
  )
    throw new Error(`${description} is not safely actionable.`);
}

async function acknowledgedElementClick(
  options: {
    pid: number;
    windowId: number;
    call(
      name: string,
      args: Record<string, unknown>
    ): Promise<Record<string, unknown>>;
  },
  target: {
    elementIndex: number;
    elementToken: string;
    snapshotId: string;
  }
): Promise<void> {
  const result = await options.call('click', {
    pid: options.pid,
    window_id: options.windowId,
    element_index: target.elementIndex,
    element_token: target.elementToken,
    snapshot_id: target.snapshotId,
    delivery_mode: 'foreground',
  });
  if (
    result.refusal ||
    result.status === 'refused' ||
    result.status === 'unsupported' ||
    result.effect === 'suspected_noop' ||
    result.success === false
  )
    throw new Error('CoWork mode click was refused or unacknowledged.');
}

function frame(
  element: Record<string, unknown>
): { x: number; y: number; w: number; h: number } | null {
  const value = element.frame;
  if (
    !isRecord(value) ||
    ![value.x, value.y, value.w, value.h].every(
      (entry) => typeof entry === 'number' && Number.isFinite(entry)
    )
  )
    return null;
  return value as { x: number; y: number; w: number; h: number };
}

function parseArguments(textValue: string): Record<string, ApprovalJson> {
  const start = textValue.indexOf('{');
  const end = textValue.lastIndexOf('}');
  if (start < 0 || end <= start)
    throw new Error('CoWork approval arguments are unavailable.');
  try {
    const value: unknown = JSON.parse(textValue.slice(start, end + 1));
    if (!isApprovalObject(value)) throw new Error();
    return value;
  } catch {
    throw new Error('CoWork approval arguments are invalid.');
  }
}

function isApprovalObject(
  value: unknown
): value is Record<string, ApprovalJson> {
  return (
    isRecord(value) &&
    Object.values(value).every((entry) => isApprovalJson(entry))
  );
}

function isApprovalJson(value: unknown): value is ApprovalJson {
  if (value === null || typeof value === 'boolean' || typeof value === 'string')
    return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isApprovalJson);
  return isApprovalObject(value);
}

function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value))
    return `[${value.map((item) => canonical(item)).join(',')}]`;
  return `{${Object.keys(value)
    .sort()
    .map(
      (key) =>
        `${JSON.stringify(key)}:${canonical(
          (value as Record<string, unknown>)[key]
        )}`
    )
    .join(',')}}`;
}

function elementText(element: Record<string, unknown>): string {
  return [element.label, element.value]
    .filter((value): value is string => typeof value === 'string')
    .join('\n');
}

function normalize(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function positiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0;
}

function nonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
