import { describe, expect, it } from 'vitest';
import { hostTraceToExecution, simulationToHostTrace } from './hostTrace.js';
import { runEvalDataset } from './evalRunner.js';
import type { HostDefinition, HostEvidence } from './evalFrameworkTypes.js';
import { z } from 'zod';

describe('per-scenario host traces', () => {
  it('preserves explicit native and MCP provenance regardless of server count', () => {
    const result = simulationToHostTrace(
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
      const trace = simulationToHostTrace(
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
                mode: 'host',
                scenario: 'research',
                expect: {
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
            hostTraceToExecution(trace, 'structured', servers),
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
              mode: 'host',
              scenario: 'search',
              expect: { toolsTriggered: { calls: [{ name: 'search' }] } },
            },
          ],
        },
        executeCase: async () => ({
          response: { success: true, toolCalls: [{ name: 'search' }] },
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
  });
  it.each<HostEvidence>(['structured', 'observed', 'none'])(
    'gates tool assertions for %s evidence',
    async (evidence) => {
      const host: HostDefinition = {
        name: 'scenario-only',
        schema: z.object({}),
        evidence,
        async run(input) {
          return {
            finalText: input.scenario,
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
                mode: 'host',
                scenario: 'EXPECTED',
                iterations: 3,
                expect: {
                  containsText: 'EXPECTED',
                  toolsTriggered: {
                    calls: [{ name: 'search', arguments: { query: 'right' } }],
                  },
                },
              },
            ],
          },
          executeCase: async (evalCase) =>
            hostTraceToExecution(
              await host.run!(
                { scenario: evalCase.scenario!, servers: [] },
                { type: host.name },
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
        label: 'glean',
      },
    ];
    const trace = simulationToHostTrace(
      {
        success: true,
        response: 'OK',
        toolCalls: [{ name: 'search', arguments: {} }],
      },
      servers
    );
    expect(trace.events[0]).toMatchObject({
      source: 'mcp',
      server: 'glean',
      name: 'search',
    });
    trace.events.push({ kind: 'skill', source: 'host', name: 'research' });
    const result = hostTraceToExecution(trace, 'structured', servers);
    expect(result.response).toMatchObject({
      toolCalls: [
        { name: 'search', server: 'glean', source: 'mcp', kind: 'tool_call' },
      ],
      events: [{ name: 'search' }, { kind: 'skill', name: 'research' }],
    });
  });
});
