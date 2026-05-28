import {
  compareEvalRuns,
  createEvalResultStore,
  loadStoredEvalRunnerResult,
  saveEvalRunComparison,
} from '@gleanwork/mcp-server-tester';

const store = createEvalResultStore({
  provider: 'gcs',
  bucket: 'my-mcp-eval-results',
  prefix: 'my-server/variants',
});

const baseline = await loadStoredEvalRunnerResult(store, { id: 'baseline' });
const candidate = await loadStoredEvalRunnerResult(store, { id: 'candidate' });

const comparison = compareEvalRuns({
  baseline: baseline.data,
  candidate: candidate.data,
  labels: {
    baseline: 'current',
    candidate: candidate.metadata?.toolOverrideVariantId ?? 'candidate',
  },
});

await saveEvalRunComparison({
  store,
  comparison,
  id: 'candidate-vs-current',
});
