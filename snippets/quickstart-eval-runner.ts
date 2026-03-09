import { test, expect } from '@gleanwork/mcp-server-tester/fixtures/mcp';
import { loadEvalDataset, runEvalDataset } from '@gleanwork/mcp-server-tester';
import { z } from 'zod';

test('run weather evals', async ({ mcp }, testInfo) => {
  const WeatherSchema = z.object({
    city: z.string(),
    temperature: z.number(),
    conditions: z.string(),
  });

  const dataset = await loadEvalDataset('./data/evals.json', {
    schemas: { 'weather-response': WeatherSchema },
  });

  const result = await runEvalDataset({ dataset }, { mcp, testInfo });

  expect(result.passed).toBe(result.total);
});
