import { describe, expect, it } from 'vitest';
import {
  actionField,
  assistantTurn,
  ComputerUseLoopError,
  ComputerUseTelemetryRecorder,
  DesktopBlockedError,
  PLANNER_CONNECTION_RETRY_DELAYS_MS,
  PlannerConnectionError,
  PlannerStatusError,
  runComputerUseLoop,
  trimScreenshotHistory,
  type ComputerUseDesktop,
  type ComputerUseOutcome,
  type ComputerUseRun,
  type DesktopAction,
  type PlannerBlock,
  type PlannerMessage,
  type PlannerRequest,
  type PlannerResponse,
} from './computerUseLoop.js';
import { PlannerTimeoutError } from './computerUsePlanner.js';
import type { ComputerUseTelemetry } from './driver.js';

/** Offline: never opens an app or touches the display. */

type Proposal = DesktopAction | { tool: string; input: unknown };
const FILL: Proposal = { tool: 'fill_query', input: {} };
const ENTER: Proposal = { action: 'key', text: 'Return' };
const CONFIRM_MODEL: Proposal = {
  tool: 'confirm_model',
  input: { model: 'claude-opus-4-6' },
};
const IMAGE = {
  type: 'image',
  source: { type: 'base64', media_type: 'image/png', data: 'x' },
} as const;

interface Scenario {
  mode?: ComputerUseRun['mode'];
  budget?: number;
  query?: string;
  /** The planner's replies after the first, in order. Without them, the first repeats. */
  plans?: Proposal[][];
  /** Errors the planner throws before its first reply. */
  plannerFailures?: Error[];
  /** An error the planner throws after its first reply. */
  plannerError?: Error;
  entryError?: boolean;
  metadata?: { model?: unknown; usage?: unknown };
  application?: ComputerUseRun['application'];
  targetModel?: string;
  reasoningEffort?: string;
  chatgptSurface?: ComputerUseRun['chatgptSurface'];
  /** Frontmost app names, one per check. Without them, the app is always in front. */
  frontmost?: Array<string | undefined>;
  appPath?: string;
  approveWriteTools?: boolean;
  workspace?: string;
  permissions?: () => Promise<void>;
  prepare?: () => Promise<void>;
}

interface Observed {
  result?: ComputerUseOutcome;
  error?: ComputerUseLoopError;
  /** The result, or the error's message. */
  outcome: ComputerUseOutcome | string;
  executed: DesktopAction[];
  plannerCalls: number;
  request: PlannerRequest | undefined;
  launches: Array<[string, boolean]>;
  urls: string[];
  sleeps: number[];
  logged: string[];
  focusChecks: number;
  telemetry: ComputerUseTelemetry;
  prepared: boolean;
}

function response(
  plan: Proposal[],
  metadata: Scenario['metadata']
): PlannerResponse {
  return {
    ...metadata,
    content: plan.map((proposal, index) => ({
      type: 'tool_use',
      name: 'tool' in proposal ? String(proposal.tool) : 'computer',
      id: String(index),
      input: 'tool' in proposal ? proposal.input : proposal,
    })),
  };
}

