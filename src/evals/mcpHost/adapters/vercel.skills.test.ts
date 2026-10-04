import { describe, it, expect, vi, beforeEach } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  closeMCPClient,
  createMCPClientForConfig,
} from '../../../mcp/clientFactory.js';
import { createMCPFixture } from '../../../mcp/fixtures/mcpFixture.js';
import type { MCPFixtureApi } from '../../../mcp/fixtures/mcpFixture.js';
import { validateToolCalls } from '../../../assertions/validators/toolCalls.js';
import { simulateMCPHost } from '../mcpHostSimulation.js';
import { runEvalDataset } from '../../evalRunner.js';
import { computeMetrics } from '../../metrics.js';
import type { EvalDataset } from '../../datasetTypes.js';

/**
 * The SDK host with Agent Skills enabled, driven by a scripted model: it
 * calls read_skill first when the host offers it, then get_weather. Runs
 * against the real dual-era mock, so skill reads and verification are real.
 */

type ToolSet = Record<
  string,
  { execute: (args: Record<string, unknown>) => Promise<string> }
>;

vi.mock('@ai-sdk/provider-utils', () => ({
  jsonSchema: (schema: Record<string, unknown>) => ({ jsonSchema: schema }),
}));
vi.mock('@ai-sdk/openai', () => ({
  createOpenAI: () => () => ({ id: 'scripted-model' }),
}));
vi.mock('ai', () => ({
  stepCountIs: (n: number) => ({ type: 'stepCount', count: n }),
  generateText: vi.fn(async ({ tools }: { tools: ToolSet }) => {
    const script: Array<[string, Record<string, unknown>]> = [
      ...(tools.read_skill
        ? [
            [
              'read_skill',
              { server: 'mcp', uri: 'skill://weather-report/SKILL.md' },
            ] as [string, Record<string, unknown>],
          ]
        : []),
      ['get_weather', { city: 'London' }],
    ];
    const steps = [];
    for (const [index, [toolName, input]] of script.entries()) {
      await tools[toolName]!.execute(input);
      steps.push({
        toolCalls: [{ toolCallId: `call-${index}`, toolName, input }],
        text: '',
      });
    }
    steps.push({ toolCalls: [], text: 'London: 20°C, Sunny.' });
    return {
      text: 'London: 20°C, Sunny.',
      steps,
      usage: { inputTokens: 10, outputTokens: 5 },
    };
  }),
}));

const mock = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../../tests/mocks/dualEraServer.ts'
);

async function withFixture<T>(run: (mcp: MCPFixtureApi) => Promise<T>) {
  const client = await createMCPClientForConfig({
    transport: 'stdio',
    command: process.execPath,
    args: ['--import', 'tsx', mock],
    quiet: true,
    protocol: '2026-07-28',
  });
  try {
    return await run(createMCPFixture(client));
  } finally {
    await closeMCPClient(client);
  }
}

const SKILL_THEN_TOOL = {
  calls: [
    { name: 'weather-report', kind: 'skill' as const },
    { name: 'get_weather' },
  ],
  order: 'strict' as const,
};

beforeEach(async () => {
  const { generateText } = await import('ai');
  vi.mocked(generateText).mockClear();
});

describe('SDK host with skills', () => {
  it('catalog: the model loads the skill with read_skill before using the tool', async () => {
    await withFixture(async (mcp) => {
      const result = await simulateMCPHost(mcp, 'Weather in London?', {
        provider: 'openai',
        skills: 'catalog',
      });

      expect(result.success).toBe(true);
      // read_skill is a host tool, not an MCP tool call.
      expect(result.toolCalls.map((c) => c.name)).toEqual(['get_weather']);
      expect(result.skillLoads).toEqual([
        expect.objectContaining({
          name: 'weather-report',
          verified: true,
          afterToolCalls: 0,
        }),
      ]);
      expect(result.events?.map((e) => `${e.kind}:${e.name}`)).toEqual([
        'skill:weather-report',
        'tool_call:get_weather',
      ]);
      expect(validateToolCalls(result, SKILL_THEN_TOOL).pass).toBe(true);
      expect(
        result.conversationHistory?.some((turn) =>
          turn.content?.startsWith('[host] read_skill')
        )
      ).toBe(true);

      const { generateText } = await import('ai');
      const call = vi.mocked(generateText).mock.calls[0]![0] as {
        system?: string;
      };
      expect(call.system).toContain('<name>weather-report</name>');
    });
  }, 30_000);

  it('off (default): no skills, no system prompt, unchanged tool trace', async () => {
    await withFixture(async (mcp) => {
      const result = await simulateMCPHost(mcp, 'Weather in London?', {
        provider: 'openai',
      });

      expect(result.skillLoads).toBeUndefined();
      expect(result.events).toBeUndefined();
      expect(result.toolCalls.map((c) => c.name)).toEqual(['get_weather']);
      expect(validateToolCalls(result, SKILL_THEN_TOOL).pass).toBe(false);

      const { generateText } = await import('ai');
      const call = vi.mocked(generateText).mock.calls[0]![0] as {
        system?: string;
      };
      expect(call.system).toBeUndefined();
    });
  }, 30_000);

  it('rejects skills on non-SDK hosts', async () => {
    await withFixture(async (mcp) => {
      await expect(
        simulateMCPHost(mcp, 'x', {
          hostType: 'cli',
          skills: 'catalog',
          cli: { command: 'true', args: [] },
        })
      ).rejects.toThrow(/only supported for the SDK host/);
    });
  }, 30_000);

  it('measures the difference skills make, mode by mode', async () => {
    await withFixture(async (mcp) => {
      const run = async (skills?: 'catalog' | 'preload') => {
        const dataset: EvalDataset = {
          name: 'weather-skills',
          cases: [
            {
              id: 'uses-skill',
              mode: 'mcp_host',
              scenario: 'What is the weather in London?',
              mcpHostConfig: {
                provider: 'openai',
                ...(skills ? { skills } : {}),
              },
              expect: { toolsTriggered: SKILL_THEN_TOOL },
            },
          ],
        };
        const result = await runEvalDataset({ dataset }, { mcp });
        return computeMetrics(
          [
            'passed',
            'skill_loaded',
            'skill_before_tool',
            'skill_verification_failed',
          ],
          result.caseResults
        ).aggregated;
      };

      expect(await run()).toEqual({ passed_rate: 0 });
      expect(await run('catalog')).toMatchObject({
        passed_rate: 1,
        skill_loaded_rate: 1,
        skill_before_tool_rate: 1,
        skill_verification_failed_rate: 0,
      });
      // preload puts the skill in context without the model choosing it:
      // no skill event, so skill-first can't pass and no load rate is kept.
      const preload = await run('preload');
      expect(preload).toMatchObject({ passed_rate: 0 });
      expect(preload.skill_loaded_rate).toBeUndefined();
    });
  }, 60_000);
});
