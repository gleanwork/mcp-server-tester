import { describe, expect, it } from 'vitest';
import { validateToolCalls } from '../assertions/validators/toolCalls.js';
import {
  splitClaudeMcpName,
  surfacedTools,
  typeClaudeCodeCall,
} from './claudeCodeEvents.js';
import { simulationTrace } from './hostTrace.js';
import { parseStreamJson } from './mcpHost/adapters/cli/parsers.js';
import type { LLMToolCall } from './mcpHost/mcpHostTypes.js';

function host(name: string, input: Record<string, unknown>, output?: string) {
  return {
    name,
    source: 'host' as const,
    rawName: name,
    arguments: input,
    id: 'call-1',
    ...(output !== undefined ? { output } : {}),
  } satisfies LLMToolCall;
}

describe('surfacedTools', () => {
  it('reads tool_reference blocks, strings, and MCP names in text', () => {
    expect(
      surfacedTools(
        JSON.stringify([
          { type: 'tool_reference', tool_name: 'mcp__agg__find_skills' },
          { type: 'tool_reference', tool_name: 'Bash' },
        ])
      )
    ).toEqual([{ server: 'agg', name: 'find_skills' }, { name: 'Bash' }]);
    expect(surfacedTools(JSON.stringify(['mcp__a__search']))).toEqual([
      { server: 'a', name: 'search' },
    ]);
    expect(
      surfacedTools('Found: mcp__agg__find_skills, mcp__agg__search.')
    ).toEqual([
      { server: 'agg', name: 'find_skills' },
      { server: 'agg', name: 'search' },
    ]);
    expect(surfacedTools(undefined)).toEqual([]);
    expect(surfacedTools('No matching tools.')).toEqual([]);
  });
});

describe('typeClaudeCodeCall', () => {
  it('types Claude Code host tools as the events they are', () => {
    expect(typeClaudeCodeCall(host('Skill', { skill: 'pdf' }))).toMatchObject({
      kind: 'skill',
      name: 'pdf',
      rawName: 'Skill',
    });
    expect(
      typeClaudeCodeCall(host('SlashCommand', { command: '/review' }))
    ).toMatchObject({ kind: 'command', name: '/review' });
    expect(
      typeClaudeCodeCall(host('Task', { subagent_type: 'explorer' }))
    ).toMatchObject({ kind: 'subagent', name: 'explorer' });
    expect(typeClaudeCodeCall(host('Agent', {}))).toMatchObject({
      kind: 'subagent',
      name: 'Agent',
    });
    expect(
      typeClaudeCodeCall(
        host(
          'ToolSearch',
          { query: 'tickets' },
          JSON.stringify([
            { type: 'tool_reference', tool_name: 'mcp__agg__find_skills' },
          ])
        )
      )
    ).toMatchObject({
      kind: 'tool_search',
      name: 'ToolSearch',
      arguments: { query: 'tickets' },
      results: [{ server: 'agg', name: 'find_skills' }],
    });
  });

  it('leaves MCP calls, other host tools and incomplete calls alone', () => {
    const mcp: LLMToolCall = {
      name: 'Skill',
      source: 'mcp',
      server: 'agg',
      arguments: {},
    };
    expect(typeClaudeCodeCall(mcp)).toBe(mcp);
    const bash = host('Bash', { command: 'ls' });
    expect(typeClaudeCodeCall(bash)).toBe(bash);
    const unnamed = host('Skill', {});
    expect(typeClaudeCodeCall(unnamed)).toBe(unnamed);
  });
});

describe('Claude CLI stream-json', () => {
  it('produces typed skill and tool_search events in the trace', () => {
    const lines = [
      {
        type: 'assistant',
        message: {
          content: [
            {
              type: 'tool_use',
              id: 's',
              name: 'ToolSearch',
              input: { query: 'ticket' },
            },
          ],
        },
      },
      {
        type: 'user',
        message: {
          content: [
            {
              type: 'tool_result',
              tool_use_id: 's',
              content: [
                { type: 'tool_reference', tool_name: 'mcp__agg__find_skills' },
              ],
            },
          ],
        },
      },
      {
        type: 'assistant',
        message: {
          content: [
            {
              type: 'tool_use',
              id: 'k',
              name: 'Skill',
              input: { skill: 'triage' },
            },
            {
              type: 'tool_use',
              id: 'm',
              name: 'mcp__agg__find_skills',
              input: { query: 'ticket' },
            },
          ],
        },
      },
      {
        type: 'result',
        result: 'Done',
        usage: { input_tokens: 1, output_tokens: 1 },
      },
    ];
    const result = parseStreamJson(
      lines.map((line) => JSON.stringify(line)).join('\n')
    );
    expect(simulationTrace(result).events).toMatchObject([
      {
        kind: 'tool_search',
        source: 'host',
        results: [{ server: 'agg', name: 'find_skills' }],
      },
      { kind: 'skill', source: 'host', name: 'triage' },
      { kind: 'tool_call', source: 'mcp', server: 'agg', name: 'find_skills' },
    ]);
  });
});

describe('Claude Code event edge cases', () => {
  it('names a skill from `command`, and a command without its arguments', () => {
    expect(typeClaudeCodeCall(host('Skill', { command: 'pdf' }))).toMatchObject(
      {
        kind: 'skill',
        name: 'pdf',
      }
    );
    expect(
      typeClaudeCodeCall(host('SlashCommand', { command: '/review-pr 123' }))
    ).toMatchObject({
      kind: 'command',
      name: '/review-pr',
      arguments: { command: '/review-pr 123' },
    });
  });

  it('reads only tool references when a search returns them', () => {
    expect(
      surfacedTools(
        JSON.stringify([
          {
            type: 'tool_reference',
            tool_name: 'mcp__agg__find_skills',
            description: 'Like mcp__agg__search, but for skills.',
          },
        ])
      )
    ).toEqual([{ server: 'agg', name: 'find_skills' }]);
  });

  it('splits a name with `__` the same way for searches and both parsers', async () => {
    const raw = 'mcp__a__b__c';
    expect(splitClaudeMcpName(raw)).toEqual({ server: 'a', name: 'b__c' });
    expect(surfacedTools(JSON.stringify([raw]))).toEqual([
      { server: 'a', name: 'b__c' },
    ]);
    const stream = parseStreamJson(
      JSON.stringify({
        type: 'assistant',
        message: {
          content: [{ type: 'tool_use', id: 'x', name: raw, input: {} }],
        },
      })
    );
    expect(stream.toolCalls[0]).toMatchObject({ server: 'a', name: 'b__c' });
  });

  it('lets toolsTriggered require a tool search', () => {
    const response = {
      success: true,
      toolCalls: [],
      events: [
        {
          kind: 'tool_search',
          source: 'host',
          name: 'ToolSearch',
          results: [],
        },
        { kind: 'tool_call', source: 'mcp', name: 'find_skills' },
      ],
    };
    expect(
      validateToolCalls(response, {
        calls: [
          { name: 'ToolSearch', kind: 'tool_search' },
          { name: 'find_skills' },
        ],
        order: 'strict',
      }).pass
    ).toBe(true);
    expect(
      validateToolCalls(response, {
        calls: [{ name: 'ToolSearch', kind: 'tool_call' }],
      }).pass
    ).toBe(false);
  });
});