async function runActions(
  first: Proposal[],
  scenario: Scenario = {}
): Promise<Observed> {
  const application = scenario.application ?? 'cowork';
  const appName = application === 'chatgpt' ? 'ChatGPT' : 'Claude';
  const executed: DesktopAction[] = [];
  const launches: Array<[string, boolean]> = [];
  const urls: string[] = [];
  const sleeps: number[] = [];
  const logged: string[] = [];
  let focusChecks = 0;
  let plannerCalls = 0;
  let prepared = false;
  let request: PlannerRequest | undefined;
  const failures = [...(scenario.plannerFailures ?? [])];
  const replies = [
    response(first, scenario.metadata),
    ...(scenario.plans ?? []).map((plan) => response(plan, scenario.metadata)),
  ];
  const repeat =
    scenario.plans === undefined && scenario.plannerError === undefined;
  const frontmost = scenario.frontmost ? [...scenario.frontmost] : undefined;

  const desktop: ComputerUseDesktop = {
    checkPermissions: scenario.permissions ?? (async () => undefined),
    async launch(app, required) {
      launches.push([app, required]);
    },
    async openUrl(url) {
      urls.push(url);
    },
    async newChatgptChat() {
      return true;
    },
    async screenshot() {
      return { ...IMAGE, source: { ...IMAGE.source } };
    },
    async frontmostApp() {
      focusChecks += 1;
      if (!frontmost) return appName;
      if (!frontmost.length) throw new Error('no more frontmost answers');
      return frontmost.shift();
    },
    async execute(action) {
      executed.push(action);
      if (scenario.entryError && action.action === 'type')
        throw new Error('uncertain keyboard failure');
      if (action.action === 'screenshot')
        return {
          result: { ...IMAGE, source: { ...IMAGE.source } },
          submitted: false,
        };
      return {
        result: 'done',
        submitted:
          action.action === 'key' &&
          ['enter', 'return'].includes(
            actionField(action, 'text').toLowerCase()
          ),
      };
    },
  };
  let served = 0;
  const run: ComputerUseRun = {
    query: scenario.query ?? 'query',
    maxActions: scenario.budget ?? 8,
    mode: scenario.mode ?? 'submit',
    application,
    chatgptSurface: scenario.chatgptSurface ?? 'chatgpt-work',
    ...(scenario.targetModel ? { targetModel: scenario.targetModel } : {}),
    ...(scenario.reasoningEffort
      ? { reasoningEffort: scenario.reasoningEffort }
      : {}),
    model: 'claude-sonnet-4-6',
    ...(scenario.appPath ? { appPath: scenario.appPath } : {}),
    approveWriteTools: scenario.approveWriteTools ?? false,
    ...(scenario.workspace ? { workspace: scenario.workspace } : {}),
    startDelayMs: 3000,
    secrets: ['secret'],
  };
  const observed: Partial<Observed> = {};
  try {
    observed.result = await runComputerUseLoop(run, {
      desktop,
      planner: {
        prepare:
          scenario.prepare ??
          (async () => {
            prepared = true;
          }),
        async create(next) {
          plannerCalls += 1;
          request = next;
          const failure = failures.shift();
          if (failure) throw failure;
          if (served >= replies.length) {
            if (scenario.plannerError) throw scenario.plannerError;
            if (repeat) return replies[0]!;
            throw new Error('no more planner replies');
          }
          return replies[served++]!;
        },
      },
      async sleep(ms) {
        sleeps.push(ms);
      },
      log: (message) => logged.push(message),
      signal: new AbortController().signal,
    });
  } catch (error) {
    if (!(error instanceof ComputerUseLoopError)) throw error;
    observed.error = error;
  }
  return {
    ...observed,
    outcome: observed.result ?? observed.error!.message,
    executed,
    plannerCalls,
    request,
    launches,
    urls,
    sleeps,
    logged,
    focusChecks,
    telemetry: observed.result?.telemetry ?? observed.error!.telemetry,
    prepared,
  };
}

function firstText(request: PlannerRequest | undefined): string {
  const content = request!.messages[0]!.content as Array<{ text?: string }>;
  return content[0]!.text!;
}

function toolNames(request: PlannerRequest | undefined): string[] {
  return (request?.tools ?? []).map((tool) => String(tool.name));
}

function toolResult(request: PlannerRequest | undefined, message: number) {
  const content = request!.messages[message]!.content as Array<
    Record<string, unknown>
  >;
  return content[0]!;
}

function connectionError(): PlannerConnectionError {
  return new PlannerConnectionError('TypeError <- Error(ECONNREFUSED)');
}

describe('the planner conversation', () => {
  it('drops fields a gateway adds to its reply from the assistant turn', () => {
    const thinking: PlannerBlock = {
      type: 'thinking',
      thinking: '...',
      signature: 'sig',
    };
    expect(
      assistantTurn([
        { type: 'text', text: 'Taking a screenshot.', citations: null },
        {
          type: 'tool_use',
          id: 'toolu_1',
          name: 'computer',
          input: { action: 'screenshot' },
          caller: {},
          toolset_name: null,
        },
        thinking,
      ])
    ).toEqual([
      { type: 'text', text: 'Taking a screenshot.' },
      {
        type: 'tool_use',
        id: 'toolu_1',
        name: 'computer',
        input: { action: 'screenshot' },
      },
      thinking,
    ]);
  });

  it('sends back a clean assistant turn', async () => {
    const run = await runActions([{ action: 'screenshot' }], {
      mode: 'hitl',
      budget: 2,
      plans: [[]],
    });
    const assistant = run.request!.messages.filter(
      (m) => m.role === 'assistant'
    );
    expect(assistant.length).toBeGreaterThan(0);
    for (const message of assistant)
      for (const block of message.content as Array<Record<string, unknown>>)
        expect(Object.keys(block).sort()).toEqual([
          'id',
          'input',
          'name',
          'type',
        ]);
  });

  it('checks the planner credential before launching the app', async () => {
    const run = await runActions([], {
      mode: 'hitl',
      prepare: async () => {
        throw new Error('A gateway token requires a gateway base URL');
      },
    });
    expect(run.outcome).toContain('gateway base URL');
    expect(run.launches).toEqual([]);
    expect(run.executed).toEqual([]);
    expect(run.plannerCalls).toBe(0);
  });
});

