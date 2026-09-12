import { describe, expect, it } from 'vitest';
import { simulateMCPHost } from '../../mcpHostSimulation.js';
import {
  simulationToHostTrace,
  hostTraceToExecution,
} from '../../../hostTrace.js';
import { runEvalDataset } from '../../../evalRunner.js';
import type { MCPFixtureApi } from '../../../../mcp/fixtures/mcpFixture.js';

const unusedMcp = {} as MCPFixtureApi;
describe('offline CLI public execution path', () => {
  it('preserves distinct MCP server identities and native tools through a real child process', async () => {
    const event = JSON.stringify({
      type: 'assistant',
      message: {
        content: [
          'mcp__a__search',
          'mcp__b__search',
          'mcp__server_with_underscores__search',
          'Bash',
        ].map((name, index) => ({
          type: 'tool_use',
          name,
          id: String(index),
          input: {},
        })),
      },
    });
    const result = await simulateMCPHost(unusedMcp, 'hello', {
      hostType: 'cli',
      cli: {
        command: process.execPath,
        args: ['-e', `console.log(${JSON.stringify(event)})`],
      },
    });
    expect(result.success).toBe(true);
    expect(result.toolCalls).toMatchObject([
      { name: 'search', source: 'mcp', server: 'a', rawName: 'mcp__a__search' },
      { name: 'search', source: 'mcp', server: 'b', rawName: 'mcp__b__search' },
      { name: 'search', source: 'mcp', server: 'server_with_underscores' },
      { name: 'Bash', source: 'host', rawName: 'Bash' },
    ]);
    expect(result.toolCalls[3]).not.toHaveProperty('server');
    const servers = ['a', 'b'].map((label) => ({
      transport: 'http' as const,
      serverUrl: 'https://example.com',
      label,
    }));
    const trace = simulationToHostTrace(result, servers);
    const scored = await runEvalDataset(
      {
        dataset: {
          name: 'cli-provenance',
          cases: [
            {
              id: 'one',
              mode: 'host',
              scenario: 'hello',
              expect: {
                toolsTriggered: {
                  calls: [
                    { name: 'search', source: 'mcp', server: 'a' },
                    { name: 'search', source: 'mcp', server: 'b' },
                    { name: 'Bash', source: 'host' },
                  ],
                },
              },
            },
          ],
        },
        executeCase: async () =>
          hostTraceToExecution(trace, 'structured', servers),
      },
      {}
    );
    expect(scored.passed).toBe(1);
  });
  it('passes per-execution environment to the child without changing process.env', async () => {
    const before = process.env.HOST_OFFLINE_TEST;
    const result = await simulateMCPHost(unusedMcp, 'hello', {
      hostType: 'cli',
      env: { HOST_OFFLINE_TEST: 'isolated' },
      cli: {
        command: process.execPath,
        args: [
          '-e',
          'console.log(JSON.stringify({success:true, toolCalls:[], response:process.env.HOST_OFFLINE_TEST}))',
        ],
        outputFormat: 'json',
      },
    });
    expect(result.response).toBe('isolated');
    expect(process.env.HOST_OFFLINE_TEST).toBe(before);
  });
});
