import { test, expect } from '../src/fixtures/mcp.js';
import { runSkillsComparison } from '../src/evals/skillsComparison.js';
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

    const result = await runSkillsComparison(
      { dataset, variants: ['off', 'catalog', 'preload'] },
      { mcp, testInfo }
    );

    const summary = Object.fromEntries(
      result.variants.map((variant) => [variant.mode, variant.summary])
    );
    await testInfo.attach('skills-comparison', {
      contentType: 'application/json',
      body: JSON.stringify(summary, null, 2),
    });
    console.log('Skills comparison:', JSON.stringify(summary, null, 2));

    // Without skills there is nothing to load, so the strict skill-first
    // expectation cannot pass; with them, the model should load the skill.
    expect(summary.off?.passRate).toBe(0);
    expect(summary.catalog?.skillVerificationFailureRate ?? 0).toBe(0);
  });
});
