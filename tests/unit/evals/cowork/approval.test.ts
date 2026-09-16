import { describe, expect, it, vi } from 'vitest';
import {
  createCuaCoworkApprovalAdapter,
  createCuaCoworkAutoModeAdapter,
} from '../../../../src/evals/cowork/approval.js';

const PID = 42;
const WINDOW_ID = 7;
const DISPLAY = 'MCP Server Tester desktop_records 48ab9ffc';

function cardSnapshot(
  options: {
    server?: string;
    tool?: string;
    args?: string;
    duplicate?: boolean;
    actions?: string[];
  } = {}
) {
  const server = options.server ?? DISPLAY;
  const tool = options.tool ?? 'lookup_record';
  const elements: Record<string, unknown>[] = [
    {
      element_index: 1,
      element_token: 'group-token',
      role: 'AXGroup',
      depth: 1,
    },
    {
      element_index: 2,
      element_token: 'heading-token',
      parent_index: 1,
      role: 'AXStaticText',
      depth: 2,
      label: `Claude wants to use ${tool} from ${server}`,
      frame: { x: 100, y: 100, w: 500, h: 40 },
    },
    {
      element_index: 3,
      element_token: 'args-token',
      parent_index: 1,
      role: 'AXStaticText',
      depth: 2,
      value:
        options.args ??
        '{\n  "namespace": "releases",\n  "reference": "abc"\n}',
      frame: { x: 120, y: 200, w: 250, h: 80 },
    },
    {
      element_index: 4,
      element_token: 'allow-token',
      parent_index: 1,
      role: 'AXButton',
      depth: 2,
      label: 'Allow once',
      enabled: true,
      actions: options.actions ?? ['AXPress'],
      frame: { x: 450, y: 400, w: 130, h: 32 },
    },
  ];
  if (options.duplicate)
    elements.push({
      ...elements[3],
      element_index: 5,
      element_token: 'allow-token-2',
    });
  return snapshot(elements, 'snapshot-before');
}

function appliedSnapshot() {
  return snapshot(
    [
      {
        element_index: 1,
        element_token: 'status-token',
        role: 'AXStaticText',
        depth: 1,
        label: `Using ${DISPLAY} integration`,
      },
    ],
    'snapshot-after'
  );
}

function modeSnapshot(label: string, role: string, token: string) {
  return {
    pid: PID,
    window_id: WINDOW_ID,
    snapshot_id: `snapshot-${token}`,
    element_count: 1,
    returned_element_count: 1,
    degraded: false,
    elements: [
      {
        element_index: 1,
        element_token: token,
        role,
        label,
        enabled: true,
        actions: ['AXPress'],
        frame:
          role === 'AXMenuItem'
            ? { x: 200, y: 200, w: 200, h: 30 }
            : { x: 100, y: 100, w: 100, h: 30 },
      },
    ],
    window_bounds: { x: 0, y: 0, width: 1000, height: 800 },
    screenshot_width: 1000,
    screenshot_height: 800,
  };
}

function snapshot(elements: Record<string, unknown>[], snapshotId: string) {
  return {
    pid: PID,
    window_id: WINDOW_ID,
    snapshot_id: snapshotId,
    element_count: elements.length,
    returned_element_count: elements.length,
    degraded: false,
    elements,
    window_bounds: { x: 0, y: 0, width: 1000, height: 800 },
    screenshot_width: 1000,
    screenshot_height: 800,
  };
}

function fixture(states: Record<string, unknown>[]) {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const call = vi.fn(async (name: string, args: Record<string, unknown>) => {
    calls.push({ name, args });
    if (name === 'get_window_state') {
      const next = states.length > 1 ? states.shift() : states[0];
      if (!next) throw new Error('no state');
      return next;
    }
    if (name === 'click') return { effect: 'unverifiable' };
    throw new Error(`unexpected ${name}`);
  });
  const adapter = createCuaCoworkApprovalAdapter({
    pid: PID,
    windowId: WINDOW_ID,
    call,
    servers: [{ label: 'desktop_records', displayName: DISPLAY }],
    verificationTimeoutMs: 100,
    pollIntervalMs: 1,
  });
  return { adapter, calls, call };
}

