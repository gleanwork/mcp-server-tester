import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  getDatasetSource,
  registerHost,
  registerJudge,
} from './frameworkRegistries.js';
import type { EvalManifest } from './evalManifest.js';
import { runEvalSuite } from './runEvalSuite.js';

// Exercise the copyable example against current source, not a stale dist build.
vi.mock('@gleanwork/mcp-server-tester', async () => ({
  ...(await import('./datasetLoader.js')),
  ...(await import('./frameworkRegistries.js')),
}));
const download = vi.hoisted(() => vi.fn());
vi.mock('@google-cloud/storage', () => ({
  Storage: class {
    bucket() {
      return {
        file() {
          return { download };
        },
      };
    }
  },
}));
import {
  convertLegacyGleanDataset,
  register,
  type LegacyFormat,
} from '../../examples/plugins/legacy-glean-datasets.js';

const manifest: EvalManifest = { name: 'legacy', datasets: [] };
const hostConfig = { provider: 'openai' as const };
register();

describe('opt-in glean-legacy source', () => {
  let rootDir: string;
  beforeEach(async () => {
    rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'legacy-source-'));
    vi.clearAllMocks();
  });
  afterEach(async () => {
    vi.unstubAllEnvs();
    await fs.rm(rootDir, { recursive: true, force: true });
  });

  it.each(['file', 'gcs'] as const)(
    'loads legacy JSON only through explicit %s transport and format',
    async (type) => {
      const raw = {
        cases: [
          {
            id: 'a',
            tool: 'search',
            args: { query: 'policy' },
            expect: { isError: false },
          },
        ],
      };
      await fs.writeFile(path.join(rootDir, 'cases.json'), JSON.stringify(raw));
      download.mockResolvedValue([Buffer.from(JSON.stringify(raw))]);
      const dataset = await getDatasetSource('glean-legacy').load(
        {
          type: 'glean-legacy',
          format: 'tool-call',
          transport:
            type === 'file'
              ? { type, path: 'cases.json' }
              : { type, uri: 'gs://bucket/cases.json' },
        },
        { rootDir, manifest }
      );
      expect(dataset.cases[0]).toMatchObject({
        toolName: 'search',
        args: { query: 'policy' },
        expect: { isError: false },
        tags: ['tool_call'],
      });
      expect(download).toHaveBeenCalledTimes(type === 'gcs' ? 1 : 0);
    }
  );

  it('requires explicit format rather than guessing from a first case', async () => {
    await expect(
      getDatasetSource('glean-legacy').load(
        {
          type: 'glean-legacy',
          transport: { type: 'file', path: 'never-read.json' },
        },
        { rootDir, manifest }
      )
    ).rejects.toThrow(/format/);
    expect(() =>
      convertLegacyGleanDataset(
        {
          cases: [
            { id: 'a', expected_tool: 'search', scenario: 'Find policy' },
            { id: 'b', tool: 'search' },
          ],
        },
        'tool-selection',
        hostConfig,
        manifest
      )
    ).toThrow(/case "b" requires expected_tool/);
  });

  it('preserves selection tags, expectations, iteration and accuracy defaults without ambient state', () => {
    vi.stubEnv('EVAL_ITERATIONS', '99');
    const raw = {
      cases: [
        {
          id: 'a',
          scenario: 'Find policy',
          expected_tool: 'search',
          tags: ['policy'],
        },
      ],
    };
    for (const iterations of [undefined, 1, 3]) {
      const dataset = convertLegacyGleanDataset(
        raw,
        'tool-selection',
        hostConfig,
        { ...manifest, iterations }
      );
      expect(dataset.cases[0]).toMatchObject({
        mode: 'mcp_host',
        iterations: iterations ?? 5,
        accuracyThreshold: iterations === 1 ? 1 : 0.8,
        tags: ['mcp_host', 'tool_selection', 'policy'],
        expect: {
          toolsTriggered: { calls: [{ name: 'search', required: true }] },
        },
      });
    }
    const dataset = convertLegacyGleanDataset(
      { cases: [{ ...raw.cases[0], iterations: 2, accuracyThreshold: 0.6 }] },
      'tool-selection',
      hostConfig,
      { ...manifest, iterations: 9 }
    );
    expect(dataset.cases[0]).toMatchObject({
      iterations: 2,
      accuracyThreshold: 0.6,
    });
  });

  it('retains tool-call defaults and explicit assertions', () => {
    const dataset = convertLegacyGleanDataset(
      {
        cases: [
          { id: 'default', tool: 'search' },
          {
            id: 'explicit',
            tool: 'search',
            mode: 'mcp_host',
            scenario: 'Find policy',
            iterations: 2,
            accuracyThreshold: 0.7,
            expect: {
              passesJudge: { judge: 'custom-quality', threshold: 0.9 },
            },
          },
        ],
      },
      'tool-call',
      hostConfig,
      { ...manifest, iterations: 8 }
    );
    expect(dataset.cases[0]?.expect).toEqual({
      isError: false,
      responseSize: { minBytes: 50 },
    });
    expect(dataset.cases[1]).toMatchObject({
      mode: 'mcp_host',
      iterations: 2,
      accuracyThreshold: 0.7,
      expect: { passesJudge: { judge: 'custom-quality', threshold: 0.9 } },
    });
  });

  it('preserves all legacy quality references and thresholds', () => {
    const dataset = convertLegacyGleanDataset(
      {
        cases: [
          {
            id: 'q',
            scenario: 'Question?',
            reference: 'Answer',
            iterations: 2,
            accuracyThreshold: 0.7,
          },
        ],
      },
      'e2e-quality',
      hostConfig,
      {
        ...manifest,
        judges: [
          'glean-completeness',
          'glean-correctness',
          'task-completion',
          'glean-rate-limit',
          'glean-timeout',
        ].map((type) => ({ type })),
      }
    );
    expect(dataset.cases[0]).toMatchObject({
      iterations: 2,
      accuracyThreshold: 0.7,
      tags: ['e2e_quality'],
    });
    expect(dataset.cases[0]?.expect?.passesJudge).toEqual([
      { judge: 'glean-completeness', reference: 'Question?', threshold: 0.5 },
      {
        judge: 'glean-correctness',
        reference: JSON.stringify({ question: 'Question?', answer: 'Answer' }),
        threshold: 0.5,
      },
      { judge: 'task-completion', reference: 'Question?', threshold: 0.5 },
      { judge: 'glean-rate-limit', reference: 'Question?', threshold: 0.5 },
      { judge: 'glean-timeout', reference: 'Question?', threshold: 0.5 },
    ]);
    const explicit = convertLegacyGleanDataset(
      { cases: [{ id: 'q', scenario: 'Question?' }] },
      'e2e-quality',
      hostConfig,
      { ...manifest, judges: [{ type: 'glean-completeness', threshold: 0.85 }] }
    );
    expect(explicit.cases[0]?.expect?.passesJudge).toEqual([
      { judge: 'glean-completeness', reference: 'Question?', threshold: 0.85 },
    ]);
  });

  it.each<LegacyFormat>(['tool-selection', 'tool-call', 'e2e-quality'])(
    'rejects unmapped manifest judges explicitly for %s',
    (format) => {
      expect(() =>
        convertLegacyGleanDataset(
          {
            cases: [
              {
                id: 'a',
                tool: 'search',
                expected_tool: 'search',
                scenario: 'Find policy',
              },
            ],
          },
          format,
          hostConfig,
          { ...manifest, judges: [{ type: 'custom-quality' }] }
        )
      ).toThrow(/cannot apply manifest judges: custom-quality/);
    }
  );

  it('rejects quality case assertions rather than silently dropping custom judges', () => {
    expect(() =>
      convertLegacyGleanDataset(
        {
          cases: [
            {
              id: 'q',
              scenario: 'Question?',
              expect: { passesJudge: { judge: 'custom-quality' } },
            },
          ],
        },
        'e2e-quality',
        hostConfig,
        manifest
      )
    ).toThrow(/cannot apply case expect assertions/);
  });

  it('requires references for correctness and host config for scenario conversion', () => {
    const raw = { cases: [{ id: 'q', scenario: 'Question?' }] };
    expect(() =>
      convertLegacyGleanDataset(raw, 'e2e-quality', hostConfig, {
        ...manifest,
        judges: [{ type: 'glean-correctness' }],
      })
    ).toThrow(/require a reference/);
    expect(() =>
      convertLegacyGleanDataset(raw, 'e2e-quality', undefined, manifest)
    ).toThrow(/requires a resolved host/);
    expect(
      convertLegacyGleanDataset(raw, 'e2e-quality', hostConfig, manifest)
        .cases[0]?.expect
    ).toBeUndefined();
  });

  it('applies maxCases only after validating the whole legacy dataset', () => {
    const raw = {
      cases: [
        { id: 'a', tool: 'search' },
        { id: 'b', tool: 'search' },
      ],
    };
    expect(
      convertLegacyGleanDataset(raw, 'tool-call', undefined, {
        ...manifest,
        maxCases: 1,
      }).cases
    ).toHaveLength(1);
    expect(() =>
      convertLegacyGleanDataset(
        { cases: [raw.cases[0], { id: 'b' }] },
        'tool-call',
        undefined,
        { ...manifest, maxCases: 1 }
      )
    ).toThrow(/requires tool/);
  });

  it('executes quality assertions from the source through the suite without live host calls', async () => {
    const evaluate = vi.fn(async () => ({
      score: 0.4,
      reasoning: 'below threshold',
    }));
    registerJudge({
      name: 'glean-completeness',
      schema: z.object({}).passthrough(),
      evaluate,
    });
    const run = vi.fn(async () => ({
      finalText: 'Candidate answer',
      events: [],
    }));
    registerHost({
      name: 'legacy-test-host',
      schema: z.object({}).passthrough(),
      createConfig: () => hostConfig,
      run,
    });
    await fs.writeFile(
      path.join(rootDir, 'quality.json'),
      JSON.stringify({ cases: [{ id: 'q', scenario: 'Question?' }] })
    );
    await fs.writeFile(
      path.join(rootDir, 'manifest.json'),
      JSON.stringify({
        name: 'legacy-execution',
        host: { type: 'legacy-test-host' },
        servers: [],
        datasets: [
          {
            type: 'glean-legacy',
            format: 'e2e-quality',
            transport: { type: 'file', path: 'quality.json' },
          },
        ],
        judges: [{ type: 'glean-completeness' }],
      })
    );
    const result = await runEvalSuite({
      manifestPath: path.join(rootDir, 'manifest.json'),
      rootDir,
    });
    expect(run).toHaveBeenCalledTimes(1);
    expect(evaluate).toHaveBeenCalledTimes(1);
    expect(result.summary.results[0]?.pass).toBe(false);
  });
});
