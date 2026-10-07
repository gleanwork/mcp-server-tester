// Public-package acceptance for the foundation layer. Build first; no TS loader or live services.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import {
  installPlugins,
  validateJudge,
  validateToolCalls,
  loadEvalDatasetFromObject,
  validateMCPConfig,
  runEvalDataset,
  expect as playwrightExpect,
} from '../dist/index.js';
import {
  validateEvalConfig,
  loadEvalConfigFromObject,
  FileEvalResultStore,
} from '../dist/evals.js';

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
        input: 'offline',
        assertions: { toolsTriggered: { calls } },
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
        kind: 'host',
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

// Validators and matchers called outside a runner or fixture see plugins installed here.
installPlugins([
  {
    meta: {
      name: 'foundation-plugin',
      version: '1.0.0',
      namespace: 'foundation',
    },
    judges: {
      policy: {
        schema: z.object({
          policy: z.string().transform((value) => value.toUpperCase()),
          limit: z.number().default(5),
        }),
        evaluate: async ({ case: evalCase, trial }, options) => {
          captured.push({
            candidate: trial.response,
            reference: evalCase.expected.answer,
            options,
          });
          return { score: options.policy === 'ALLOW' ? 1 : 0 };
        },
      },
      legacy: {
        schema: z.object({}).passthrough(),
        evaluate: async () => ({ score: 1 }),
      },
      'default-policy': {
        schema: z.object({ policy: z.string().default('allow') }).strict(),
        evaluate: async (_input, options) => ({
          score: options?.policy === 'allow' ? 1 : 0,
        }),
      },
    },
    datasetSources: {
      source: {
        schema: z.object({}),
        load: async () => ({ name: 'unused', cases: [] }),
      },
    },
    clients: {
      host: {
        schema: z.object({
          model: z.string(),
          count: z.number().transform((value) => value * 3),
        }),
        run: async () => ({ finalText: '', events: [] }),
      },
    },
  },
]);

try {
  assert.equal(
    (
      await validateJudge('candidate', {
        judge: 'foundation/policy',
        options: { policy: 'allow' },
      })
    ).pass,
    true
  );
  assert.deepEqual(captured[0].options, { policy: 'ALLOW', limit: 5 });
  assert.equal(
    (await validateJudge('candidate', { judge: 'foundation/legacy' })).pass,
    true
  );
  assert.equal(
    (await validateJudge('candidate', { judge: 'foundation/default-policy' }))
      .pass,
    true
  );
  assert.equal(
    (
      await validateJudge('candidate', {
        judge: 'foundation/default-policy',
        options: {},
      })
    ).pass,
    true
  );
  assert.equal(
    (
      await validateJudge('candidate', {
        judge: 'foundation/default-policy',
        options: undefined,
      })
    ).pass,
    true
  );
  console.log(
    'PASS: plugin judges reach the shared validator at this layer, including omitted/defaulted options.'
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
          input: 'offline',
          assertions: {
            passesJudge: {
              judge: 'foundation/policy',
              reference: 'golden',
              options: { policy },
            },
          },
        },
      ],
    });
    const result = await runEvalDataset(
      {
        dataset,
        executeCase: async () => ({
          kind: 'host',
          response: { success: true, toolCalls: [], response: 'candidate' },
        }),
      },
      {}
    );
    assert.equal(result.passed, passed);
  }
  await playwrightExpect('candidate').toPassToolJudge({
    judge: 'foundation/policy',
    options: { policy: 'allow' },
  });
  await playwrightExpect('candidate').toPassToolJudge({
    judge: 'foundation/default-policy',
  });
  assert.equal(
    (
      await validateJudge('candidate', {
        judge: 'foundation/policy',
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
    wrong.dataset.cases[0].assertions.toolsTriggered.calls[0],
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
  assert.equal(
    validateToolCalls(
      { success: true, toolCalls: [{ name: 'unexpected' }] },
      { calls: [], exclusive: true }
    ).pass,
    false
  );
  assert.equal(
    validateToolCalls(
      { success: true, toolCalls: [] },
      { calls: [], exclusive: true }
    ).pass,
    true
  );
  console.log(
    'PASS: source/server/kind selectors survive dataset loading; wrong provenance fails and skills match; empty exclusive lists reject unexpected calls.'
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
  assert.equal(observed.caseResults[0].traceEvidence, 'observed');
  const stored = await store.loadArtifact('eval-runner-result', 'observed');
  assert.equal(stored.data.caseResults[0].response, undefined);
  assert.equal(stored.data.caseResults[0].traceEvidence, 'observed');
  console.log(
    'PASS: observed evidence contributes no verified precision/recall and remains labeled after redaction.'
  );

  const evalConfig = loadEvalConfigFromObject(
    {
      name: 'patch',
      datasets: [{ type: 'foundation/source' }],
      client: 'foundation/host',
      model: 'base',
      clientOptions: { count: 2 },
      variants: [{ name: 'variant', model: 'variant' }],
    },
    { skipDatasetValidation: true }
  );
  const resolved = validateEvalConfig(evalConfig, {
    namespaces: ['foundation'],
  });
  assert.throws(
    () => validateEvalConfig(evalConfig, { namespaces: [] }),
    /doesn't load the "foundation" plugin/
  );
  assert.equal(resolved.clientOptions.count, 6);
  assert.deepEqual(
    {
      client: resolved.variants[0].client,
      model: resolved.variants[0].model,
      clientOptions: resolved.variants[0].clientOptions,
    },
    { client: 'foundation/host', model: 'variant', clientOptions: { count: 6 } }
  );
  assert.throws(() =>
    validateEvalConfig({
      ...evalConfig,
      variants: [{ name: 'bad', model: 17 }],
    })
  );
  console.log(
    'PASS: a variant that sets only its model inherits the client and options, validated once.'
  );

  const server = {
    transport: 'http',
    serverUrl: 'https://offline.invalid',
    label: 'agg',
  };
  const config = validateMCPConfig(server);
  const suite = loadEvalConfigFromObject(
    {
      name: 'config',
      datasets: [{ type: 'foundation/source' }],
      servers: [server],
    },
    { skipDatasetValidation: true }
  );
  assert.deepEqual(suite.servers[0], config);
  assert.equal(config.label, 'agg');
  assert.throws(() =>
    loadEvalConfigFromObject(
      {
        name: 'invalid',
        datasets: [{ type: 'foundation/source' }],
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