describe('CoWork Cua automatic-mode adapter', () => {
  it('selects and verifies automatic mode on the exact fresh task', async () => {
    const manual = modeSnapshot(
      'Manually approve',
      'AXPopUpButton',
      'manual-token'
    );
    manual.elements[0]!.element_index = 0;
    const states = [
      manual,
      modeSnapshot('Automatically approve', 'AXMenuItem', 'auto-token'),
      modeSnapshot('Automatically approve', 'AXPopUpButton', 'active-token'),
    ];
    const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
    const adapter = createCuaCoworkAutoModeAdapter({
      pid: PID,
      windowId: WINDOW_ID,
      async call(name, args) {
        calls.push({ name, args });
        if (name === 'get_window_state') return states.shift()!;
        if (name === 'click') return { effect: 'unverifiable' };
        throw new Error(`unexpected ${name}`);
      },
    });
    const observation = (await adapter.observe())!;
    expect(observation.action).toEqual({
      kind: 'host_permission_mode',
      attributes: {
        surface: 'cowork',
        mode: 'automatic',
        scope: 'current_task',
      },
    });
    await adapter.approve(observation);
    await expect(adapter.verify(observation)).resolves.toBe('applied');
    expect(calls.map((call) => call.name)).toEqual([
      'get_window_state',
      'click',
      'get_window_state',
      'click',
      'get_window_state',
    ]);
    expect(calls.filter((call) => call.name === 'click')).toEqual([
      {
        name: 'click',
        args: {
          pid: PID,
          window_id: WINDOW_ID,
          element_index: 0,
          element_token: 'manual-token',
          snapshot_id: 'snapshot-manual-token',
          delivery_mode: 'foreground',
        },
      },
      {
        name: 'click',
        args: {
          pid: PID,
          window_id: WINDOW_ID,
          element_index: 1,
          element_token: 'auto-token',
          snapshot_id: 'snapshot-auto-token',
          delivery_mode: 'foreground',
        },
      },
    ]);
  });

  it('fails closed when the observed mode picker token is stale', async () => {
    const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
    const adapter = createCuaCoworkAutoModeAdapter({
      pid: PID,
      windowId: WINDOW_ID,
      async call(name, args) {
        calls.push({ name, args });
        if (name === 'get_window_state')
          return modeSnapshot(
            'Manually approve',
            'AXPopUpButton',
            'manual-token'
          );
        if (name === 'click')
          return {
            status: 'refused',
            refusal: { code: 'stale_element_token' },
          };
        throw new Error(`unexpected ${name}`);
      },
    });
    const observation = (await adapter.observe())!;
    await expect(adapter.approve(observation)).rejects.toThrow(/refused/);
    const clickCalls = calls.filter((call) => call.name === 'click');
    expect(clickCalls).toHaveLength(1);
    expect(clickCalls[0]?.args).not.toHaveProperty('x');
    expect(clickCalls[0]?.args).not.toHaveProperty('y');
  });

  it('refuses an ambiguous mode picker before dispatch', async () => {
    const first = modeSnapshot(
      'Manually approve',
      'AXPopUpButton',
      'manual-token'
    );
    first.elements.push({
      element_index: 2,
      element_token: 'second-token',
      role: 'AXPopUpButton',
      label: 'Manually approve',
      enabled: true,
      actions: ['AXPress'],
      frame: { x: 250, y: 100, w: 100, h: 30 },
    });
    first.element_count = 2;
    first.returned_element_count = 2;
    const adapter = createCuaCoworkAutoModeAdapter({
      pid: PID,
      windowId: WINDOW_ID,
      async call() {
        return first;
      },
    });
    await expect(adapter.observe()).rejects.toThrow(/picker/);
  });
});

