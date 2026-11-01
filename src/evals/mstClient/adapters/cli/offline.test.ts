import { describe, expect, it } from 'vitest';
import { simulateMstClient } from '../../simulation.js';
import {
  simulationToClientRun,
  clientRunToExecution,
} from '../../../clientTrace.js';
import { runEvalDataset } from '../../../evalRunner.js';
import { executionEnding } from '../../../caseExecution.js';
import type { MCPFixtureApi } from '../../../../mcp/fixtures/mcpFixture.js';

const unusedMcp = {} as MCPFixtureApi;

/**
 * Claude Code as a child process (`claudeMcpServers` makes the runner treat
 * it as Claude Code) that prints `lines` and exits with `code`, as Claude
 * Code exits non-zero after an error result.
 */
async function claudeExiting(lines: object[], code: number) {
  const script = `${lines
    .map((line) => `console.log(${JSON.stringify(JSON.stringify(line))});`)
    .join('')}process.exitCode = ${code};`;
  return simulateMstClient(unusedMcp, 'hello', {
    clientType: 'cli',
    cli: {
      command: process.execPath,
      args: ['-e', script],
      claudeMcpServers: [],
    },
  });
}

const answered = {
  type: 'assistant',
  message: { content: [{ type: 'text', text: 'Looking.' }] },
};

describe('how a Claude Code run that exited with an error ended (ADR 0010)', () => {
  it('is a trial when Claude Code reached its turn limit', async () => {
    const result = await claudeExiting(
      [
        answered,
        {
          type: 'result',
          subtype: 'error_max_turns',
          is_error: true,
          num_turns: 3,
        },
      ],
      1
    );
    expect(result.success).toBe(false);
    expect(result.error).toBe('Claude Code reached its turn limit (3 turns).');
    expect(result.ending).toEqual({ kind: 'trial' });
    // Not the client app failing: no `process` failure kind.
    expect(result.diagnostics?.failureKind).toBeUndefined();
  });

  it("is the provider when Claude Code reports the API's 529", async () => {
    const error =
      'API Error: 529 {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}';
    const result = await claudeExiting(
      [answered, { type: 'result', is_error: true, result: error }],
      1
    );
    expect(result.error).toBe(error);
    expect(result.ending).toMatchObject({
      kind: 'infrastructure',
      broke: 'provider',
      retryable: true,
    });
  });

  it("is setup when the case's prompt doesn't fit before Claude Code acts", async () => {
    const result = await claudeExiting(
      [{ type: 'result', is_error: true, result: 'Prompt is too long' }],
      1
    );
    expect(result.ending).toMatchObject({
      kind: 'infrastructure',
      broke: 'setup',
      retryable: false,
    });
  });

  it('is a trial when the context fills after the model answered', async () => {
    const result = await claudeExiting(
      [
        answered,
        { type: 'result', is_error: true, result: 'Prompt is too long' },
      ],
      1
    );
    expect(result.ending).toEqual({ kind: 'trial' });
  });

  it('is the client app when Claude Code exits without saying why', async () => {
    const result = await claudeExiting([answered], 1);
    expect(result.success).toBe(false);
    expect(result.ending).toBeUndefined();
    expect(result.diagnostics?.failureKind).toBe('process');
    expect(
      executionEnding(
        clientRunToExecution(simulationToClientRun(result, []), 'structured')
      )
    ).toMatchObject({ kind: 'infrastructure', broke: 'client-app' });
  });
});

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
    const result = await simulateMstClient(unusedMcp, 'hello', {
      clientType: 'cli',
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
      { name: 'Bash', source: 'builtin', rawName: 'Bash' },
    ]);
    expect(result.toolCalls[3]).not.toHaveProperty('server');
    const servers = ['a', 'b'].map((label) => ({
      transport: 'http' as const,
      serverUrl: 'https://example.com',
      label,
    }));
    const trace = simulationToClientRun(result, servers);
    const scored = await runEvalDataset(
      {
        dataset: {
          name: 'cli-provenance',
          cases: [
            {
              id: 'one',
              input: 'hello',
              assertions: {
                toolsTriggered: {
                  calls: [
                    { name: 'search', source: 'mcp', server: 'a' },
                    { name: 'search', source: 'mcp', server: 'b' },
                    { name: 'Bash', source: 'builtin' },
                  ],
                },
              },
            },
          ],
        },
        executeCase: async () =>
          clientRunToExecution(trace, 'structured', servers),
      },
      {}
    );
    expect(scored.passed).toBe(1);
  });
  it('passes per-execution environment to the child without changing process.env', async () => {
    const before = process.env.HOST_OFFLINE_TEST;
    const result = await simulateMstClient(unusedMcp, 'hello', {
      clientType: 'cli',
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