describe('Cowork HITL', () => {
  it('defaults to read-only and never persistent approval', async () => {
    const run = await runActions([], {
      mode: 'hitl',
      approveWriteTools: false,
    });
    const system = run.request!.system;
    expect(system).toContain(
      'Never approve writes or tools with unknown effects'
    );
    expect(system).toContain('Never grant persistent access');
    expect(system).toContain('Prefer current-task approval');
    expect(system).toContain(
      'covers other tools, or could include ineligible writes, use Allow once'
    );
  });

  it('does not allow persistent approval when writes are opted in', async () => {
    const run = await runActions([], { mode: 'hitl', approveWriteTools: true });
    const system = run.request!.system;
    expect(system).toContain('explicitly permits tool writes');
    expect(system).toContain('Never grant persistent access');
    expect(system).toContain(
      'limited to this task and the eligible named tool or tools'
    );
  });

  it('counts responses, not actions, when no tool is needed', async () => {
    const run = await runActions([], { mode: 'hitl' });
    expect(run.result).toMatchObject({
      status: 'hitl_checked',
      action_count: 0,
    });
    expect(run.telemetry.planner_response_count).toBe(1);
    expect(run.telemetry.executed_action_count).toBe(run.executed.length);
  });

  it('keeps partial action counts when the budget runs out after acting', async () => {
    const run = await runActions(
      [{ action: 'left_click', coordinate: [5, 5] }],
      {
        mode: 'hitl',
        budget: 1,
      }
    );
    expect(run.outcome).toContain('HITL check exceeded');
    expect(run.error!.hitlBudget).toBe(true);
    expect(run.telemetry.executed_action_count).toBe(run.executed.length);
    expect(run.telemetry.accounting).toBe('partial');
  });

  it.each([{ action: 'type', text: 'query' }, ENTER, FILL])(
    'cannot type, press Enter or fill (%o)',
    async (action) => {
      const run = await runActions([action], { mode: 'hitl' });
      expect(run.outcome).toContain('HITL cannot');
      expect(run.executed).toEqual([]);
      expect(toolNames(run.request)).not.toContain('fill_query');
    }
  );

  it('has no model gate', async () => {
    const run = await runActions([], {
      mode: 'hitl',
      targetModel: 'claude-opus-4-6',
    });
    expect(run.result!.status).toBe('hitl_checked');
    expect(run.executed).toEqual([]);
    expect(toolNames(run.request)).toEqual(['computer']);
    expect(firstText(run.request)).not.toContain('claude-opus-4-6');
  });
});

describe('Cowork focus', () => {
  it.each(['submit', 'hitl'] as const)(
    'focuses the exact pinned bundle (%s)',
    async (mode) => {
      const path = '/private/tmp/mst-test/unpacked/Claude.app';
      const run = await runActions([FILL, ENTER], { mode, appPath: path });
      expect(run.launches[0]).toEqual([path, true]);
    }
  );

  it('refocuses and skips an action aimed at another app', async () => {
    const click = { action: 'left_click', coordinate: [10, 10] };
    // Finder came forward; refocusing brings Claude back for the next plan.
    const run = await runActions([click], {
      plans: [[{ action: 'screenshot' }, FILL, ENTER]],
      frontmost: ['Finder', 'Claude', 'Claude', 'Claude'],
    });
    expect(run.result!.status).toBe('submitted');
    expect(run.executed).toEqual([
      { action: 'screenshot' },
      { action: 'type', text: 'query' },
      ENTER,
    ]);
    expect(run.launches.filter(([app]) => app === 'Claude')).toHaveLength(2);
    const feedback = toolResult(run.request, 2);
    expect(feedback.is_error).toBe(true);
    expect(feedback.content).toContain('Take a fresh screenshot');
    expect(run.telemetry.refused_action_count).toBe(1);
  });

  it('stops without acting when it cannot refocus', async () => {
    const run = await runActions([FILL, ENTER], {
      frontmost: ['Slack', 'Slack'],
    });
    expect(run.error!.code).toBe('navigation_blocked');
    expect(run.executed).toEqual([]);
  });

  it("doesn't need focus for a screenshot", async () => {
    const run = await runActions([{ action: 'screenshot' }], {
      plans: [[FILL, ENTER]],
      frontmost: ['Claude', 'Claude'],
    });
    expect(run.result!.status).toBe('submitted');
    expect(run.focusChecks).toBe(2);
  });

  it('checks focus in a reset too', async () => {
    const stop = { action: 'left_click', coordinate: [10, 10] };
    const run = await runActions([stop], {
      mode: 'reset',
      frontmost: ['Finder', 'Finder'],
    });
    expect(run.error).toBeDefined();
    expect(run.executed).toEqual([]);
  });
});

