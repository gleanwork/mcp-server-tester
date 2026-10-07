/**
 * Characterization tests: the EvalCaseResult each execution path produces.
 *
 * These pin the runner's observable output (scores, `response`, evidence,
 * `toolCallTrace`, usage, errors, trial accounting) across the
 * case-execution refactor. A snapshot change here is a behaviour change and
 * must be deliberate.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import {
  runEvalCase,
  runEvalDataset,
  type EvalCaseOptions,
  type EvalContext,
} from './evalRunner.js';
import type { EvalCase } from './datasetTypes.js';
import type { MCPFixtureApi } from '../mcp/fixtures/mcpFixture.js';
import { createFixtureExtensions } from '../mcp/fixtures/fixtureExtensions.js';
import { simulateMstClient } from './mstClient/simulation.js';
import type * as SimulationModule from './mstClient/simulation.js';
import type * as JudgeClientModule from '../judge/judgeClient.js';
import { createJudge } from '../judge/judgeClient.js';
import type { JudgeConfig, JudgeResult } from '../judge/judgeTypes.js';
import type { MstClientSimulationResult } from './mstClient/types.js';
import { clientRunToExecution } from './clientTrace.js';
import type { ClientRunResult, JudgeDefinition } from './evalFrameworkTypes.js';
import { runEval } from './runEval.js';
import { installPlugins, resetPluginsForTests } from '../plugins/extensions.js';
import type { Plugin } from '../plugins/plugin.js';
import type { JudgeInput } from '../judge/judgeContract.js';

vi.mock('./mstClient/simulation.js', async (original) => ({
  ...(await original<typeof SimulationModule>()),
  simulateMstClient: vi.fn(),
}));
vi.mock('../judge/judgeClient.js', async (original) => ({
  ...(await original<typeof JudgeClientModule>()),
  createJudge: vi.fn(),
}));

/** Drop wall-clock and build-environment values; everything else is pinned. */
function stable(value: unknown): unknown {
  return JSON.parse(
    JSON.stringify(value, (key, nested: unknown) => {
      if (typeof nested !== 'number' && typeof nested !== 'string')
        return nested;
      if (/durationMs$|DurationMs$|^timestamp$|At$/.test(key)) return '<time>';
      if (key === 'gitHash' || key === 'packageVersion') return '<build>';
      return nested;
    })
  );
}

function mockMCP(
  callTool: MCPFixtureApi['callTool'] = vi.fn().mockResolvedValue({
    content: [{ type: 'text', text: 'sunny, 21C' }],
    isError: false,
  })
): MCPFixtureApi {
  return {
    client: {} as MCPFixtureApi['client'],
    authType: 'none',
    protocol: { requested: 'legacy', negotiated: '2025-11-25', era: 'legacy' },
    ...createFixtureExtensions({} as MCPFixtureApi['client']),
    request: vi.fn().mockResolvedValue({ skill: { name: 'weather' } }),
    project: 'golden',
    getServerInfo: vi.fn().mockReturnValue({ name: 'golden', version: '1' }),
    listTools: vi.fn().mockResolvedValue([]),
    callTool,
  };
}

function context(mcp: MCPFixtureApi = mockMCP()): EvalContext {
  return {
    mcp,
    testInfo: {
      attach: vi.fn().mockResolvedValue(undefined),
    } as unknown as EvalContext['testInfo'],
  };
}

const simulation: MstClientSimulationResult = {
  success: true,
  response: 'It is sunny in London.',
  toolCalls: [
    { name: 'get_weather', arguments: { city: 'London' }, output: 'sunny' },
    { name: 'search', arguments: { q: 'London' } },
  ],
  usage: { inputTokens: 100, outputTokens: 20, durationMs: 5 },
};

const clientCase: EvalCase = {
  id: 'client',
  input: 'Weather in London?',
  assertions: {
    containsText: 'sunny',
    toolsTriggered: {
      calls: [
        { name: 'get_weather', required: true },
        { name: 'forecast', required: true },
      ],
    },
    toolCallCount: { min: 1, max: 3 },
  },
};

const trace: ClientRunResult = {
  finalText: 'It is sunny in London.',
  events: [
    {
      kind: 'tool_call',
      source: 'mcp',
      server: 'weather',
      name: 'get_weather',
      arguments: { city: 'London' },
      output: 'sunny',
    },
    { kind: 'skill', source: 'builtin', name: 'forecasting' },
    { kind: 'tool_call', source: 'builtin', name: 'web_search' },
  ],
  usage: { inputTokens: 50, outputTokens: 10, durationMs: 3 },
  telemetry: { native: 'kept' },
  durationMs: 40,
};

