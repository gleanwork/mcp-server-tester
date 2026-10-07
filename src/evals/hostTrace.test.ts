import { describe, expect, it } from 'vitest';
import { hostRunToExecution, simulationToHostRun } from './hostTrace.js';
import { runEvalDataset } from './evalRunner.js';
import type { ClientDefinition, TraceEvidence } from './evalFrameworkTypes.js';
import { z } from 'zod';

describe('per-scenario host traces', () => {
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
      { name: 'Read', arguments: {}, source: 'host' as const, id: 'call-2' },
    ];
    const trace = simulationToHostRun({ success: true, toolCalls }, []);
    expect(trace.events[0]).toMatchObject(toolCalls[0]!);
    expect(trace.events[1]).not.toHaveProperty('isError');
    const execution = hostRunToExecution(trace, 'structured');
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
    const execution = hostRunToExecution(
      {
        ...simulationToHostRun(
          {
            success: false,
            error: 'Host timed out',
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
      kind: 'host',
      error: 'Host timed out',
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
      hostDiagnostics: diagnostics,
      hostUsage: usage,
      hostTelemetry: telemetry,
      response: { diagnostics, telemetry, llmDurationMs: 123 },
    });
  });
  it('preserves explicit native and MCP provenance regardless of server count', () => {
    const result = simulationToHostRun(
      {
        success: true,
        toolCalls: [
          { name: 'Bash', arguments: {}, source: 'host' },
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
      { name: 'Bash', source: 'host', server: undefined },
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
      const trace = simulationToHostRun(
        {
          success: true,
          response: 'OK',
          toolCalls: [{ name: 'native_search', arguments: { query: 'docs' } }],
        },
        servers
      );
      trace.events.unshift({ kind: 'skill', source: 'host', name: 'research' });
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
                      { name: 'research', kind: 'skill', source: 'host' },
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
            hostRunToExecution(trace, 'structured', servers),
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
      expect(result.caseResults[0]?.mcpHostTrace).toMatchObject({
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
          kind: 'host',
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
    expect(result.caseResults[0]?.mcpHostTrace).toBeUndefined();
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
      const host: ClientDefinition = {
        schema: z.object({}),
        evidence,
        async run(input) {
          return {
            finalText: input.prompt,
            events: [
              {
                kind: 'tool_call',
                source: 'host',
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
            hostRunToExecution(
              await host.run!(
                { prompt: evalCase.input, servers: [] },
                { type: 'scenario-only' },
                { manifest: { name: 'test', datasets: [] } }
              ),
              evidence
            ),
        },
        {}
      );
      expect(result.caseResults[0]?.iterationResults).toHaveLength(3);
      expect(result.passed).toBe(evidence === 'structured' ? 1 : 0);
      const verifiedMetric = evidence === 'structured' ? 1 : undefined;
      expect(result.datasetToolPrecision).toBe(verifiedMetric);
      expect(result.datasetToolRecall).toBe(verifiedMetric);
      expect(result.caseResults[0]?.toolPrecision).toBe(verifiedMetric);
      expect(result.caseResults[0]?.toolRecall).toBe(verifiedMetric);
      expect(result.caseResults[0]?.response).toMatchObject({ evidence });
      if (evidence !== 'structured') {
        for (const iteration of result.caseResults[0]?.iterationResults ?? []) {
          expect(iteration.mcpHostTrace).toBeUndefined();
        }
      }
      expect(result.caseResults[0]?.expectations?.textContains?.pass).toBe(
        true
      );
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
    const trace = simulationToHostRun(
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
    trace.events.push({ kind: 'skill', source: 'host', name: 'research' });
    const result = hostRunToExecution(trace, 'structured', servers);
    expect(result.response).toMatchObject({
      toolCalls: [
        { name: 'search', server: 'acme', source: 'mcp', kind: 'tool_call' },
      ],
      events: [{ name: 'search' }, { kind: 'skill', name: 'research' }],
    });
  });
});

describe('simulationToHostRun with skill loads', () => {
  it('emits skill events in order with tool calls', () => {
    const trace = simulationToHostRun(
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
    { kind: 'tool_call' as const, source: 'host' as const, name: 'Bash' },
  ];
  const stdio = (label?: string) => ({
    transport: 'stdio' as const,
    command: 'node',
    ...(label ? { label } : {}),
  });

  it('names the server of MCP events on a one-server arm', () => {
    const labeled = hostRunToExecution(
      { finalText: '', events },
      'structured',
      [stdio('docs')]
    );
    expect(labeled.trace?.events).toEqual([
      { ...events[0], server: 'docs' },
      events[1],
    ]);
    // An unlabeled server gets its default label, as hosts configure it.
    const unlabeled = hostRunToExecution(
      { finalText: '', events },
      'structured',
      [stdio()]
    );
    expect(unlabeled.trace?.events[0]?.server).toBe('server-1');
  });

  it('does not guess the server when an arm has several', () => {
    const execution = hostRunToExecution(
      { finalText: '', events },
      'structured',
      [stdio('docs'), stdio('tickets')]
    );
    expect(execution.trace?.events).toEqual(events);
  });
});
