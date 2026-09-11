// Public-package acceptance for the foundation layer. Build first; no TS loader or live services.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import {
  registerJudge,
  registerHost,
  registerDatasetSource,
  validateJudge,
  validateManifestRegistrations,
  loadEvalManifestFromObject,
  loadEvalDatasetFromObject,
  validateMCPConfig,
  runEvalDataset,
  FileEvalResultStore,
  expect as playwrightExpect,
} from '../dist/index.js';

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'eval-foundation-'));
const captured = [];
// Any unexpected provider request is a test failure, not a live evaluation.
/** @type {(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>} */
const blockedFetch = async (_input, _init) => {
  throw new Error('Network prohibited in foundation acceptance');
};
globalThis.fetch = blockedFetch;

async function execute(
  calls,
  events,
  { evidence = 'structured', toolMap, store } = {}
) {
  const dataset = loadEvalDatasetFromObject({
    name: 'foundation',
    cases: [
      {
        id: 'one',
        mode: 'host',
        scenario: 'offline',
        expect: { toolsTriggered: { calls } },
      },
    ],
  });
  const result = await runEvalDataset(
    {
      dataset,
      toolMap,
      ...(store
        ? {
            resultStore: store,
            saveResultsTo: { store: true, ref: { id: 'observed' } },
          }
        : {}),
      executeCase: async () => ({
        evidence,
        response: {
          success: true,
          response: 'SYNTHETIC_RESPONSE',
          evidence,
          events,
          toolCalls: events.filter((event) => event.kind === 'tool_call'),
        },
      }),
    },
    {}
  );
  return { dataset, result };
}

