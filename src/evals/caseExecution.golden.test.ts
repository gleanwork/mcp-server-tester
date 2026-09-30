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
import type { MCPHostSimulationResult } from './mcpHost/mcpHostTypes.js';
import { runExternalHostScenario } from './externalHost/runtime.js';
import type {
  ExternalHostMetadata,
  ExternalHostRunResult,
} from './externalHost/types.js';
import { hostTraceToExecution } from './hostTrace.js';
import type { HostRunResult } from './evalFrameworkTypes.js';
import { registerDatasetSource, registerHost } from './frameworkRegistries.js';
import { runEvalSuite } from './runEvalSuite.js';

vi.mock('./mcpHost/mcpHostSimulation.js', async (original) => ({
  ...(await original<typeof SimulationModule>()),
  simulateMCPHost: vi.fn(),
}));
vi.mock('./externalHost/runtime.js', async (original) => ({
  ...(await original<typeof RuntimeModule>()),
  runExternalHostScenario: vi.fn(),
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

beforeEach(() => {
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

  async function suite(kind: 'run' | 'runBatch') {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'golden-suite-'));
    dirs.push(dir);
    const type = `golden-${kind}-host`;
    const source = `golden-${kind}-source`;
    const cases: EvalCase[] = [
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
    ];
    registerHost({
      name: type,
      schema: z.object({ type: z.string() }).passthrough(),
      evidence: 'structured',
      ...(kind === 'run'
        ? { run: async () => trace }
        : {
            runBatch: async (requests) => requests.map(() => ({ ...trace })),
          }),
    });
    registerDatasetSource({
      name: source,
      schema: z.object({ type: z.string() }),
      load: async () => ({ name: 'golden', cases }),
    });
    const manifestPath = path.join(dir, 'manifest.json');
    await fs.writeFile(
      manifestPath,
      JSON.stringify({
        name: 'golden',
        datasets: [{ type: source }],
        host: { type },
        servers: [],
      })
    );
    return runEvalSuite({ manifestPath, outputDir: dir });
  }

  it.each(['run', 'runBatch'] as const)('%s host', async (kind) => {
    const result = await suite(kind);
    expect(stable(result.summary.results)).toMatchSnapshot();
  });
});
