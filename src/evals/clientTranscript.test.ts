import { describe, expect, it } from 'vitest';
import { clientRunToExecution, toolCallEvents } from './clientTranscript.js';
import { runEvalDataset } from './evalRunner.js';
import { executionEnding } from './caseExecution.js';
import { infrastructureEnding } from './trialEnding.js';
import type {
  ClientDefinition,
  ClientRunResult,
  TranscriptEvidence,
} from './evalFrameworkTypes.js';
import type { LLMToolCall } from './mstClient/types.js';
import { z } from 'zod';
import { validateToolCalls } from '../assertions/validators/toolCalls.js';

describe('clientRunToExecution', () => {
  it('preserves a plugin tool name that starts with its server label', () => {
    const execution = clientRunToExecution(
      {
        finalText: 'answer',
        events: [{ kind: 'tool_call', source: 'mcp', name: 'acme.search' }],
      },
      'structured',
      [
        {
          transport: 'http',
          serverUrl: 'https://example.test/mcp',
          label: 'acme',
        },
      ]
    );
    expect(execution.transcript?.events).toEqual([
      { kind: 'tool_call', source: 'mcp', name: 'acme.search', server: 'acme' },
    ]);
    expect(
      validateToolCalls(execution.response, {
        calls: [{ name: 'search', required: true }],
        exclusive: true,
      }).pass
    ).toBe(false);
  });

  it('does not infer a plugin server from a tool-name prefix with several servers', () => {
    const events: ClientRunResult['events'] = [
      { kind: 'tool_call', source: 'mcp', name: 'acme.search' },
    ];
    const execution = clientRunToExecution(
      { finalText: '', events },
      'structured',
      ['acme', 'other'].map((label) => ({
        transport: 'http',
        serverUrl: 'https://example.test/mcp',
        label,
      }))
    );
    expect(execution.transcript?.events).toEqual(events);
  });

  it('names the replacement for a transcript event with source host', () => {
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

  it("keeps the producer's ending from the client run to the execution (ADR 0010)", () => {
    // The words name no network failure: only the producer's ending does.
    const ending = infrastructureEnding('provider', 'The model was busy.');
    const run: ClientRunResult = {
      finalText: '',
      events: [],
      error: 'The model was busy.',
      ending,
    };
    expect(executionEnding(clientRunToExecution(run, 'structured'))).toEqual(
      ending
    );
  });
});

describe('per-scenario client transcripts', () => {
  it('retains tool-result evidence and error status through the runner boundary', () => {
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
    const transcript: ClientRunResult = {
      finalText: '',
      events: toolCallEvents(toolCalls),
    };
    expect(transcript.events[0]).toMatchObject(toolCalls[0]!);
    expect(transcript.events[1]).not.toHaveProperty('isError');
    const execution = clientRunToExecution(transcript, 'structured');
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
        finalText: 'partial answer',
        error: 'Client timed out',
        events: [],
        diagnostics,
        usage,
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
    const events = toolCallEvents(
      [
        { name: 'Bash', arguments: {}, source: 'builtin' },
        { name: 'search', arguments: {}, source: 'mcp', server: 'a' },
        { name: 'search', arguments: {}, source: 'mcp', server: 'b' },
      ],
      [{ transport: 'http', serverUrl: 'https://example.com', label: 'a' }]
    );
    expect(
      events.map(({ name, source, server }) => ({
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
      const transcript: ClientRunResult = {
        finalText: 'OK',
        events: toolCallEvents(
          [{ name: 'native_search', arguments: { query: 'docs' } }],
          servers
        ),
      };
      transcript.events.unshift({
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
            clientRunToExecution(transcript, 'structured', servers),
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
      expect(transcript.events[1]?.name).toBe('native_search');
      expect(result.caseResults[0]?.toolCallTranscript).toMatchObject({
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
    expect(result.caseResults[0]?.toolCallTranscript).toBeUndefined();
    // An executor that returns only a response still gets a transcript.
    expect(result.caseResults[0]?.transcript).toEqual({
      events: [
        { kind: 'tool_call', source: 'mcp', name: 'search', arguments: {} },
      ],
      evidence: 'observed',
    });
  });
  it.each<TranscriptEvidence>(['structured', 'observed', 'none'])(
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
            name: 'transcripts',
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
          expect(trial.toolCallTranscript).toBeUndefined();
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
    const transcript: ClientRunResult = {
      finalText: 'OK',
      events: toolCallEvents([{ name: 'search', arguments: {} }], servers),
    };
    expect(transcript.events[0]).toMatchObject({
      source: 'mcp',
      server: 'acme',
      name: 'search',
    });
    transcript.events.push({
      kind: 'skill',
      source: 'builtin',
      name: 'research',
    });
    const result = clientRunToExecution(transcript, 'structured', servers);
    expect(result.response).toMatchObject({
      toolCalls: [
        { name: 'search', server: 'acme', source: 'mcp', kind: 'tool_call' },
      ],
      events: [{ name: 'search' }, { kind: 'skill', name: 'research' }],
    });
  });
});

describe('toolCallEvents', () => {
  const servers = [
    { transport: 'stdio' as const, command: 'node', label: 'docs' },
    { transport: 'stdio' as const, command: 'node', label: 'tickets' },
  ];

  it('keeps parser provenance over prefixes and strips only MCP server prefixes', () => {
    const calls: readonly LLMToolCall[] = [
      { name: 'docs.search', arguments: {} },
      { name: 'docs.Read', arguments: {}, source: 'builtin', server: 'docs' },
      { name: 'docs.search', arguments: {}, source: 'mcp', server: 'tickets' },
      { name: 'search', arguments: {}, source: 'mcp', server: 'external' },
      { name: 'unknown', arguments: {} },
    ];
    expect(
      toolCallEvents(calls, servers).map(({ name, source, server }) => ({
        name,
        source,
        server,
      }))
    ).toEqual([
      { name: 'search', source: 'mcp', server: 'docs' },
      { name: 'docs.Read', source: 'builtin', server: undefined },
      { name: 'search', source: 'mcp', server: 'tickets' },
      { name: 'search', source: 'mcp', server: 'external' },
      { name: 'unknown', source: 'builtin', server: undefined },
    ]);
    expect(calls[0]!.name).toBe('docs.search');
  });

  it('uses the one-server fallback only when the parser did not name a source', () => {
    const calls: readonly LLMToolCall[] = [
      { name: 'search', arguments: {} },
      { name: 'Read', arguments: {}, source: 'builtin' },
      { name: 'search', arguments: {}, source: 'mcp' },
    ];
    expect(toolCallEvents(calls).map((event) => event.source)).toEqual([
      'builtin',
      'builtin',
      'mcp',
    ]);
    expect(
      toolCallEvents(calls, servers.slice(0, 1)).map(({ source, server }) => ({
        source,
        server,
      }))
    ).toEqual([
      { source: 'mcp', server: 'docs' },
      { source: 'builtin', server: undefined },
      { source: 'mcp', server: 'docs' },
    ]);
  });

  it('retains native event kinds, results, zero timing and empty output without filling absent evidence', () => {
    const call: LLMToolCall = {
      kind: 'tool_search',
      name: 'docs.find_tools',
      rawName: 'mcp__docs__find_tools',
      source: 'mcp',
      arguments: { query: 'search' },
      output: '',
      isError: false,
      id: 'call-1',
      durationMs: 0,
      startedAt: '2026-11-05T15:00:00.000Z',
      completedAt: '2026-11-05T15:00:00.000Z',
      results: [{ name: 'search', server: 'docs' }],
    };
    const [event, absent] = toolCallEvents(
      [call, { name: 'Read', arguments: {} }],
      servers
    );
    expect(event).toEqual({ ...call, name: 'find_tools', server: 'docs' });
    for (const key of [
      'rawName',
      'isError',
      'durationMs',
      'startedAt',
      'completedAt',
      'results',
    ])
      expect(absent).not.toHaveProperty(key);
  });
});

describe('client-native skill events', () => {
  it('retains their order and telemetry without turning skills into tool calls', () => {
    const run: ClientRunResult = {
      finalText: 'done',
      events: [
        { kind: 'skill', source: 'mcp', name: 'weather-report' },
        {
          kind: 'tool_call',
          source: 'mcp',
          name: 'get_weather',
          arguments: { city: 'London' },
        },
      ],
      telemetry: { source: 'native-client' },
    };
    const execution = clientRunToExecution(run, 'structured');
    expect(execution.transcript?.events).toEqual(run.events);
    expect(execution.response).toMatchObject({
      success: true,
      response: 'done',
      events: run.events,
      toolCalls: [{ name: 'get_weather' }],
      telemetry: run.telemetry,
    });
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
    expect(labeled.transcript?.events).toEqual([
      { ...events[0], server: 'docs' },
      events[1],
    ]);
    // An unlabeled server gets its default label, as clients configure it.
    const unlabeled = clientRunToExecution(
      { finalText: '', events },
      'structured',
      [stdio()]
    );
    expect(unlabeled.transcript?.events[0]?.server).toBe('server-1');
  });

  it('does not guess the server when a variant has several', () => {
    const execution = clientRunToExecution(
      { finalText: '', events },
      'structured',
      [stdio('docs'), stdio('tickets')]
    );
    expect(execution.transcript?.events).toEqual(events);
  });
});