/** Every call to the fake judges below, in order. */
const calls: unknown[][] = [];
const caseJudges: Record<string, JudgeDefinition> = {
  'golden-case-judge': {
    schema: z.object({}).passthrough(),
    evaluate: async ({ case: evalCase, trial }, options) => {
      calls.push([
        'golden-case-judge',
        trial.response,
        evalCase.expected.answer,
        options,
      ]);
      return { score: 0.9, reasoning: 'looks right' };
    },
  },
  'golden-strict-judge': {
    schema: z.object({}).passthrough(),
    evaluate: async ({ case: evalCase, trial }) => {
      calls.push([
        'golden-strict-judge',
        trial.response,
        evalCase.expected.answer,
      ]);
      return { score: 0.2, reasoning: 'too vague' };
    },
  },
};

/** The test plugin: the case judges plus any extra extensions, under `test/`. */
function goldenPlugin(
  extra: Pick<Plugin, 'datasetSources' | 'clients' | 'judges'> = {}
): Plugin {
  return {
    meta: { name: 'golden-test-plugin', namespace: 'test' },
    ...extra,
    judges: { ...caseJudges, ...extra.judges },
  };
}

afterEach(() => resetPluginsForTests());

beforeEach(() => {
  installPlugins([goldenPlugin()]);
  calls.length = 0;
  vi.mocked(simulateMstClient).mockReset().mockResolvedValue(simulation);
});

describe('golden: the mst client (dataset API)', () => {
  it('succeeds with tool evidence and a missed required tool', async () => {
    expect(stable(await runEvalCase(clientCase, context()))).toMatchSnapshot();
    expect(simulateMstClient).toHaveBeenCalledTimes(1);
  });

  it('maps native tool names through toolMap', async () => {
    const options: EvalCaseOptions = {
      toolMap: { forecast: ['search'] },
    };
    expect(
      stable(await runEvalCase(clientCase, context(), options))
    ).toMatchSnapshot();
  });

  it('simulation failure', async () => {
    vi.mocked(simulateMstClient).mockResolvedValue({
      success: false,
      toolCalls: [],
      error: 'provider rejected the request',
    });
    expect(stable(await runEvalCase(clientCase, context()))).toMatchSnapshot();
  });

  it('trials exclude infrastructure errors from the pass rate', async () => {
    vi.mocked(simulateMstClient)
      .mockResolvedValueOnce(simulation)
      .mockRejectedValueOnce(new Error('read ECONNRESET'))
      .mockResolvedValueOnce({ ...simulation, response: 'cloudy' });
    const result = await runEvalCase(
      { ...clientCase, trials: 3, passThreshold: 0.5 },
      context()
    );
    expect(stable(result)).toMatchSnapshot();
  });
});

describe('golden: client traces through executeCase', () => {
  const traceCase: EvalCase = {
    ...clientCase,
    id: 'trace',
    assertions: {
      containsText: 'sunny',
      toolsTriggered: {
        calls: [
          { name: 'weather.get_weather', required: true },
          { name: 'forecasting', kind: 'skill', required: true },
        ],
      },
      toolCallCount: { max: 1 },
    },
  };

  it.each(['structured', 'observed', 'none'] as const)(
    '%s evidence',
    async (evidence) => {
      const result = await runEvalCase(traceCase, context(), {
        executeCase: async () => ({
          ...clientRunToExecution(trace, evidence, [
            { transport: 'stdio', command: 'a', label: 'weather' },
            { transport: 'stdio', command: 'b', label: 'other' },
          ]),
          preExecutionDurationMs: trace.durationMs,
        }),
      });
      expect(stable(result)).toMatchSnapshot();
    }
  );

  it('client trace error', async () => {
    const result = await runEvalCase(traceCase, context(), {
      executeCase: async () =>
        clientRunToExecution(
          { ...trace, error: 'native session missing' },
          'structured'
        ),
    });
    expect(stable(result)).toMatchSnapshot();
  });

  it('executeCase that throws', async () => {
    const result = await runEvalCase(traceCase, context(), {
      executeCase: async () => {
        throw new Error('client crashed');
      },
    });
    expect(stable(result)).toMatchSnapshot();
  });
});

describe('golden: dataset aggregation', () => {
  it('two cases, one failing', async () => {
    const result = await runEvalDataset(
      {
        dataset: {
          name: 'mixed',
          cases: [
            {
              id: 'd',
              input: 'Is it sunny in London?',
              assertions: { containsText: 'sunny' },
            },
            clientCase,
          ],
        },
      },
      context()
    );
    const { caseResults, ...summary } = result;
    expect(stable({ summary, caseResults })).toMatchSnapshot();
  });
});

