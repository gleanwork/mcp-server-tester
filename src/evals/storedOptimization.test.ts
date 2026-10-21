/**
 * A stored tool optimization, end to end: the use-case fixture's model client
 * (it calls the tool whose description mentions "postmortems") and a stdio
 * catalog server read from a copy of its catalog, so a test can change what
 * the server serves.
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { buildEvidence, renderEvidence } from './optimizationReport.js';
import { readOptimizationRecord } from './optimizationFormat.js';
import { readRunDirectory, runsDirectory } from './runFormat.js';
import {
  CandidateError,
  openToolOptimization,
  startToolOptimization,
} from './storedOptimization.js';
import { runToolOptimization } from './toolOptimization.js';

const FIXTURES = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../tests/usecases/fixtures'
);

const verbose = {
  id: 'verbose',
  description: 'Name what the search covers',
  tools: {
    search: {
      description:
        'Search documents by title and body: postmortems, runbooks and planning notes.',
    },
  },
};
const concise = {
  id: 'concise',
  tools: { search: { description: 'Search.' } },
};

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(
    dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true }))
  );
});

/** Six cases the base metadata fails and one held-out case. */
async function evalDir(): Promise<{ configPath: string; catalog: string }> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'stored-opt-'));
  dirs.push(dir);
  const catalog = path.join(dir, 'docs.json');
  await fs.copyFile(path.join(FIXTURES, 'catalogs', 'docs.json'), catalog);
  const cases = Array.from({ length: 7 }, (_, i) => ({
    id: `case-${i}`,
    input: `Find what we know about outage ${i}`,
    ...(i === 6 ? { tags: ['held-out'] } : {}),
    assertions: {
      toolsTriggered: { calls: [{ name: 'search', required: true }] },
    },
  }));
  await fs.writeFile(
    path.join(dir, 'cases.json'),
    JSON.stringify({ name: 'triggering', cases })
  );
  const configPath = path.join(dir, 'eval.json');
  await fs.writeFile(
    configPath,
    JSON.stringify({
      name: 'stored-optimization',
      datasets: ['./cases.json'],
      plugins: [path.join(FIXTURES, 'plugin.mjs')],
      servers: {
        docs: {
          transport: 'stdio',
          command: process.execPath,
          args: [path.join(FIXTURES, 'catalogServer.mjs'), catalog],
        },
      },
      client: 'usecase/client/model',
      clientOptions: {
        policy: [
          {
            steps: [
              {
                call: { description: 'postmortems' },
                args: { query: 'outage' },
              },
            ],
          },
        ],
      },
    })
  );
  return { configPath, catalog };
}

function target(configPath: string) {
  return { configPath, rootDir: path.dirname(configPath) };
}

async function runIds(evalDirectory: string): Promise<string[]> {
  return (await fs.readdir(runsDirectory(evalDirectory))).sort();
}