describe('Cowork reset', () => {
  const stop = { action: 'left_click', coordinate: [10, 10] };

  it('takes no action when nothing is running', async () => {
    const run = await runActions([], { mode: 'reset' });
    expect(run.result!.status).toBe('reset_done');
    expect(run.executed).toEqual([]);
    expect(run.request!.system).toContain('never approve');
    expect(toolNames(run.request)).not.toContain('fill_query');
  });

  it('clicks Stop, then reports done', async () => {
    const run = await runActions([stop], { mode: 'reset', plans: [[]] });
    expect(run.result!.status).toBe('reset_done');
    expect(run.executed).toEqual([stop]);
  });

  it.each([
    { action: 'type', text: 'x' },
    { action: 'key', text: 'enter' },
    { action: 'key', text: 'cmd+escape' },
    { action: 'left_click_drag', coordinate: [10, 10] },
    { action: 'double_click', coordinate: [10, 10] },
    { action: 'right_click', coordinate: [10, 10] },
  ])('never types, presses keys or drags (%o)', async (action) => {
    // A planner that keeps proposing it never gets it executed.
    const run = await runActions([action], { mode: 'reset', budget: 3 });
    expect(run.outcome).toContain('Computer Use reset exceeded 3 actions');
    expect(run.executed).toEqual([]);
    expect(run.telemetry.refused_action_count).toBe(3);
  });

  it('lets the planner try again after a refusal', async () => {
    // It proposed a key press, was refused, then clicked Stop and finished.
    const run = await runActions([{ action: 'key', text: 'enter' }], {
      mode: 'reset',
      plans: [[stop], []],
    });
    expect(run.result!.status).toBe('reset_done');
    expect(run.executed).toEqual([stop]);
    expect(run.telemetry.refused_action_count).toBe(1);
    const feedback = toolResult(run.request, 2);
    expect(feedback.is_error).toBe(true);
    expect(feedback.content).toContain('a reset may only');
  });

  it('may press Escape', async () => {
    const escape = { action: 'key', text: 'Escape' };
    const run = await runActions([escape], { mode: 'reset', plans: [[]] });
    expect(run.result!.status).toBe('reset_done');
    expect(run.executed).toEqual([escape]);
  });

  it('refuses other tools', async () => {
    const run = await runActions([FILL], { mode: 'reset', budget: 2 });
    expect(run.outcome).toContain('Computer Use reset exceeded 2 actions');
    expect(run.executed).toEqual([]);
  });

  it('fails when it only watches until the budget runs out', async () => {
    // Never concluding the app is idle is not a reset.
    const run = await runActions([{ action: 'screenshot' }], {
      mode: 'reset',
      budget: 2,
    });
    expect(run.outcome).toContain('Computer Use reset exceeded 2 actions');
  });

  it('forbids Send and answers', async () => {
    const run = await runActions([], { mode: 'reset' });
    expect(firstText(run.request)).toContain('Never click Send');
    expect(firstText(run.request)).toContain('do not answer it');
  });

  it('fails when it keeps acting', async () => {
    const run = await runActions([stop], { mode: 'reset', budget: 2 });
    expect(run.outcome).toContain('Computer Use reset exceeded 2 actions');
  });

  it('is not automated for ChatGPT', async () => {
    const run = await runActions([], { mode: 'reset', application: 'chatgpt' });
    expect(run.outcome).toContain('resets are not automated');
    expect(run.executed).toEqual([]);
  });
});

describe('Cowork model confirmation', () => {
  const targetModel = 'claude-opus-4-6';

  it('blocks fill without confirmation', async () => {
    const run = await runActions([FILL, ENTER], { budget: 2, targetModel });
    expect(run.error).toBeDefined();
    expect(run.executed).toEqual([]);
    expect(run.telemetry.refused_action_count).toBe(2);
  });

  it.each(['claude-opus-4-8', 'Opus', 'auto'])(
    'rejects a wrong or generic model (%s)',
    async (model) => {
      const run = await runActions(
        [{ tool: 'confirm_model', input: { model } }, FILL, ENTER],
        { budget: 3, targetModel }
      );
      expect(run.error).toBeDefined();
      expect(run.executed).toEqual([]);
      const tool = run.request!.tools.find((t) => t.name === 'confirm_model')!;
      expect(
        (tool.input_schema as { properties: { model: { enum: string[] } } })
          .properties.model.enum
      ).toEqual([targetModel]);
      expect(run.telemetry.refused_action_count).toBe(3);
    }
  );

  it('lets the initial screenshot ground the confirmation', async () => {
    const run = await runActions([CONFIRM_MODEL, FILL, ENTER], {
      budget: 3,
      targetModel,
    });
    expect(run.result!.status).toBe('submitted');
    expect(run.executed).toHaveLength(2);
    expect(run.result!.action_count).toBe(3);
    expect(run.telemetry.attempted_action_count).toBe(2);
    expect(run.telemetry.executed_action_count).toBe(2);
    const instruction = firstText(run.request);
    expect(instruction).toContain("EXACT model 'claude-opus-4-6'");
    expect(instruction).toContain('Do not open a browser, terminal');
    expect(instruction).toContain('native exact-model verification');
  });

  it('submits the unchanged query once after a fresh, observed confirmation', async () => {
    const query = '  Original “query”\n\n[MCP_SERVER_TESTER_marker]\n';
    const run = await runActions(
      [{ action: 'left_click', coordinate: [5, 5] }, { action: 'screenshot' }],
      {
        plans: [[CONFIRM_MODEL, FILL, ENTER, ENTER]],
        budget: 5,
        targetModel,
        query,
      }
    );
    expect(run.result!.status).toBe('submitted');
    expect(run.executed).toHaveLength(4);
    expect(run.executed.slice(-2)).toEqual([
      { action: 'type', text: query },
      ENTER,
    ]);
    expect(run.telemetry.executed_action_count).toBe(4);
    expect(run.telemetry.planner_response_count).toBe(2);
  });

  it("can't confirm on a screenshot from the same plan", async () => {
    const run = await runActions(
      [
        { action: 'left_click', coordinate: [5, 5] },
        { action: 'screenshot' },
        CONFIRM_MODEL,
        FILL,
        ENTER,
      ],
      { budget: 5, targetModel }
    );
    expect(run.error).toBeDefined();
    expect(run.executed).toHaveLength(2);
    expect(run.telemetry.refused_action_count).toBe(3);
  });

  it.each([
    { action: 'left_click', coordinate: [5, 5] },
    { action: 'key', text: 'Tab' },
    { action: 'scroll', scroll_direction: 'down' },
  ])(
    'treats navigation as undoing the confirmation (%o)',
    async (navigation) => {
      const run = await runActions([CONFIRM_MODEL, navigation, FILL, ENTER], {
        budget: 4,
        targetModel,
      });
      expect(run.error).toBeDefined();
      expect(run.executed).toEqual([navigation]);
    }
  );

  it('stops without input or submission when the model is unavailable', async () => {
    const run = await runActions(
      [
        { tool: 'report_blocker', input: { code: 'model_unavailable' } },
        FILL,
        ENTER,
      ],
      { targetModel }
    );
    expect(run.error!.code).toBe('model_unavailable');
    expect(run.executed).toEqual([]);
    expect(run.telemetry.attempted_action_count).toBe(0);
  });
});

