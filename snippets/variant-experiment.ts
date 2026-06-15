import { test, expect } from '@gleanwork/mcp-server-tester/fixtures/mcp';
import {
  loadEvalDataset,
  runVariantExperiment,
  type ToolOverrideVariant,
} from '@gleanwork/mcp-server-tester';

// Static A/B: try a fixed set of tool-description variants and keep the winner.
test('optimize search description (static variants)', async ({
  mcp,
}, testInfo) => {
  const dataset = await loadEvalDataset('./data/host-evals.json');

  const variants: ToolOverrideVariant[] = [
    {
      id: 'search-v2-internal-docs',
      description: 'Clarify that search is for internal knowledge.',
      tools: {
        search: {
          description:
            'Search internal company documents, policies, wiki pages, and announcements. Use this when the user asks to find company information by topic.',
        },
      },
    },
    {
      id: 'search-v3-with-examples',
      description: 'Add example triggers to the search description.',
      tools: {
        search: {
          description:
            'Find internal company knowledge — docs, policies, wikis, announcements. Examples: "find the Q3 planning doc", "what is our PTO policy".',
        },
      },
    },
  ];

  const result = await runVariantExperiment(
    { dataset, variants, metric: 'passRate', defaultLlmIterations: 10 },
    { mcp, testInfo }
  );

  if (result.proposal?.recommendation === 'apply') {
    const pct = (result.proposal.delta * 100).toFixed(1);
    console.log(
      `Apply ${result.winner?.variant.id}: +${pct}% ${result.metric}`
    );
    console.log(
      `Improved cases: ${result.proposal.improvedCaseIds.join(', ')}`
    );
  }

  // The default guard never crowns a variant that regresses a case.
  expect(result.winner?.comparison.regressedCases ?? []).toHaveLength(0);
});

// Agent loop: propose the next variant from the previous round's evidence.
test('optimize search description (agent loop)', async ({ mcp }, testInfo) => {
  const dataset = await loadEvalDataset('./data/host-evals.json');

  const result = await runVariantExperiment(
    {
      dataset,
      metric: 'passRate',
      maxRounds: 4,
      minImprovement: 0.05,
      defaultLlmIterations: 10,
      async proposeVariants({ round, history, bestSoFar }) {
        // An agent inspects bestSoFar / history to decide the next rewrite.
        // Stop early once the best candidate has no remaining failures.
        const stillFailing =
          history.at(-1)?.best?.comparison.unchangedFailures.map((c) => c.id) ??
          [];
        if (round > 0 && stillFailing.length === 0) {
          return [];
        }

        return [
          {
            id: `search-round-${round}`,
            description: `Round ${round} refinement of ${
              bestSoFar?.variant.id ?? 'baseline'
            }.`,
            tools: {
              search: {
                description:
                  'Use search ONLY to find internal company knowledge (docs, policies, wikis, announcements). Convert the request into a concise topic query.',
              },
            },
          },
        ];
      },
    },
    { mcp, testInfo }
  );

  console.log(
    `Stopped after ${result.rounds.length} round(s): ${result.reason}`
  );
  console.log(JSON.stringify(result.proposal, null, 2));
});
