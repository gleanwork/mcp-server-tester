import { test, expect } from '@gleanwork/mcp-server-tester/fixtures/mcp';
import {
  compareEvalRuns,
  loadEvalDataset,
  runEvalDataset,
  type EvalRunComparisonResult,
  type ToolOverrideVariant,
} from '@gleanwork/mcp-server-tester';

interface ToolOverrideProposal {
  variantId: string;
  reason: string;
  toolOverrides: ToolOverrideVariant;
  evidence: {
    unchangedFailures: string[];
    regressedCases: string[];
  };
}

test('compare a runtime tool metadata variant', async ({ mcp }, testInfo) => {
  const dataset = await loadEvalDataset('./data/host-evals.json');

  const baseline = await runEvalDataset(
    { dataset, defaultLlmIterations: 10 },
    { mcp, testInfo }
  );

  const candidateVariant: ToolOverrideVariant = {
    id: 'search-description-v2',
    description: 'Clarify when to use search for internal knowledge.',
    tools: {
      search: {
        description:
          'Search internal company documents, policies, wiki pages, and announcements. Use this when the user asks to find company information by topic.',
        inputSchema: {
          type: 'object',
          properties: {
            query: {
              type: 'string',
              description:
                'Natural language query describing the document, policy, or topic to find.',
            },
          },
          required: ['query'],
        },
      },
    },
  };

  const candidate = await runEvalDataset(
    {
      dataset,
      defaultLlmIterations: 10,
      toolOverrides: candidateVariant,
    },
    { mcp, testInfo }
  );

  const comparison = compareEvalRuns({
    baseline,
    candidate,
    labels: {
      baseline: 'baseline',
      candidate: candidateVariant.id,
    },
  });

  const proposal = buildNextOverrideProposal(comparison, candidateVariant);
  if (proposal) {
    console.log(JSON.stringify(proposal, null, 2));
  }

  expect(comparison.regressedCases, proposal?.reason).toHaveLength(0);
  expect(comparison.candidatePassRate).toBeGreaterThanOrEqual(
    comparison.baselinePassRate
  );
});

function buildNextOverrideProposal(
  comparison: EvalRunComparisonResult,
  previousVariant: ToolOverrideVariant
): ToolOverrideProposal | undefined {
  const unresolved = comparison.unchangedFailures.map((c) => c.id);
  const regressed = comparison.regressedCases.map((c) => c.id);

  if (unresolved.length === 0 && regressed.length === 0) {
    return undefined;
  }

  return {
    variantId: 'search-description-v3',
    reason:
      'The candidate still has failed or regressed cases. Propose a narrower search description before changing server source.',
    toolOverrides: {
      ...previousVariant,
      id: 'search-description-v3',
      description: 'Further clarify search intent and query construction.',
      tools: {
        ...previousVariant.tools,
        search: {
          ...previousVariant.tools.search,
          description:
            'Use search only to find internal company knowledge such as documents, policies, wiki pages, and announcements. Convert the user request into a concise topic query.',
        },
      },
    },
    evidence: {
      unchangedFailures: unresolved,
      regressedCases: regressed,
    },
  };
}