try {
  registerJudge({
    name: 'foundation-policy',
    schema: z.object({
      policy: z.string().transform((value) => value.toUpperCase()),
      limit: z.number().default(5),
    }),
    evaluate: async (candidate, reference, options) => {
      captured.push({ candidate, reference, options });
      return { score: options.policy === 'ALLOW' ? 1 : 0 };
    },
  });
  assert.equal(
    (
      await validateJudge('candidate', {
        judge: 'foundation-policy',
        options: { policy: 'allow' },
      })
    ).pass,
    true
  );
  assert.deepEqual(captured[0].options, { policy: 'ALLOW', limit: 5 });
  registerJudge('foundation-legacy', async () => ({ score: 1 }));
  assert.equal(
    (await validateJudge('candidate', { judge: 'foundation-legacy' })).pass,
    true
  );
  console.log(
    'PASS: public object and legacy judge registration reach the shared validator at this layer.'
  );

  for (const [policy, passed] of [
    ['allow', 1],
    ['deny', 0],
  ]) {
    const dataset = loadEvalDatasetFromObject({
      name: 'policy',
      cases: [
        {
          id: policy,
          mode: 'host',
          scenario: 'offline',
          expect: {
            passesJudge: {
              judge: 'foundation-policy',
              reference: 'golden',
              options: { policy },
            },
          },
        },
      ],
    });
    const result = await runEvalDataset(
      { dataset, executeCase: async () => ({ response: 'candidate' }) },
      {}
    );
    assert.equal(result.passed, passed);
  }
  await playwrightExpect('candidate').toPassToolJudge({
    judge: 'foundation-policy',
    options: { policy: 'allow' },
  });
  assert.equal(
    (
      await validateJudge('candidate', {
        judge: 'foundation-policy',
        options: {},
      })
    ).pass,
    false
  );
  console.log(
    'PASS: schema transforms/defaults and distinct policies affect validator, evaluator, and matcher behavior.'
  );

  const expected = [
    { name: 'search', source: 'mcp', server: 'wanted', kind: 'tool_call' },
  ];
  const wrong = await execute(expected, [
    { kind: 'tool_call', name: 'search', source: 'host' },
  ]);
  assert.deepEqual(
    wrong.dataset.cases[0].expect.toolsTriggered.calls[0],
    expected[0]
  );
  assert.equal(wrong.result.failed, 1);
  const right = await execute(expected, [
    { kind: 'tool_call', name: 'search', source: 'mcp', server: 'wanted' },
  ]);
  assert.equal(right.result.passed, 1);
  const skill = await execute(
    [{ kind: 'skill', name: 'research', source: 'host' }],
    [{ kind: 'skill', name: 'research', source: 'host' }]
  );
  assert.equal(skill.result.passed, 1);
  console.log(
    'PASS: source/server/kind selectors survive dataset loading; wrong provenance fails and skills match.'
  );

  for (const alias of ['agg.native_search', 'native_search']) {
    const { result } = await execute(
      [{ name: 'search', source: 'mcp', server: 'agg' }],
      [
        {
          kind: 'tool_call',
          source: 'mcp',
          server: 'agg',
          name: 'native_search',
        },
      ],
      { toolMap: { search: [alias] } }
    );
    assert.equal(result.passed, 1);
  }
  console.log(
    'PASS: qualified and unqualified aliases match the same single-server event identity.'
  );

  const store = new FileEvalResultStore({
    provider: 'file',
    dir: path.join(root, 'store'),
  });
  const { result: observed } = await execute(
    [{ name: 'search' }],
    [{ kind: 'tool_call', source: 'host', name: 'search' }],
    { evidence: 'observed', store }
  );
  assert.equal(observed.failed, 1);
  assert.equal(observed.datasetToolPrecision, undefined);
  assert.equal(observed.datasetToolRecall, undefined);
  assert.equal(observed.caseResults[0].hostEvidence, 'observed');
  const stored = await store.loadArtifact('eval-runner-result', 'observed');
  assert.equal(stored.data.caseResults[0].response, undefined);
  assert.equal(stored.data.caseResults[0].hostEvidence, 'observed');
  console.log(
    'PASS: observed evidence contributes no verified precision/recall and remains labeled after redaction.'
  );

  registerDatasetSource({
    name: 'foundation-source',
    schema: z.object({}),
    load: async () => ({ name: 'unused', cases: [] }),
  });
  registerHost({
    name: 'foundation-host',
    schema: z.object({
      model: z.string(),
      count: z.number().transform((value) => value * 3),
    }),
  });
  const manifest = loadEvalManifestFromObject(
    {
      name: 'patch',
      datasets: [{ type: 'foundation-source' }],
      host: { type: 'foundation-host', model: 'base', count: 2 },
      arms: [{ name: 'variant', host: { model: 'variant' } }],
    },
    { skipDatasetValidation: true }
  );
  const resolved = validateManifestRegistrations(manifest);
  assert.equal(resolved.host.count, 6);
  assert.deepEqual(resolved.arms[0].host, {
    type: 'foundation-host',
    model: 'variant',
    count: 6,
  });
  assert.throws(() =>
    validateManifestRegistrations({
      ...manifest,
      arms: [{ name: 'bad', host: { model: 17 } }],
    })
  );
  console.log(
    'PASS: partial arm hosts inherit the tag and validate the merged raw configuration once.'
  );

  const server = {
    transport: 'http',
    serverUrl: 'https://offline.invalid',
    label: 'agg',
  };
  const config = validateMCPConfig(server);
  const suite = loadEvalManifestFromObject(
    {
      name: 'config',
      datasets: [{ type: 'foundation-source' }],
      servers: [server],
    },
    { skipDatasetValidation: true }
  );
  assert.deepEqual(suite.servers[0], config);
  assert.equal(config.label, 'agg');
  assert.throws(() =>
    loadEvalManifestFromObject(
      {
        name: 'invalid',
        datasets: [{ type: 'foundation-source' }],
        servers: [{ ...server, serverUrl: 17 }],
      },
      { skipDatasetValidation: true }
    )
  );
  console.log(
    'PASS: suite servers share canonical MCP configuration validation and preserve labels.'
  );
} finally {
  await fs.rm(root, { recursive: true, force: true });
}
