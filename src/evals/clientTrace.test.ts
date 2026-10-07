import { describe, expect, it } from 'vitest';
import { clientRunToExecution, simulationToClientRun } from './clientTrace.js';
import { runEvalDataset } from './evalRunner.js';
import type { ClientDefinition, TraceEvidence } from './evalFrameworkTypes.js';
import { z } from 'zod';

describe('clientRunToExecution', () => {
  it('names the replacement for a trace event with source host', () => {
    expect(() =>
      clientRunToExecution(
        {
          finalText: '',
          events: [
            { kind: 'tool_call', source: 'host' as 'builtin', name: 'Bash' },
          ],
        },
        'structured'
      )
    ).toThrow("it is now `source: 'builtin'`");
  });
});

describe('per-scenario client traces', () => {
  it('retains tool-result evidence and error status through both adapters', () => {
    const toolCalls = [
      {
        name: 'search',
        rawName: 'mcp__acme__search',
        arguments: {},
        source: 'mcp' as const,
        server: 'acme',
        id: 'call-1',
        output: '',
        isError: true,
      },
      { name: 'Read', arguments: {}, source: 'builtin' as const, id: 'call-2' },
    ];
    const trace = simulationToClientRun({ success: true, toolCalls }, []);
    expect(trace.events[0]).toMatchObject(toolCalls[0]!);
    expect(trace.events[1]).not.toHaveProperty('isError');
    const execution = clientRunToExecution(trace, 'structured');
    expect(execution.response).toMatchObject({ toolCalls });
    expect(execution.preExecutionDurationMs).toBeUndefined();
  });
  it('retains failure diagnostics together with native telemetry, usage, and timing', async () => {
    const diagnostics = { failureKind: 'timeout' as const };
    const usage = {
      inputTokens: 10,
      outputTokens: 2,
      totalCostUsd: 0.01,
      durationMs: 200,
    };
    const telemetry = { source: 'claude-native', models: ['test-model'] };
    const execution = clientRunToExecution(
      {
        ...simulationToClientRun(
          {
            success: false,
            error: 'Client timed out',
            response: 'partial answer',
            toolCalls: [],
            diagnostics,
            usage,
          },
          []
        ),
        telemetry,
        llmDurationMs: 123,
      },
      'structured'
    );
    expect(execution).toMatchObject({
      kind: 'completed',
      error: 'Client timed out',
      usage,
      telemetry,
      diagnostics,
      response: {
        success: false,
        diagnostics,
        telemetry,
        usage,
        llmDurationMs: 123,
      },
    });
    const result = await runEvalDataset(
      {
        dataset: {
          name: 'combined-evidence',
          cases: [{ id: 'one', input: 'query' }],
        },
        executeCase: async () => execution,
      },
      {}
    );
    expect(result.caseResults[0]).toMatchObject({
      pass: false,
      clientDiagnostics: diagnostics,
      clientUsage: usage,
      clientTelemetry: telemetry,
      response: { diagnostics, telemetry, llmDurationMs: 123 },
    });
  });
  it('preserves explicit native and MCP provenance regardless of server count', () => {
    const result = simulationToClientRun(
      {
        success: true,
        toolCalls: [
          { name: 'Bash', arguments: {}, source: 'builtin' },
          { name: 'search', arguments: {}, source: 'mcp', server: 'a' },
          { name: 'search', arguments: {}, source: 'mcp', server: 'b' },
        ],
      },
      [{ transport: 'http', serverUrl: 'https://example.com', label: 'a' }]
    );
    expect(
      result.events.map(({ name, source, server }) => ({
        name,
        source,
        server,
      }))
    ).toEqual([
      { name: 'Bash', source: 'builtin', server: undefined },
      { name: 'search', source: 'mcp', server: 'a' },
      { name: 'search', source: 'mcp', server: 'b' },
    ]);
  });
  it.each(['agg.native_search', 'native_search'])(
    'maps one-server alias %s while preserving event identity and original evidence',
    async (alias) => {
      const servers = [
        {
          transport: 'http' as const,
          serverUrl: 'https://example.com',
          label: 'agg',
        },
      ];
      const trace = simulationToClientRun(
        {
          success: true,
          response: 'OK',
          toolCalls: [{ name: 'native_search', arguments: { query: 'docs' } }],
        },
        servers
      );
      trace.events.unshift({
        kind: 'skill',
        source: 'builtin',
        name: 'research',
      });
      const result = await runEvalDataset(
        {
          dataset: {
            name: 'aliases',
            cases: [
              {
                id: 'one',
                input: 'research',
                assertions: {
                  toolsTriggered: {
                    calls: [
                      { name: 'research', kind: 'skill', source: 'builtin' },
                      {
                        name: 'search',
                        source: 'mcp',
                        server: 'agg',
                        arguments: { query: 'docs' },
                      },
                    ],
                    order: 'strict',
                    exclusive: true,
                  },
                  toolCallCount: { exact: 1 },
                },
              },
            ],
          },
          toolMap: { search: [alias] },
          executeCase: async () =>
            clientRunToExecution(trace, 'structured', servers),
        },
        {}
      );
      expect(result.passed).toBe(1);
      expect(result.datasetToolPrecision).toBe(1);
      expect(result.datasetToolRecall).toBe(1);
      expect(result.caseResults[0]?.response).toMatchObject({
        evidence: 'structured',
        events: [
          { kind: 'skill', name: 'research' },
          { name: 'native_search', server: 'agg' },
        ],
      });
      expect(trace.events[1]?.name).toBe('native_search');
      expect(result.caseResults[0]?.toolCallTrace).toMatchObject({
        calls: [{ name: 'native_search', status: 'expected' }],
        missed: [],
      });
    }
  );

  it('gates envelope-only evidence and exposes it in the case response', async () => {
    const result = await runEvalDataset(
      {
        dataset: {
          name: 'envelope',
          cases: [
            {
              id: 'one',
              input: 'search',
              assertions: { toolsTriggered: { calls: [{ name: 'search' }] } },
            },
          ],
        },
        executeCase: async () => ({
          kind: 'completed',
          response: {
            success: true,
            toolCalls: [{ name: 'search', arguments: {} }],
          },
          evidence: 'observed',
        }),
      },
      {}
    );
    expect(result.passed).toBe(0);
    expect(result.datasetToolPrecision).toBeUndefined();
    expect(result.datasetToolRecall).toBeUndefined();
    expect(result.caseResults[0]?.response).toMatchObject({
      evidence: 'observed',
    });
    expect(result.caseResults[0]?.toolCallTrace).toBeUndefined();
    // An executor that returns only a response still gets a trace.
    expect(result.caseResults[0]?.trace).toEqual({
      events: [
        { kind: 'tool_call', source: 'mcp', name: 'search', arguments: {} },
      ],
      evidence: 'observed',
    });
  });
  it.each<TraceEvidence>(['structured', 'observed', 'none'])(
    'gates tool assertions for %s evidence',
    async (evidence) => {
      const client: ClientDefinition = {
        schema: z.object({}),
        evidence,
        async run(input) {
          return {
            finalText: input.prompt,
            events: [
              {
                kind: 'tool_call',
                source: 'builtin',
                name: 'search',
                arguments: { query: 'right' },
              },
            ],
          };
        },
      };
      const result = await runEvalDataset(
        {
          dataset: {
            name: 'traces',
            cases: [
              {
                id: 'one',
                input: 'EXPECTED',
                trials: 3,
                assertions: {
                  containsText: 'EXPECTED',
                  toolsTriggered: {
                    calls: [{ name: 'search', arguments: { query: 'right' } }],
                  },
                },
              },
            ],
          },
          executeCase: async (evalCase) =>
            clientRunToExecution(
              await client.run!(
                { prompt: evalCase.input, servers: [] },
                { type: 'scenario-only' },
                { evalConfig: { name: 'test', datasets: [] } }
              ),
              evidence
            ),
        },
        {}
      );
      expect(result.caseResults[0]?.trialResults).toHaveLength(3);
      expect(result.passed).toBe(evidence === 'structured' ? 1 : 0);
      const verifiedMetric = evidence === 'structured' ? 1 : undefined;
      expect(result.datasetToolPrecision).toBe(verifiedMetric);
      expect(result.datasetToolRecall).toBe(verifiedMetric);
      expect(result.caseResults[0]?.toolPrecision).toBe(verifiedMetric);
      expect(result.caseResults[0]?.toolRecall).toBe(verifiedMetric);
      expect(result.caseResults[0]?.response).toMatchObject({ evidence });
      if (evidence !== 'structured') {
        for (const trial of result.caseResults[0]?.trialResults ?? []) {
          expect(trial.toolCallTrace).toBeUndefined();
        }
      }
      expect(result.caseResults[0]?.scores?.textContains?.pass).toBe(true);
    }
  );
  it('retains server labels and non-tool events without requiring them in single-server assertions', () => {
    const servers = [
      {
        transport: 'http' as const,
        serverUrl: 'https://example.com',
        label: 'acme',
      },
    ];
    const trace = simulationToClientRun(
      {
        success: true,
        response: 'OK',
        toolCalls: [{ name: 'search', arguments: {} }],
      },
      servers
    );
    expect(trace.events[0]).toMatchObject({
      source: 'mcp',
      server: 'acme',
      name: 'search',
    });
    trace.events.push({ kind: 'skill', source: 'builtin', name: 'research' });
    const result = clientRunToExecution(trace, 'structured', servers);
    expect(result.response).toMatchObject({
      toolCalls: [
        { name: 'search', server: 'acme', source: 'mcp', kind: 'tool_call' },
      ],
      events: [{ name: 'search' }, { kind: 'skill', name: 'research' }],
    });
  });
});