describe('ChatGPT', () => {
  it('ignores the Cowork bundle override', async () => {
    const run = await runActions([FILL, ENTER], {
      application: 'chatgpt',
      appPath: '/private/tmp/Claude.app',
    });
    expect(run.launches[0]).toEqual(['ChatGPT', false]);
  });

  it('lets the planner choose the Codex surface, without adding it to the query', async () => {
    const query = '  original query\n';
    const run = await runActions([FILL, { action: 'screenshot' }], {
      plans: [[ENTER]],
      application: 'chatgpt',
      chatgptSurface: 'codex',
      query,
    });
    expect(run.result!.status).toBe('submitted');
    expect(run.executed).toHaveLength(3);
    const instruction = firstText(run.request);
    expect(instruction).toContain('Open Codex');
    expect(instruction).toContain('verify its current-mode label');
    expect(instruction).not.toContain('ChatGPT Work');
    expect(run.executed[0]).toEqual({ action: 'paste', text: query });
  });

  it('opens a Codex draft in the workspace instead of a new chat', async () => {
    const run = await runActions([FILL, { action: 'screenshot' }], {
      plans: [[ENTER]],
      application: 'chatgpt',
      chatgptSurface: 'codex',
      workspace: '/private/tmp/mst workspace',
    });
    expect(run.urls).toEqual([
      'codex://new?path=%2Fprivate%2Ftmp%2Fmst%20workspace',
    ]);
    expect(firstText(run.request)).toContain(
      'opened a fresh draft in its own folder'
    );
  });

  it('uses the shared loop with the app, model and effort instructions', async () => {
    const run = await runActions([FILL, { action: 'screenshot' }], {
      plans: [[ENTER, ENTER]],
      application: 'chatgpt',
      targetModel: 'test-chatgpt-model',
      reasoningEffort: 'medium',
    });
    expect(run.result!.status).toBe('submitted');
    expect(run.executed).toHaveLength(3);
    expect(run.launches[0]).toEqual(['ChatGPT', false]);
    const instruction = firstText(run.request);
    expect(instruction).toContain('ChatGPT Work');
    expect(instruction).toContain('test-chatgpt-model');
    expect(instruction).toContain("'Standard'");
    expect(instruction).toContain("'Medium'");
    expect(instruction).toContain('Do not change account settings');
    expect(run.executed[0]).toEqual({ action: 'paste', text: 'query' });
    expect(run.request!.tools[0]!.type).toBe('computer_20251124');
  });

  it('stops before the planner, a launch or input when a permission is missing', async () => {
    const run = await runActions([FILL, ENTER], {
      application: 'chatgpt',
      permissions: async () => {
        throw new DesktopBlockedError('screen_recording_required');
      },
    });
    expect(run.error!.code).toBe('screen_recording_required');
    expect(run.telemetry.planner_response_count).toBe(0);
    expect(run.prepared).toBe(false);
    expect(run.plannerCalls).toBe(0);
    expect(run.launches).toEqual([]);
    expect(run.executed).toEqual([]);
  });

  it('classifies a provider status without its response content', async () => {
    const run = await runActions([{ action: 'screenshot' }], {
      application: 'chatgpt',
      plannerError: new PlannerStatusError(429),
    });
    expect(run.error!.code).toBe('provider_rate_limit');
  });

  it('reports only a blocker code, with no further actions', async () => {
    const run = await runActions(
      [
        { tool: 'report_blocker', input: { code: 'reasoning_unavailable' } },
        FILL,
        ENTER,
      ],
      { application: 'chatgpt' }
    );
    expect(run.error!.code).toBe('reasoning_unavailable');
    expect(run.executed).toEqual([]);
    expect(run.telemetry.refused_action_count).toBe(1);
  });

  it('never approves permissions automatically', async () => {
    const run = await runActions([], { mode: 'hitl', application: 'chatgpt' });
    expect(run.outcome).toContain('approvals and resets are not automated');
    expect(run.executed).toEqual([]);
    expect(run.launches).toEqual([]);
  });

  it('allows no click or second fill after the fill', async () => {
    const run = await runActions(
      [
        FILL,
        { action: 'left_click', coordinate: [5, 5] },
        FILL,
        { action: 'screenshot' },
      ],
      { plans: [[ENTER]], application: 'chatgpt' }
    );
    expect(run.result!.status).toBe('submitted');
    expect(run.executed).toHaveLength(3);
    expect(run.telemetry.refused_action_count).toBe(2);
  });

  it('waits to press Enter until the filled composer is seen', async () => {
    // Enter in the fill's own plan, and Enter with a screenshot in the same
    // plan, are refused: a menu opened while typing would take the Enter.
    const escape = { action: 'key', text: 'Escape' };
    const run = await runActions(
      [FILL, ENTER, { action: 'screenshot' }, ENTER],
      {
        plans: [[escape, ENTER, { action: 'screenshot' }], [ENTER]],
        application: 'chatgpt',
      }
    );
    expect(run.result!.status).toBe('submitted');
    expect(run.executed.map((action) => action.action)).toEqual([
      'paste',
      'screenshot',
      'key',
      'screenshot',
      'key',
    ]);
    expect(run.executed[2]).toEqual(escape);
    expect(run.telemetry.refused_action_count).toBe(3);
  });

  it('keeps only the three latest screenshots, and the tool structure', () => {
    const images = Array.from({ length: 6 }, (_, i) => ({
      type: 'image',
      source: { data: String(i) },
    }));
    const messages: PlannerMessage[] = [
      { role: 'user', content: [images[0]!] },
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: '1', content: images.slice(1) },
        ],
      },
    ];
    trimScreenshotHistory(messages);
    expect(images.slice(0, 3).every((image) => image.type === 'text')).toBe(
      true
    );
    expect(images.slice(3).map((image) => image.source.data)).toEqual([
      '3',
      '4',
      '5',
    ]);
    expect(
      (messages[1]!.content as Array<{ tool_use_id: string }>)[0]!.tool_use_id
    ).toBe('1');
  });
});

