/**
 * Characterization tests: the EvalCaseResult each execution path produces.
 *
 * These pin the runner's observable output (verdicts, `response`, evidence,
 * `mcpHostTrace`, usage, errors, iteration accounting) across the
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
import { simulateMCPHost } from './mcpHost/mcpHostSimulation.js';
import type * as SimulationModule from './mcpHost/mcpHostSimulation.js';
import type * as RuntimeModule from './externalHost/runtime.js';
import type * as JudgeClientModule from '../judge/judgeClient.js';
import { createJudge } from '../judge/judgeClient.js';
import type { JudgeConfig, JudgeResult } from '../judge/judgeTypes.js';
import type { MCPHostSimulationResult } from './mcpHost/mcpHostTypes.js';
import { runExternalHostScenario } from './externalHost/runtime.js';
import type {
  ExternalHostMetadata,
  ExternalHostRunResult,
} from './externalHost/types.js';
import { hostTraceToExecution } from './hostTrace.js';
import type { HostRunResult, JudgeDefinition } from './evalFrameworkTypes.js';
import { runEvalSuite } from './runEvalSuite.js';
import { installPlugins, resetPluginsForTests } from '../plugins/extensions.js';
import type { Plugin } from '../plugins/plugin.js';
import type { JudgeInput } from '../judge/judgeContract.js';

vi.mock('./mcpHost/mcpHostSimulation.js', async (original) => ({
  ...(await original<typeof SimulationModule>()),
  simulateMCPHost: vi.fn(),
}));
vi.mock('./externalHost/runtime.js', async (original) => ({
  ...(await original<typeof RuntimeModule>()),
  runExternalHostScenario: vi.fn(),
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

const simulation: MCPHostSimulationResult = {
  success: true,
  response: 'It is sunny in London.',
  toolCalls: [
    { name: 'get_weather', arguments: { city: 'London' }, output: 'sunny' },
    { name: 'search', arguments: { q: 'London' } },
  ],
  usage: { inputTokens: 100, outputTokens: 20, durationMs: 5 },
};

const hostCase: EvalCase = {
  id: 'host',
  mode: 'mcp_host',
  scenario: 'Weather in London?',
  mcpHostConfig: { provider: 'anthropic' },
  expect: {
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

function externalMetadata(
  overrides: Partial<ExternalHostMetadata> = {}
): ExternalHostMetadata {
  return {
    driver: {
      provider: 'openai',
      product: 'chatgpt',
      surface: 'agent',
      runtime: 'desktop-app',
      platform: 'macos',
    },
    driverSlug: 'openai.chatgpt.agent.desktop-app.macos',
    displayName: 'ChatGPT',
    hostName: 'ChatGPT',
    hostType: 'desktop',
    capabilitiesUsed: [],
    traceSource: 'host-local-transcript',
    traceConfidence: 'high',
    artifacts: [],
    session: { id: 'session', turnId: 'turn' },
    correlation: { strategy: 'exact_prompt', includedInPrompt: false },
    ...overrides,
  } as ExternalHostMetadata;
}

function externalResult(metadata: ExternalHostMetadata): ExternalHostRunResult {
  return {
    ...simulation,
    externalHost: metadata,
  } as ExternalHostRunResult;
}

const trace: HostRunResult = {
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
    { kind: 'skill', source: 'host', name: 'forecasting' },
    { kind: 'tool_call', source: 'host', name: 'web_search' },
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
  extra: Pick<Plugin, 'datasetSources' | 'hosts' | 'judges'> = {}
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
  vi.mocked(simulateMCPHost).mockReset().mockResolvedValue(simulation);
  vi.mocked(runExternalHostScenario).mockReset();
});

describe('golden: direct execution', () => {
  it('tool call', async () => {
    const result = await runEvalCase(
      {
        id: 'tool',
        toolName: 'get_weather',
        args: { city: 'London' },
        expect: { containsText: 'sunny', isError: false },
      },
      context()
    );
    expect(stable(result)).toMatchSnapshot();
  });

  it('tool error result', async () => {
    const result = await runEvalCase(
      {
        id: 'tool-error',
        toolName: 'get_weather',
        args: {},
        expect: { isError: 'city' },
      },
      context(
        mockMCP(
          vi.fn().mockResolvedValue({
            content: [{ type: 'text', text: 'city is required' }],
            isError: true,
          })
        )
      )
    );
    expect(stable(result)).toMatchSnapshot();
  });

  it('tool call that throws', async () => {
    const result = await runEvalCase(
      { id: 'tool-throws', toolName: 'get_weather', args: {} },
      context(mockMCP(vi.fn().mockRejectedValue(new Error('socket closed'))))
    );
    expect(stable(result)).toMatchSnapshot();
  });

  it('request', async () => {
    const result = await runEvalCase(
      {
        id: 'request',
        request: { method: 'skills/get', params: { name: 'weather' } },
        expect: { containsText: 'weather' },
      },
      context()
    );
    expect(stable(result)).toMatchSnapshot();
  });

  it('tool result shaped like a host simulation', async () => {
    // Legacy tests fake mcp_host this way; pin what the runner does with it.
    const result = await runEvalCase(
      {
        id: 'simulation-shaped',
        toolName: 'fake_host',
        args: {},
        expect: {
          toolsTriggered: { calls: [{ name: 'get_weather', required: true }] },
        },
      },
      context(
        mockMCP(
          vi.fn().mockResolvedValue(simulation as unknown as never) as never
        )
      )
    );
    expect(stable(result)).toMatchSnapshot();
  });
});

describe('golden: simulated mcp_host (dataset API)', () => {
  it('succeeds with tool evidence and a missed required tool', async () => {
    expect(stable(await runEvalCase(hostCase, context()))).toMatchSnapshot();
    expect(simulateMCPHost).toHaveBeenCalledTimes(1);
  });

  it('maps native tool names through toolMap', async () => {
    const options: EvalCaseOptions = {
      toolMap: { forecast: ['search'] },
    };
    expect(
      stable(await runEvalCase(hostCase, context(), options))
    ).toMatchSnapshot();
  });

  it('simulation failure', async () => {
    vi.mocked(simulateMCPHost).mockResolvedValue({
      success: false,
      toolCalls: [],
      error: 'provider rejected the request',
    });
    expect(stable(await runEvalCase(hostCase, context()))).toMatchSnapshot();
  });

  it('iterations exclude infrastructure errors from accuracy', async () => {
    vi.mocked(simulateMCPHost)
      .mockResolvedValueOnce(simulation)
      .mockRejectedValueOnce(new Error('read ECONNRESET'))
      .mockResolvedValueOnce({ ...simulation, response: 'cloudy' });
    const result = await runEvalCase(
      { ...hostCase, iterations: 3, accuracyThreshold: 0.5 },
      context()
    );
    expect(stable(result)).toMatchSnapshot();
  });
});

describe('golden: external_host', () => {
  it('high-confidence native trace', async () => {
    vi.mocked(runExternalHostScenario).mockResolvedValue(
      externalResult(externalMetadata())
    );
    const result = await runEvalCase(
      {
        ...hostCase,
        id: 'external',
        mode: 'external_host',
        mcpHostConfig: undefined,
        externalHost: { driver: 'openai.chatgpt.agent.desktop-app.macos' },
      } as EvalCase,
      context()
    );
    expect(stable(result)).toMatchSnapshot();
  });

  it('low-confidence trace cannot support tool assertions', async () => {
    vi.mocked(runExternalHostScenario).mockResolvedValue(
      externalResult(
        externalMetadata({ traceSource: 'screenshot', traceConfidence: 'low' })
      )
    );
    const result = await runEvalCase(
      {
        ...hostCase,
        id: 'external-low',
        mode: 'external_host',
        mcpHostConfig: undefined,
        externalHost: { driver: 'openai.chatgpt.agent.desktop-app.macos' },
      } as EvalCase,
      context()
    );
    expect(stable(result)).toMatchSnapshot();
  });
});

describe('golden: host traces through executeCase', () => {
  const traceCase: EvalCase = {
    ...hostCase,
    id: 'trace',
    expect: {
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
          ...hostTraceToExecution(trace, evidence, [
            { transport: 'stdio', command: 'a', label: 'weather' },
            { transport: 'stdio', command: 'b', label: 'other' },
          ]),
          preExecutionDurationMs: trace.durationMs,
        }),
      });
      expect(stable(result)).toMatchSnapshot();
    }
  );

  it('host trace error', async () => {
    const result = await runEvalCase(traceCase, context(), {
      executeCase: async () =>
        hostTraceToExecution(
          { ...trace, error: 'native session missing' },
          'structured'
        ),
    });
    expect(stable(result)).toMatchSnapshot();
  });

  it('executeCase that throws', async () => {
    const result = await runEvalCase(traceCase, context(), {
      executeCase: async () => {
        throw new Error('host crashed');
      },
    });
    expect(stable(result)).toMatchSnapshot();
  });
});

describe('golden: dataset aggregation', () => {
  it('mixed direct and host cases', async () => {
    const result = await runEvalDataset(
      {
        dataset: {
          name: 'mixed',
          cases: [
            {
              id: 'd',
              toolName: 'get_weather',
              args: { city: 'London' },
              expect: { containsText: 'sunny' },
            },
            hostCase,
          ],
        },
      },
      context()
    );
    const { caseResults, ...summary } = result;
    expect(stable({ summary, caseResults })).toMatchSnapshot();
  });
});

describe('golden: runEvalSuite hosts', () => {
  const dirs: string[] = [];
  afterEach(async () => {
    await Promise.all(
      dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true }))
    );
  });

  async function suite(
    kind: 'run' | 'runBatch',
    variant = '',
    manifestExtra: Record<string, unknown> = {},
    cases: EvalCase[] = [
      {
        id: 'suite-host',
        mode: 'mcp_host',
        scenario: 'Weather in London?',
        expect: {
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
    const hostName = `golden-${kind}${variant}-host`;
    const sourceName = `golden-${kind}${variant}-source`;
    const type = `test/${hostName}`;
    const source = `test/${sourceName}`;
    const plugin = goldenPlugin({
      judges,
      hosts: {
        [hostName]: {
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
    // The suite installs its own copy of the test plugin, with this host.
    resetPluginsForTests();
    const manifestPath = path.join(dir, 'manifest.json');
    await fs.writeFile(
      manifestPath,
      JSON.stringify({
        name: 'golden',
        datasets: [{ type: source }],
        host: { type },
        servers: [],
        ...manifestExtra,
      })
    );
    return runEvalSuite({ manifestPath, outputDir: dir, plugins: [plugin] });
  }

  it.each(['run', 'runBatch'] as const)('%s host', async (kind) => {
    const result = await suite(kind);
    expect(stable(result.summary.results)).toMatchSnapshot();
  });

  it('manifest judges merge with case judges', async () => {
    const evaluate = vi.fn(
      async (input: JudgeInput, _options: Record<string, unknown>) => ({
        // As before: the response object, not its text, so it scores 0.
        score: String(input.trial.response).includes('sunny') ? 1 : 0,
        reasoning: 'manifest judge',
      })
    );
    const result = await suite(
      'run',
      '-judged',
      {
        judges: [
          {
            type: 'test/golden-manifest-judge',
            reference: 'suite ref',
            count: 2,
          },
        ],
      },
      [
        {
          id: 'suite-judged',
          mode: 'mcp_host',
          scenario: 'Weather in London?',
          canonicalAnswer: 'canonical',
          expect: {
            passesJudge: [
              {
                judge: 'test/golden-manifest-judge',
                reference: 'case ref',
                options: { count: 3 },
              },
              { judge: 'test/golden-case-judge', threshold: 0.5 },
            ],
          },
        },
      ],
      {
        'golden-manifest-judge': {
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
        manifestJudgeCalls: evaluate.mock.calls.map(([call, options]) => [
          call.trial.response,
          call.case.expected.answer,
          options,
        ]),
        caseJudgeCalls: calls,
      })
    ).toMatchSnapshot();
  });
  it('a manifest declares two rubric judges and a case overrides one', async () => {
    calls.length = 0;
    vi.mocked(createJudge).mockReset();
    // correctness scores 0.6 against the case's 0.9; conciseness 0.8 against 0.7.
    scriptLLMJudge([
      { score: 0.6, reasoning: 'Says sunny.' },
      { score: 0.8, reasoning: 'Short.' },
    ]);
    const result = await suite(
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
          mode: 'mcp_host',
          scenario: 'Weather in London?',
          expect: { passesJudge: { rubric: 'correctness', threshold: 0.9 } },
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
        toolName: 'get_weather',
        args: { city: 'London' },
        judgeReps: 2,
        canonicalAnswer: 'sunny',
        expect: { passesJudge: { judge: 'test/golden-case-judge' } },
      },
      context()
    );
    expect(stable({ result, calls })).toMatchSnapshot();
  });

  it('several judges, one failing, with an explicit reference and reps', async () => {
    const result = await runEvalCase(
      {
        id: 'multi-judged',
        toolName: 'get_weather',
        args: { city: 'London' },
        judgeReps: 3,
        canonicalAnswer: 'unused',
        expect: {
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

  it('judges a host response', async () => {
    const result = await runEvalCase(
      {
        ...hostCase,
        id: 'host-judged',
        expect: { passesJudge: { judge: 'test/golden-case-judge' } },
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
        toolName: 'get_weather',
        args: { city: 'London' },
        canonicalAnswer: 'sunny',
        expect: { passesJudge: { rubric: 'correctness' } },
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
        toolName: 'get_weather',
        args: { city: 'London' },
        expect: { passesJudge: { rubric: 'completeness', reps: 3 } },
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
        toolName: 'get_weather',
        args: { city: 'London' },
        expect: {
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

  it('a judge client error fails the expectation', async () => {
    scriptLLMJudge([new Error('rate limited')]);
    const result = await runEvalCase(
      {
        id: 'rubric-error',
        toolName: 'get_weather',
        args: { city: 'London' },
        expect: { passesJudge: { rubric: 'correctness' } },
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
        toolName: 'get_weather',
        args: { city: 'London' },
        judgeReps: 2,
        expect: {
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