describe('golden: runEval clients', () => {
  const dirs: string[] = [];
  afterEach(async () => {
    await Promise.all(
      dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true }))
    );
  });

  async function evalRun(
    kind: 'run' | 'runBatch',
    variant = '',
    configExtra: Record<string, unknown> = {},
    cases: EvalCase[] = [
      {
        id: 'suite-host',
        input: 'Weather in London?',
        assertions: {
          containsText: 'sunny',
          toolsTriggered: {
            calls: [{ name: 'get_weather', required: true }],
          },
        },
      },
    ],
    judges: Record<string, JudgeDefinition> = {}
  ) {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'golden-suite-'));
    dirs.push(dir);
    const clientName = `golden-${kind}${variant}-host`;
    const sourceName = `golden-${kind}${variant}-source`;
    const type = `test/${clientName}`;
    const source = `test/${sourceName}`;
    const plugin = goldenPlugin({
      judges,
      clients: {
        [clientName]: {
          schema: z.object({ type: z.string() }).passthrough(),
          evidence: 'structured',
          ...(kind === 'run'
            ? { run: async () => trace }
            : {
                runBatch: async (requests) =>
                  requests.map(() => ({ ...trace })),
              }),
        },
      },
      datasetSources: {
        [sourceName]: {
          schema: z.object({ type: z.string() }),
          load: async () => ({ name: 'golden', cases }),
        },
      },
    });
    // The eval installs its own copy of the test plugin, with this client.
    resetPluginsForTests();
    const configPath = path.join(dir, 'eval.json');
    await fs.writeFile(
      configPath,
      JSON.stringify({
        name: 'golden',
        datasets: [{ type: source }],
        client: type,
        servers: [],
        ...configExtra,
      })
    );
    return runEval({ configPath, outputDir: dir, plugins: [plugin] });
  }

  it.each(['run', 'runBatch'] as const)('%s client', async (kind) => {
    const result = await evalRun(kind);
    expect(stable(result.summary.results)).toMatchSnapshot();
  });

  it('eval config judges merge with case judges', async () => {
    const evaluate = vi.fn(
      async (input: JudgeInput, _options: Record<string, unknown>) => ({
        // As before: the response object, not its text, so it scores 0.
        score: String(input.trial.response).includes('sunny') ? 1 : 0,
        reasoning: 'eval config judge',
      })
    );
    const result = await evalRun(
      'run',
      '-judged',
      {
        judges: [
          {
            type: 'test/golden-config-judge',
            reference: 'eval ref',
            count: 2,
          },
        ],
      },
      [
        {
          id: 'suite-judged',
          input: 'Weather in London?',
          expected: { answer: 'canonical' },
          assertions: {
            passesJudge: [
              {
                judge: 'test/golden-config-judge',
                reference: 'case ref',
                options: { count: 3 },
              },
              { judge: 'test/golden-case-judge', threshold: 0.5 },
            ],
          },
        },
      ],
      {
        'golden-config-judge': {
          schema: z.object({}).passthrough(),
          evaluate,
        },
      }
    );
    const input = evaluate.mock.calls[0]![0];
    expect(input.case).toMatchObject({
      id: 'suite-judged',
      input: { prompt: 'Weather in London?' },
    });
    expect(input.trial.text).toContain('sunny');
    // The judge calls, in the (candidate, reference, options) shape the snapshot pins.
    expect(
      stable({
        results: result.summary.results,
        configJudgeCalls: evaluate.mock.calls.map(([call, options]) => [
          call.trial.response,
          call.case.expected.answer,
          options,
        ]),
        caseJudgeCalls: calls,
      })
    ).toMatchSnapshot();
  });
  it('an eval config declares two rubric judges and a case overrides one', async () => {
    calls.length = 0;
    vi.mocked(createJudge).mockReset();
    // correctness scores 0.6 against the case's 0.9; conciseness 0.8 against 0.7.
    scriptLLMJudge([
      { score: 0.6, reasoning: 'Says sunny.' },
      { score: 0.8, reasoning: 'Short.' },
    ]);
    const result = await evalRun(
      'run',
      '-rubric',
      {
        judges: [
          { type: 'rubric', rubric: 'correctness', threshold: 0.5 },
          { type: 'rubric', rubric: 'conciseness' },
        ],
      },
      [
        {
          id: 'suite-rubric',
          input: 'Weather in London?',
          assertions: {
            passesJudge: { rubric: 'correctness', threshold: 0.9 },
          },
        },
      ]
    );
    expect(
      stable({ results: result.summary.results, calls })
    ).toMatchSnapshot();
  });
});