describe('CoWork Cua approval adapter', () => {
  it('observes one exact card, presses Allow once, and verifies a positive transition', async () => {
    const f = fixture([cardSnapshot(), cardSnapshot(), appliedSnapshot()]);
    const observation = await f.adapter.observe();
    expect(observation).toMatchObject({
      action: {
        kind: 'mcp_tool_call',
        attributes: {
          server: 'desktop_records',
          tool: 'lookup_record',
          arguments: { namespace: 'releases', reference: 'abc' },
        },
      },
      handle: {
        elementIndex: 4,
        elementToken: 'allow-token',
        snapshotId: 'snapshot-before',
      },
    });
    await f.adapter.approve(observation!);
    await expect(f.adapter.verify(observation!)).resolves.toBe('applied');
    expect(f.calls.map((call) => call.name)).toEqual([
      'get_window_state',
      'get_window_state',
      'click',
      'get_window_state',
    ]);
    expect(f.calls[2]?.args).toEqual({
      pid: PID,
      window_id: WINDOW_ID,
      element_index: 4,
      element_token: 'allow-token',
      snapshot_id: 'snapshot-before',
      delivery_mode: 'foreground',
    });
  });

  it('fails closed without coordinate fallback when the approval token is stale', async () => {
    const f = fixture([cardSnapshot(), cardSnapshot()]);
    f.call.mockImplementation(async (name, args) => {
      f.calls.push({ name, args });
      if (name === 'get_window_state') return cardSnapshot();
      if (name === 'click')
        return {
          status: 'refused',
          refusal: { code: 'stale_element_token' },
        };
      throw new Error(`unexpected ${name}`);
    });
    const observation = (await f.adapter.observe())!;
    await expect(f.adapter.approve(observation)).rejects.toThrow(/refused/);
    const clickCalls = f.calls.filter((call) => call.name === 'click');
    expect(clickCalls).toHaveLength(1);
    expect(clickCalls[0]?.args).not.toHaveProperty('x');
    expect(clickCalls[0]?.args).not.toHaveProperty('y');
  });

  it('returns null when no approval card exists', async () => {
    const f = fixture([appliedSnapshot()]);
    await expect(f.adapter.observe()).resolves.toBeNull();
  });

  it.each([
    ['ambiguous buttons', cardSnapshot({ duplicate: true })],
    ['unknown server', cardSnapshot({ server: 'Other Server' })],
    ['invalid arguments', cardSnapshot({ args: '{not json}' })],
    ['non-actionable button', cardSnapshot({ actions: [] })],
  ])('refuses %s before dispatch', async (_name, state) => {
    const f = fixture([state]);
    await expect(f.adapter.observe()).rejects.toThrow();
    expect(f.calls.map((call) => call.name)).not.toContain('click');
  });

  it('waits while the same approval card remains after dispatch', async () => {
    const f = fixture([
      cardSnapshot(),
      cardSnapshot(),
      cardSnapshot(),
      appliedSnapshot(),
    ]);
    const observation = await f.adapter.observe();
    await f.adapter.approve(observation!);
    await expect(f.adapter.verify(observation!)).resolves.toBe('applied');
    expect(f.calls.filter((call) => call.name === 'click')).toHaveLength(1);
  });

  it('does not treat button disappearance alone as approval proof', async () => {
    const f = fixture([
      cardSnapshot(),
      cardSnapshot(),
      snapshot(
        [
          {
            element_index: 1,
            element_token: 'other-token',
            role: 'AXStaticText',
            label: 'Unrelated state',
          },
        ],
        'snapshot-after'
      ),
    ]);
    const observation = await f.adapter.observe();
    await f.adapter.approve(observation!);
    await expect(f.adapter.verify(observation!)).resolves.toBe('unknown');
  });

  it('rejects malformed or unscoped window snapshots', async () => {
    const f = fixture([{ ...cardSnapshot(), pid: 99 }]);
    await expect(f.adapter.observe()).rejects.toThrow(/snapshot/);
  });
});
