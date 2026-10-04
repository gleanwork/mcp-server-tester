import { test, expect } from '../src/fixtures/mcp.js';
import { runEvalDataset } from '../src/evals/evalRunner.js';
import { computeMetrics } from '../src/evals/metrics.js';
import type { EvalDataset } from '../src/evals/datasetTypes.js';

/**
 * Live Agent Skills eval: runs a real model against the mock server with
 * skills off, as a catalog (read_skill), and preloaded, and reports how often
 * the model loads the skill and passes.
 *
 * Opt-in (costs money): MST_LIVE_SKILLS_EVAL=1 ANTHROPIC_API_KEY=... \
 *   npx playwright test tests/skills-live.spec.ts --project mcp-stdio-mock
 */
const enabled =
  process.env.MST_LIVE_SKILLS_EVAL === '1' && !!process.env.ANTHROPIC_API_KEY;

const ITERATIONS = Number(process.env.MST_LIVE_SKILLS_ITERATIONS ?? '5');

test.describe('Live skills eval (opt-in)', () => {
  test.skip(!enabled, 'set MST_LIVE_SKILLS_EVAL=1 and ANTHROPIC_API_KEY');
  test.setTimeout(10 * 60_000);

  test('off vs catalog vs preload', async ({ mcp }, testInfo) => {
    // Guard against a vacuous run: the server must serve the skill.
    expect(mcp.skills.supported()).toBe(true);
    expect(
      (await mcp.skills.list()).map((entry) => entry.frontmatter.name)
    ).toContain('weather-report');

    const dataset: EvalDataset = {
      name: 'weather-report-skill',
      cases: [
        {
          id: 'weather-report',
          mode: 'mcp_host',
          scenario:
            'Write me a short weather report for London and Paris, following any house style you have for weather reports.',
          mcpHostConfig: {
            provider: 'anthropic',
            model: process.env.MST_LIVE_SKILLS_MODEL,
          },
          iterations: ITERATIONS,
          accuracyThreshold: 0.6,
          expect: {
            toolsTriggered: {
              calls: [
                { name: 'weather-report', kind: 'skill' },
                { name: 'get_weather' },
              ],
              order: 'strict',
            },
          },
        },
      ],
    };

    // One run per skills mode, compared on the same metrics.
    const summary: Record<string, Record<string, unknown>> = {};
    for (const mode of ['off', 'catalog', 'preload'] as const) {
      const result = await runEvalDataset(
        {
          dataset: {
            ...dataset,
            cases: dataset.cases.map((evalCase) => ({
              ...evalCase,
              mcpHostConfig: {
                ...evalCase.mcpHostConfig!,
                ...(mode === 'off' ? {} : { skills: mode }),
              },
            })),
          },
        },
        { mcp, testInfo }
      );
      summary[mode] = computeMetrics(
        [
          'passed',
          'skill_loaded',
          'skill_before_tool',
          'skill_verification_failed',
        ],
        result.caseResults
      ).aggregated;
    }
    await testInfo.attach('skills-comparison', {
      contentType: 'application/json',
      body: JSON.stringify(summary, null, 2),
    });
    console.log('Skills comparison:', JSON.stringify(summary, null, 2));

    // The strict skill-first expectation needs the model to load the skill:
    // impossible with skills off, and preloads are not model loads.
    expect(summary.off?.passed_rate).toBe(0);
    expect(summary.preload?.passed_rate).toBe(0);
    expect(summary.catalog?.skill_loaded_rate).toBeDefined();
    expect(summary.catalog?.skill_verification_failed_rate ?? 0).toBe(0);
  });
});
