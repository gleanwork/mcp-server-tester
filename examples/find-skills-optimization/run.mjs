// Run the find_skills description experiment on a client.
//
//   npm run build   # the example imports the package from dist
//   node examples/find-skills-optimization/run.mjs [--client mst|cowork]
//     [--model <id>] [--trials <n>] [--out <dir>] [--dry-run]
//
// --dry-run writes and validates the config and cases without calling a
// model.
//
// It writes an eval config with absolute paths (Cowork starts the server
// itself, so relative paths and a bare `node` would not resolve), then runs
// the baseline description and the candidates in variants.json against it.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import {
  runEvalSuite,
  runVariantExperiment,
} from '@gleanwork/mcp-server-tester/evals';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '../..');
const { values } = parseArgs({
  options: {
    client: { type: 'string', default: 'mst' },
    model: { type: 'string' },
    trials: { type: 'string', default: '3' },
    out: { type: 'string', default: path.join(here, '.mst') },
    'dry-run': { type: 'boolean', default: false },
  },
});
if (values.client !== 'mst' && values.client !== 'cowork')
  throw new Error('--client is mst or cowork');

const CLIENTS = {
  mst: {
    model: 'claude-haiku-4-5',
    clientOptions: { maxToolCalls: 4 },
  },
  cowork: {
    model: 'claude-sonnet-4-6',
    clientOptions: { computerUseProvider: 'anthropic-computer-use' },
    // Cowork asks before each MCP tool call; the case set never writes.
    coworkSetup: { approveWriteTools: true },
  },
};
const { model, ...client } = CLIENTS[values.client];
const out = path.resolve(values.out, values.client);
fs.mkdirSync(out, { recursive: true });

const config = {
  name: `find-skills-${values.client}`,
  datasets: [path.join(here, 'cases.json')],
  servers: [
    {
      transport: 'stdio',
      label: 'company',
      command: process.execPath,
      args: [
        path.join(repo, 'tests/usecases/fixtures/catalogServer.mjs'),
        path.join(here, 'catalog.json'),
      ],
    },
  ],
  client: values.client,
  model: values.model ?? model,
  ...client,
  trials: Number(values.trials),
  metrics: [
    'passed',
    'trial_pass',
    'mcp_call_count',
    'input_tokens',
    'output_tokens',
  ],
  // Keep answers: a reviewer reads why a case failed.
  redactStoredResponses: false,
  results: { store: { type: 'file', dir: './results' } },
};
const configPath = path.join(out, 'eval.json');
fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);

if (values['dry-run']) {
  const checked = await runEvalSuite({ configPath, dryRun: true });
  const cases = checked.datasets.reduce(
    (sum, item) => sum + (item.dataset?.cases.length ?? 0),
    0
  );
  console.log(`valid: ${configPath} (${cases} cases)`);
  process.exit(0);
}

const variants = JSON.parse(
  fs.readFileSync(path.join(here, 'variants.json'), 'utf8')
);
const result = await runVariantExperiment({
  suite: { configPath },
  variants,
  metric: 'passRate',
});
fs.writeFileSync(
  path.join(out, 'experiment.json'),
  `${JSON.stringify(result, null, 2)}\n`
);

function rate(run) {
  return run.total ? `${run.passed}/${run.total}` : 'n/a';
}
console.log(
  `client ${values.client}, model ${config.model}, trials ${config.trials}`
);
console.log(
  `baseline: ${rate(result.baseline)} cases passed (held-out cases excluded from the metric)`
);
for (const round of result.rounds)
  for (const candidate of round.candidates)
    console.log(
      `${candidate.variant.id}: passRate ${candidate.metricValue.toFixed(2)} (${candidate.metricDelta >= 0 ? '+' : ''}${candidate.metricDelta.toFixed(2)})${candidate.disqualified ? ', disqualified: breaks regression cases' : ''}`
    );
console.log(
  `recommendation: ${result.proposal?.recommendation ?? 'none'} (${result.reason})${result.winner ? `, winner ${result.winner.variant.id}` : ''}`
);
console.log(`results: ${out}`);