describe('simulationToClientRun with skill loads', () => {
  it('emits skill events in order with tool calls', () => {
    const trace = simulationToClientRun(
      {
        success: true,
        response: 'done',
        toolCalls: [{ name: 'get_weather', arguments: { city: 'London' } }],
        skillLoads: [
          {
            name: 'weather-report',
            uri: 'skill://weather-report/SKILL.md',
            server: 'mcp',
            kind: 'skill',
            via: 'read_skill',
            verified: true,
            afterToolCalls: 0,
          },
        ],
      },
      []
    );
    expect(trace.events.map((e) => `${e.kind}:${e.name}`)).toEqual([
      'skill:weather-report',
      'tool_call:get_weather',
    ]);
  });
});

describe('server attribution at the runner boundary', () => {
  const events = [
    { kind: 'tool_call' as const, source: 'mcp' as const, name: 'search' },
    { kind: 'tool_call' as const, source: 'builtin' as const, name: 'Bash' },
  ];
  const stdio = (label?: string) => ({
    transport: 'stdio' as const,
    command: 'node',
    ...(label ? { label } : {}),
  });

  it('names the server of MCP events on a one-server variant', () => {
    const labeled = clientRunToExecution(
      { finalText: '', events },
      'structured',
      [stdio('docs')]
    );
    expect(labeled.trace?.events).toEqual([
      { ...events[0], server: 'docs' },
      events[1],
    ]);
    // An unlabeled server gets its default label, as clients configure it.
    const unlabeled = clientRunToExecution(
      { finalText: '', events },
      'structured',
      [stdio()]
    );
    expect(unlabeled.trace?.events[0]?.server).toBe('server-1');
  });

  it('does not guess the server when a variant has several', () => {
    const execution = clientRunToExecution(
      { finalText: '', events },
      'structured',
      [stdio('docs'), stdio('tickets')]
    );
    expect(execution.trace?.events).toEqual(events);
  });
});
