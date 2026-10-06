import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { installPlugins, resetPluginsForTests } from '../plugins/extensions.js';
import type { JudgeInput } from '../judge/judgeContract.js';
import type { MCPFixtureApi } from '../mcp/fixtures/mcpFixture.js';
import type { EvalContext } from './evalRunner.js';
import { runEvalDataset } from './evalRunner.js';
import { hostRunToExecution } from './hostTrace.js';
import { redactStoredResponses } from './resultStore.js';

afterEach(() => resetPluginsForTests());

const context = {
  mcp: { authType: 'none' } as MCPFixtureApi,
  testInfo: { attach: vi.fn().mockResolvedValue(undefined) },
} as unknown as EvalContext;

describe('host artifactsDir', () => {
  it('reaches judges as trial.artifactsDir and never the case result', async () => {
    const seen: JudgeInput[] = [];
    installPlugins([
      {
        meta: { name: 'p', namespace: 'p' },
        judges: {
          spy: {
            schema: z.object({}).passthrough(),
            evaluate: async (input) => {
              seen.push(input);
              return { score: 1 };
            },
          },
        },
      },
    ]);
    const result = await runEvalDataset(
      {
        dataset: {
          name: 'd',
          cases: [
            {
              id: 'c',
              mode: 'mcp_host',
              scenario: 'q',
              mcpHostConfig: { provider: 'anthropic' },
              expect: { passesJudge: [{ judge: 'p/spy' }] },
            },
          ],
        },
        executeCase: async () =>
          hostRunToExecution(
            {
              finalText: 'answer',
              events: [],
              artifactsDir: '/local/session/dir',
            },
            'structured'
          ),
      },
      context
    );
    expect(seen[0]?.trial.artifactsDir).toBe('/local/session/dir');
    const stored = JSON.stringify(result);
    expect(stored).not.toContain('/local/session/dir');
    expect(JSON.stringify(redactStoredResponses(result))).not.toContain(
      '/local/session/dir'
    );
  });
});