describe('planner retries', () => {
  it('retries connection failures without desktop actions', async () => {
    const run = await runActions([FILL, ENTER], {
      plannerFailures: [connectionError(), connectionError()],
    });
    expect(run.result!.status).toBe('submitted');
    expect(run.plannerCalls).toBe(3);
    expect(run.executed).toEqual([{ action: 'type', text: 'query' }, ENTER]);
    const retries = run.logged.filter((line) =>
      line.includes('planner connection failed')
    );
    expect(retries).toHaveLength(2);
    expect(retries[0]).toContain('TypeError <- Error(ECONNREFUSED)');
    expect(retries[0]).toContain('retrying in 2s (1/4)');
    expect(retries[1]).toContain('retrying in 4s (2/4)');
    expect(run.sleeps).toContain(2000);
    expect(run.sleeps).toContain(4000);
  });

  it('reports provider_unavailable when the planner stays unreachable', async () => {
    const failures = Array.from(
      { length: PLANNER_CONNECTION_RETRY_DELAYS_MS.length + 1 },
      connectionError
    );
    const run = await runActions([FILL, ENTER], { plannerFailures: failures });
    expect(run.error!.code).toBe('provider_unavailable');
    expect(run.outcome).toContain(
      'could not reach the API (TypeError <- Error(ECONNREFUSED))'
    );
    expect(run.plannerCalls).toBe(failures.length);
    expect(run.executed).toEqual([]);
    expect(run.telemetry.planner_response_count).toBe(0);
  });

  it("doesn't retry other errors", async () => {
    const timedOut = await runActions([FILL, ENTER], {
      plannerFailures: [new PlannerTimeoutError()],
    });
    expect(timedOut.plannerCalls).toBe(1);
    expect(timedOut.error!.code).toBeUndefined();
    expect(timedOut.executed).toEqual([]);
    const limited = await runActions([FILL, ENTER], {
      plannerFailures: [new PlannerStatusError(429)],
    });
    expect(limited.plannerCalls).toBe(1);
    expect(limited.error!.code).toBe('provider_rate_limit');
  });
});