describe('stored tool optimization', () => {
  it('starts, tries a round, reopens and finishes with a recommendation', async () => {
    const { configPath } = await evalDir();
    const started = await startToolOptimization({
      evalConfig: target(configPath),
      editableTools: ['search'],
      maxVariants: 3,
    });
    expect(started.state.baselineValue).toBe(0);
    // No case is tagged regression, so a second run groups them.
    expect(started.record.grouping.source).toBe('grouping-run');
    expect(started.servedTools[0]?.tools.map((t) => t.name)).toEqual([
      'search',
      'read_document',
      'find_skills',
    ]);

    const tried = await started.tryCandidates([verbose, concise]);
    expect(
      tried.round.candidates.map((c) => [c.variant.id, c.metricValue])
    ).toEqual([
      ['verbose', 1],
      ['concise', 0],
    ]);
    expect(started.budget).toMatchObject({ tried: 2, left: 1 });
    // A round's verdicts already allow for every candidate tried, so finishing
    // can't take back a "clearly better".
    expect(tried.round.candidates.map((c) => c.fixes)).toEqual([true, false]);

    // Another process opens it and scores the same runs.
    const reopened = await openToolOptimization({
      evalConfig: target(configPath),
    });
    expect(reopened.id).toBe(started.id);
    expect(reopened.state.bestSoFar?.variant.id).toBe('verbose');
    expect(reopened.budget).toMatchObject({ tried: 2, left: 1 });

    const result = await reopened.finish();
    expect(result.proposal).toMatchObject({
      variantId: 'verbose',
      recommendation: 'apply',
    });
    const record = await readOptimizationRecord(reopened.directory);
    expect(record.finished).toMatchObject({
      reason: 'finished',
      recommendation: 'apply',
      variantId: 'verbose',
    });
    const recommendation = await fs.readFile(
      path.join(reopened.directory, 'recommendation.md'),
      'utf8'
    );
    expect(recommendation).toContain('apply `verbose`');
    expect(recommendation).toContain(
      'postmortems, runbooks and planning notes'
    );
    expect(recommendation).toContain(
      '| Capability cases (7, 1 held out) | 0% | 100%'
    );
    expect(recommendation).toContain(
      '| Held-out capability cases (1) | 0% | 100%'
    );

    // Every run is marked as the optimization's and none became latest.
    const ids = await runIds(reopened.evalDirectory);
    expect(ids).toHaveLength(3);
    const roles = await Promise.all(
      ids.map(async (id) => {
        const stored = await readRunDirectory(
          path.join(runsDirectory(reopened.evalDirectory), id)
        );
        return stored.run.optimization?.role;
      })
    );
    expect(roles.sort()).toEqual(['baseline', 'grouping', 'round']);
    await expect(
      fs.access(path.join(reopened.evalDirectory, 'latest.json'))
    ).rejects.toThrow();

    await expect(reopened.tryCandidates([concise])).rejects.toThrow(
      /is finished/
    );
  }, 120_000);

  it('refuses candidates that cannot run, before anything runs', async () => {
    const { configPath } = await evalDir();
    const optimization = await startToolOptimization({
      evalConfig: target(configPath),
      editableTools: ['search'],
      maxVariants: 2,
    });
    const before = await runIds(optimization.evalDirectory);

    const refused = async (candidates: unknown) => {
      const error = await optimization
        .tryCandidates(candidates)
        .catch((e: unknown) => e);
      expect(error).toBeInstanceOf(CandidateError);
      return (error as CandidateError).problems.join('\n');
    };
    expect(
      await refused([
        { id: 'x', tools: { serach: { description: 'Search.' } } },
      ])
    ).toMatch(/serach/);
    expect(
      await refused([
        { id: 'x', tools: { read_document: { description: 'Read.' } } },
      ])
    ).toMatch(/read_document/);
    expect(
      await refused([
        {
          id: 'x',
          tools: {
            search: {
              inputSchema: {
                type: 'object',
                properties: { q: { type: 'string' } },
              },
            },
          },
        },
      ])
    ).toMatch(/inputSchema/);
    expect(await refused([{ ...verbose, id: 'default' }])).toMatch(/default/);
    expect(
      await refused([verbose, concise, { ...concise, id: 'third' }])
    ).toMatch(/budget/);

    expect(await runIds(optimization.evalDirectory)).toEqual(before);
    expect(optimization.record.rounds).toEqual([]);
  }, 120_000);

  it('stops a round when the server serves different metadata', async () => {
    const { configPath, catalog } = await evalDir();
    const optimization = await startToolOptimization({
      evalConfig: target(configPath),
    });
    const served = JSON.parse(await fs.readFile(catalog, 'utf8')) as {
      tools: Array<{ description: string }>;
    };
    served.tools[1]!.description = 'Read a document by its id or URL.';
    await fs.writeFile(catalog, JSON.stringify(served));
    const before = await runIds(optimization.evalDirectory);

    await expect(optimization.tryCandidates([verbose])).rejects.toThrow(
      /read_document[\s\S]*start a new one/
    );
    expect(await runIds(optimization.evalDirectory)).toEqual(before);
    const record = await readOptimizationRecord(optimization.directory);
    expect(record.rounds).toEqual([]);
  }, 120_000);

  it('shows evidence without the held-out cases', async () => {
    const { configPath } = await evalDir();
    const optimization = await startToolOptimization({
      evalConfig: target(configPath),
      editableTools: ['search'],
    });
    await optimization.tryCandidates([concise]);
    const evidence = buildEvidence(optimization);
    expect(evidence.heldOutCases).toBe(1);
    expect(evidence.baseline.cases.map((c) => c.id)).not.toContain('case-6');
    expect(evidence.candidates[0]?.cases.map((c) => c.id)).not.toContain(
      'case-6'
    );
    expect(evidence.tools.map((t) => [t.name, t.editable])).toEqual([
      ['search', true],
      ['read_document', false],
      ['find_skills', false],
    ]);
    expect(evidence.baseline.cases[0]).toMatchObject({
      expected: 'must call search',
      passedTrials: 0,
      trials: 1,
    });
    const markdown = renderEvidence(evidence);
    expect(markdown).toContain('### search (editable)');
    expect(markdown).toContain('## Round 0');
    expect(markdown).not.toContain('case-6');
  }, 120_000);

  it('keeps runToolOptimization on an eval as one call', async () => {
    const { configPath } = await evalDir();
    const result = await runToolOptimization({
      evalConfig: target(configPath),
      variants: [concise, verbose],
      maxVariants: 1,
    });
    // The budget leaves out the second variant.
    expect(result.rounds[0]?.candidates.map((c) => c.variant.id)).toEqual([
      'concise',
    ]);
    expect(result.reason).toBe('max-variants');
    const reopened = await openToolOptimization({
      evalConfig: target(configPath),
    });
    expect(reopened.record.finished?.reason).toBe('max-variants');
  }, 120_000);
});