describe('golden: judges', () => {
  beforeEach(() => {
    calls.length = 0;
  });

  it('one judge with case reps and the canonical answer as reference', async () => {
    const result = await runEvalCase(
      {
        id: 'judged',
        input: 'Weather in London?',
        judgeReps: 2,
        expected: { answer: 'sunny' },
        assertions: { passesJudge: { judge: 'test/golden-case-judge' } },
      },
      context()
    );
    expect(stable({ result, calls })).toMatchSnapshot();
  });

  it('several judges, one failing, with an explicit reference and reps', async () => {
    const result = await runEvalCase(
      {
        id: 'multi-judged',
        input: 'Weather in London?',
        judgeReps: 3,
        expected: { answer: 'unused' },
        assertions: {
          passesJudge: [
            { judge: 'test/golden-case-judge', reference: 'explicit', reps: 1 },
            { judge: 'test/golden-strict-judge', threshold: 0.5 },
          ],
        },
      },
      context()
    );
    expect(stable({ result, calls })).toMatchSnapshot();
  });

  it('judges a client response', async () => {
    const result = await runEvalCase(
      {
        ...clientCase,
        id: 'host-judged',
        assertions: { passesJudge: { judge: 'test/golden-case-judge' } },
      },
      context()
    );
    expect(stable({ result, calls })).toMatchSnapshot();
  });
});

/**
 * A fake LLM judge client: each evaluate() returns the next scripted result
 * (or throws it), and every createJudge config and evaluate call is recorded.
 */
function scriptLLMJudge(results: Array<Partial<JudgeResult> | Error>): void {
  let next = 0;
  vi.mocked(createJudge).mockImplementation((config?: JudgeConfig) => {
    calls.push(['createJudge', config ?? {}]);
    return {
      async evaluate(candidate, reference, rubric) {
        // The built-in rubric texts are long; their first line identifies them.
        calls.push([
          'llm.evaluate',
          candidate,
          reference,
          rubric.split('\n')[0],
        ]);
        const scripted = results[next++] ?? new Error('no scripted result');
        if (scripted instanceof Error) throw scripted;
        return { pass: true, ...scripted };
      },
    };
  });
}

describe('golden: rubric judges', () => {
  beforeEach(() => {
    calls.length = 0;
    vi.mocked(createJudge).mockReset();
  });

  it('a built-in rubric with the default provider and the canonical answer', async () => {
    scriptLLMJudge([{ score: 0.8, reasoning: 'Accurate.' }]);
    const result = await runEvalCase(
      {
        id: 'rubric-judged',
        input: 'Weather in London?',
        expected: { answer: 'sunny' },
        assertions: { passesJudge: { rubric: 'correctness' } },
      },
      context()
    );
    expect(stable({ result, calls })).toMatchSnapshot();
  });

  it('reps average the scores and report their spread', async () => {
    scriptLLMJudge([
      { score: 0.2, reasoning: 'first' },
      { score: 0.9, reasoning: 'second' },
      { score: 0.5, reasoning: 'third' },
    ]);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const result = await runEvalCase(
      {
        id: 'rubric-reps',
        input: 'Weather in London?',
        assertions: { passesJudge: { rubric: 'completeness', reps: 3 } },
      },
      context()
    );
    warn.mockRestore();
    expect(stable({ result, calls })).toMatchSnapshot();
  });

  it('a custom-text rubric with provider, model, LLM options and a failing threshold', async () => {
    scriptLLMJudge([{ score: 0.6, reasoning: 'Partly.' }]);
    const result = await runEvalCase(
      {
        id: 'rubric-custom',
        input: 'Weather in London?',
        assertions: {
          passesJudge: {
            rubric: { text: 'Does it say it is sunny?\nAnswer carefully.' },
            reference: 'It is sunny.',
            threshold: 0.9,
            provider: 'openai',
            model: 'gpt-test',
            apiKeyEnvVar: 'TEST_KEY',
            maxTokens: 64,
            temperature: 0.5,
            maxToolOutputSize: 1000,
          },
        },
      },
      context()
    );
    expect(stable({ result, calls })).toMatchSnapshot();
  });

  it('a judge client error fails the assertion', async () => {
    scriptLLMJudge([new Error('rate limited')]);
    const result = await runEvalCase(
      {
        id: 'rubric-error',
        input: 'Weather in London?',
        assertions: { passesJudge: { rubric: 'correctness' } },
      },
      context()
    );
    expect(stable({ result, calls })).toMatchSnapshot();
  });

  it('a rubric judge and a plugin judge under case-level judgeReps', async () => {
    scriptLLMJudge([{ score: 0.7 }, { score: 0.9 }]);
    const result = await runEvalCase(
      {
        id: 'rubric-and-plugin',
        input: 'Weather in London?',
        judgeReps: 2,
        assertions: {
          passesJudge: [
            { rubric: 'conciseness' },
            { judge: 'test/golden-case-judge' },
          ],
        },
      },
      context()
    );
    expect(stable({ result, calls })).toMatchSnapshot();
  });
});