describe('telemetry', () => {
  it('sums the models and cached usage of each completed plan', async () => {
    const metadata = {
      model: 'claude-sonnet-4-6',
      usage: {
        input_tokens: 100,
        output_tokens: 20,
        cache_creation_input_tokens: 30,
        cache_read_input_tokens: 40,
        prompt: 'private query',
        api_key: 'secret',
      },
    };
    const run = await runActions([{ action: 'screenshot' }], {
      plans: [[FILL, ENTER]],
      metadata,
    });
    const telemetry = run.result!.telemetry;
    expect(telemetry.response_models).toEqual(['claude-sonnet-4-6']);
    expect(telemetry.planner_response_count).toBe(2);
    expect(telemetry.usage).toEqual({
      input_tokens: 200,
      output_tokens: 40,
      cache_creation_input_tokens: 60,
      cache_read_input_tokens: 80,
    });
    expect(new Set(Object.values(telemetry.usage_observation_counts))).toEqual(
      new Set([2])
    );
    expect(telemetry.cost).toEqual({ status: 'unavailable' });
    expect(telemetry.executed_action_count).toBe(run.executed.length);
    expect(telemetry.accounting).toBe('complete');
    expect(telemetry.duration_ms).toBeGreaterThanOrEqual(0);
    expect(JSON.stringify(telemetry)).not.toContain('private');
    expect(JSON.stringify(telemetry)).not.toContain('secret');
  });

  it('tracks model changes and partial usage coverage', () => {
    const telemetry = new ComputerUseTelemetryRecorder(() => []);
    telemetry.observe({
      model: 'claude-sonnet-4-6',
      usage: { input_tokens: 10 },
      content: [],
    });
    telemetry.observe({
      model: 'claude-opus-4-6',
      usage: { input_tokens: 20, cache_read_input_tokens: 0 },
      content: [],
    });
    const result = telemetry.snapshot('complete');
    expect(result.response_models).toEqual([
      'claude-sonnet-4-6',
      'claude-opus-4-6',
    ]);
    expect(result.usage).toEqual({
      input_tokens: 30,
      cache_read_input_tokens: 0,
    });
    expect(result.usage_observation_counts.input_tokens).toBe(2);
    expect(result.usage_observation_counts.cache_read_input_tokens).toBe(1);
    expect(result.usage_observation_counts.output_tokens).toBe(0);
  });

  it('never turns missing or invalid usage into zero, or a bad model into a model', async () => {
    const run = await runActions([FILL, ENTER], {
      metadata: {
        model: 'private prompt\nsecret',
        usage: {
          input_tokens: true,
          output_tokens: -1,
          cache_creation_input_tokens: Number.NaN,
          cache_read_input_tokens: 1.5,
        },
      },
    });
    expect(run.result!.telemetry.usage).toEqual({});
    expect(run.result!.telemetry.response_models).toEqual([]);
    expect(
      new Set(Object.values(run.result!.telemetry.usage_observation_counts))
    ).toEqual(new Set([0]));
  });

  it('keeps a model name out of telemetry when it contains a secret', () => {
    const telemetry = new ComputerUseTelemetryRecorder(() => ['opus-4']);
    telemetry.observe({ model: 'claude-opus-4-6', content: [] });
    expect(telemetry.snapshot('complete').response_models).toEqual([]);
  });

  it("keeps the planner's own credential, such as an auth command's token, out of models", async () => {
    const executed: DesktopAction[] = [];
    const result = await runComputerUseLoop(
      {
        query: 'query',
        maxActions: 8,
        mode: 'submit',
        application: 'cowork',
        chatgptSurface: 'chatgpt-work',
        model: 'claude-sonnet-4-6',
        approveWriteTools: false,
        startDelayMs: 0,
        secrets: [],
      },
      {
        desktop: {
          checkPermissions: async () => undefined,
          launch: async () => undefined,
          openUrl: async () => undefined,
          newChatgptChat: async () => true,
          screenshot: async () => ({ ...IMAGE, source: { ...IMAGE.source } }),
          frontmostApp: async () => 'Claude',
          async execute(action) {
            executed.push(action);
            return { result: 'done', submitted: action.action === 'key' };
          },
        },
        planner: {
          prepare: async () => undefined,
          credentials: () => ['a1b2c3'],
          create: async () =>
            response([FILL, ENTER], { model: 'claude-a1b2c3' }),
        },
        sleep: async () => undefined,
        log: () => undefined,
        signal: new AbortController().signal,
      }
    );
    expect(result.telemetry.response_models).toEqual([]);
  });

  it('keeps only completed responses when a planner call fails', async () => {
    const run = await runActions([{ action: 'screenshot' }], {
      plannerError: new Error('provider failure'),
      metadata: {
        model: 'claude-sonnet-4-6',
        usage: { input_tokens: 12, output_tokens: 0 },
      },
    });
    expect(run.outcome).toBe('provider failure');
    expect(run.telemetry.planner_response_count).toBe(1);
    expect(run.telemetry.usage).toEqual({ input_tokens: 12, output_tokens: 0 });
    expect(run.telemetry.accounting).toBe('partial');
  });
});

