import { describe, expect, it } from 'vitest';
import { hostTraceToExecution, simulationToHostTrace } from './hostTrace.js';
import { runEvalDataset } from './evalRunner.js';
import type { HostDefinition, HostEvidence } from './evalFrameworkTypes.js';
import { z } from 'zod';

describe('per-scenario host traces', () => {
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
      toolCalls: [{ name: 'search' }],
      events: [{ name: 'search' }, { kind: 'skill', name: 'research' }],
    });
  });
});