describe('submission', () => {
  it('stops at the first submit even if the plan has more actions', async () => {
    const run = await runActions([FILL, ENTER, ENTER]);
    expect(run.result!.status).toBe('submitted');
    expect(run.executed).toHaveLength(2);
  });

  it('rejects Enter before the query', async () => {
    const run = await runActions([ENTER]);
    expect(run.outcome).toContain('exceeded');
    expect(run.executed).toEqual([]);
  });

  it('rejects clicking Send after typing', async () => {
    const run = await runActions([
      FILL,
      { action: 'left_click', coordinate: [5, 5] },
    ]);
    expect(run.outcome).toContain('budget exhausted');
    expect(run.executed).toHaveLength(1);
  });

  it('counts actions, not planner rounds, against the budget', async () => {
    const screenshots = Array.from({ length: 4 }, () => ({
      action: 'screenshot',
    }));
    const run = await runActions(screenshots, {
      budget: 2,
    });
    expect(run.outcome).toContain('budget exhausted');
    expect(run.executed).toHaveLength(2);
  });

  it('fills the original Unicode query and marker, not a model copy', async () => {
    const query =
      'From the ‘Quarterly Product Metrics’ document, what are monthly and weekly active users?\n\n[MCP_SERVER_TESTER_test-marker]';
    const run = await runActions([FILL, ENTER], { query });
    expect(run.result!.status).toBe('submitted');
    expect(run.executed[0]).toEqual({ action: 'type', text: query });
    expect(run.executed).toHaveLength(2);
    expect(toolNames(run.request)).toContain('fill_query');
  });

  it('refuses a typed query that drops the marker, and fills the original instead', async () => {
    const query = 'original query\n\n[MCP_SERVER_TESTER_marker]';
    const run = await runActions(
      [{ action: 'type', text: 'original query' }, ENTER],
      {
        plans: [[FILL, ENTER]],
        query,
      }
    );
    expect(run.result!.status).toBe('submitted');
    expect(run.executed).toHaveLength(2);
    expect(run.executed[0]!.text).toBe(query);
  });

  it('has no second keyboard effect from a duplicate fill', async () => {
    const run = await runActions([FILL, FILL, ENTER]);
    expect(run.result!.status).toBe('submitted');
    expect(run.executed).toHaveLength(2);
    expect(run.telemetry.action_count).toBe(3);
    expect(run.telemetry.refused_action_count).toBe(1);
    expect(run.telemetry.attempted_action_count).toBe(2);
    expect(run.telemetry.executed_action_count).toBe(2);
  });

  it("doesn't retry a keyboard failure", async () => {
    const run = await runActions([FILL, FILL, ENTER], { entryError: true });
    expect(run.outcome).toBe('uncertain keyboard failure');
    expect(run.executed).toHaveLength(1);
    expect(run.telemetry.attempted_action_count).toBe(1);
    expect(run.telemetry.executed_action_count).toBe(0);
    expect(run.telemetry.planner_response_count).toBe(1);
  });

  it('never acts once the deadline passes during the focus check', async () => {
    const deadline = new AbortController();
    const executed: DesktopAction[] = [];
    const error = await runComputerUseLoop(
      {
        query: 'query',
        maxActions: 8,
        mode: 'submit',
        application: 'cowork',
        chatgptSurface: 'chatgpt-work',
        model: 'claude-sonnet-4-6',
        approveWriteTools: false,
        startDelayMs: 0,
        secrets: [],
      },
      {
        desktop: {
          checkPermissions: async () => undefined,
          launch: async () => undefined,
          openUrl: async () => undefined,
          newChatgptChat: async () => true,
          screenshot: async () => ({ ...IMAGE, source: { ...IMAGE.source } }),
          async frontmostApp() {
            deadline.abort(new Error('deadline'));
            return 'Claude';
          },
          async execute(action) {
            executed.push(action);
            return { result: 'done', submitted: false };
          },
        },
        planner: {
          prepare: async () => undefined,
          create: async () => response([FILL, ENTER], {}),
        },
        sleep: async () => undefined,
        log: () => undefined,
        signal: deadline.signal,
      }
    ).catch((caught: unknown) => caught);
    expect((error as ComputerUseLoopError).aborted).toBe(true);
    expect(executed).toEqual([]);
  });

  it('stops before the next action once the deadline passes', async () => {
    const deadline = new AbortController();
    const executed: DesktopAction[] = [];
    const error = await runComputerUseLoop(
      {
        query: 'query',
        maxActions: 8,
        mode: 'submit',
        application: 'cowork',
        chatgptSurface: 'chatgpt-work',
        model: 'claude-sonnet-4-6',
        approveWriteTools: false,
        startDelayMs: 0,
        secrets: [],
      },
      {
        desktop: {
          checkPermissions: async () => undefined,
          launch: async () => undefined,
          openUrl: async () => undefined,
          newChatgptChat: async () => true,
          screenshot: async () => ({ ...IMAGE, source: { ...IMAGE.source } }),
          frontmostApp: async () => 'Claude',
          async execute(action) {
            executed.push(action);
            deadline.abort(new Error('deadline'));
            return { result: 'done', submitted: false };
          },
        },
        planner: {
          prepare: async () => undefined,
          create: async () =>
            response([{ action: 'mouse_move', coordinate: [1, 1] }, FILL], {}),
        },
        sleep: async () => undefined,
        log: () => undefined,
        signal: deadline.signal,
      }
    ).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ComputerUseLoopError);
    expect((error as ComputerUseLoopError).aborted).toBe(true);
    expect(executed).toHaveLength(1);
  });
});
