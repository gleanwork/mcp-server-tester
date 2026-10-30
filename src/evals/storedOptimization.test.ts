/**
 * A stored tool optimization, end to end: the use-case fixture's model client
 * (it calls the tool whose description mentions "postmortems") and a stdio
 * catalog server read from a copy of its catalog, so a test can change what
 * the server serves.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { buildEvidence, renderEvidence } from './optimizationReport.js';
import {
  readOptimizationRecord,
  writeOptimizationRecord,
} from './optimizationFormat.js';
import { resumeRun } from './runEval.js';
import { readRunDirectory, runsDirectory } from './runFormat.js';
import {
  CandidateError,
  openToolOptimization,
  startToolOptimization,
} from './storedOptimization.js';
import { runToolOptimization } from './toolOptimization.js';
import type { ProposeVariantsContext } from './toolOptimization.js';

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

/**
 * Cases the base metadata fails, the last one held out: seven by default.
 * `judges` are the eval config's.
 */
async function evalDir(
  options: { cases?: number; judges?: unknown[]; regression?: boolean } = {}
): Promise<{ configPath: string; catalog: string }> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'stored-opt-'));
  dirs.push(dir);
  const catalog = path.join(dir, 'docs.json');
  await fs.copyFile(path.join(FIXTURES, 'catalogs', 'docs.json'), catalog);
  const count = options.cases ?? 7;
  const cases = Array.from({ length: count }, (_, i) => ({
    id: `case-${i}`,
    input: `Find what we know about outage ${i}`,
    ...(i === count - 1 ? { tags: ['held-out'] } : {}),
    assertions: {
      toolsTriggered: { calls: [{ name: 'search', required: true }] },
    },
  }));
  // Works today (no tool call) and breaks once the model finds search.
  if (options.regression)
    cases.push({
      id: 'no-search',
      input: 'Say hello',
      tags: ['regression'],
      assertions: { toolCallCount: { max: 0 } },
    } as unknown as (typeof cases)[number]);
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
      ...(options.judges ? { judges: options.judges } : {}),
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

async function editJson(
  file: string,
  edit: (value: Record<string, unknown>) => void
): Promise<void> {
  const value = JSON.parse(await fs.readFile(file, 'utf8')) as Record<
    string,
    unknown
  >;
  edit(value);
  await fs.writeFile(file, JSON.stringify(value));
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

  it('judges an earlier round again when a later round adds a candidate', async () => {
    // Six cases that all flip: p = 1/64, below 0.025 with one candidate
    // tried but not with two (0.0125).
    const { configPath } = await evalDir({ cases: 6 });
    const optimization = await startToolOptimization({
      evalConfig: target(configPath),
    });
    const first = await optimization.tryCandidates([verbose]);
    expect(first.round.candidates.map((c) => c.fixes)).toEqual([true]);

    await optimization.tryCandidates([concise]);
    expect(optimization.state.rounds[0]?.candidates[0]?.fixes).toBe(false);
    const reopened = await openToolOptimization({
      evalConfig: target(configPath),
    });
    expect(reopened.state.rounds[0]?.candidates[0]?.fixes).toBe(false);
    expect((await reopened.finish()).proposal?.recommendation).toBe(
      'inconclusive'
    );
    const recommendation = await fs.readFile(
      path.join(reopened.directory, 'recommendation.md'),
      'utf8'
    );
    expect(recommendation).toContain(
      'inconclusive: no candidate is clearly better than the current metadata'
    );
    expect(recommendation).toContain("## `verbose`'s tool metadata");
    expect(recommendation).toContain('divided by the 2 candidates tried');
  }, 120_000);

  it('recommends rejecting a candidate that breaks working cases', async () => {
    const { configPath } = await evalDir({ regression: true });
    const optimization = await startToolOptimization({
      evalConfig: target(configPath),
      // One case: the default (significant) check would call it noise.
      regressionCheck: 'any-case',
    });
    expect(optimization.record.grouping.source).toBe('declared');
    await optimization.tryCandidates([
      {
        ...verbose,
        tools: {
          search: {
            ...verbose.tools.search,
            inputSchema: {
              type: 'object',
              properties: {
                query: { type: 'string', description: 'Words to look for.' },
                id: { type: 'string' },
              },
            },
          },
        },
      },
    ]);
    const result = await optimization.finish();
    expect(result.proposal?.recommendation).toBe('reject');
    const recommendation = await fs.readFile(
      path.join(optimization.directory, 'recommendation.md'),
      'utf8'
    );
    expect(recommendation).toContain(
      'reject: the best candidate, `verbose`, breaks cases that work today'
    );
    expect(recommendation).toMatch(/\| Regression cases \(1\) \| 100% \| 0%/);
    expect(recommendation).toContain('Parameter descriptions:');
    expect(recommendation).toContain('Words to look for.');
  }, 120_000);

  it('refuses a round when the datasets changed since the baseline', async () => {
    const { configPath } = await evalDir();
    const optimization = await startToolOptimization({
      evalConfig: target(configPath),
    });
    await editJson(path.join(path.dirname(configPath), 'cases.json'), (d) => {
      (d.cases as Array<{ input: string }>)[0]!.input = 'Something else';
    });
    const before = await runIds(optimization.evalDirectory);
    await expect(optimization.tryCandidates([verbose])).rejects.toThrow(
      /datasets changed[\s\S]*Nothing ran/
    );
    // Refused before any client started: no run.
    expect(await runIds(optimization.evalDirectory)).toEqual(before);
    const record = await readOptimizationRecord(optimization.directory);
    expect(record.rounds).toEqual([]);
  }, 120_000);

  it("refuses a round when a judge's options changed since the baseline", async () => {
    const { configPath } = await evalDir({
      judges: [{ type: 'usecase/judge/keywords', keywords: ['outage'] }],
    });
    const optimization = await startToolOptimization({
      evalConfig: target(configPath),
    });
    await editJson(configPath, (config) => {
      config.judges = [
        { type: 'usecase/judge/keywords', keywords: ['incident'] },
      ];
    });
    const before = await runIds(optimization.evalDirectory);
    await expect(optimization.tryCandidates([verbose])).rejects.toThrow(
      /judges or their options changed/
    );
    expect(await runIds(optimization.evalDirectory)).toEqual(before);
  }, 120_000);

  it("refuses a round when the base variant's setup changed, not for its own judges", async () => {
    const { configPath } = await evalDir();
    // The base variant's own judges: a round's candidates have them too,
    // under the candidates' names.
    await editJson(configPath, (config) => {
      config.variants = [
        {
          name: 'base',
          judges: [{ type: 'usecase/judge/keywords', keywords: ['outage'] }],
        },
        { name: 'other' },
      ];
    });
    const optimization = await startToolOptimization({
      evalConfig: target(configPath),
    });
    const { round } = await optimization.tryCandidates([verbose]);
    expect(round.candidates.map((c) => c.variant.id)).toEqual(['verbose']);

    await editJson(configPath, (config) => {
      (config.variants as Array<Record<string, unknown>>)[0]!.inputTemplate =
        'Please: {{input}}';
    });
    const before = await runIds(optimization.evalDirectory);
    await expect(optimization.tryCandidates([concise])).rejects.toThrow(
      /base variant's client, model, options, input template or judges changed/
    );
    expect(await runIds(optimization.evalDirectory)).toEqual(before);
  }, 120_000);

  it('gives proposeVariants the stored, redacted history', async () => {
    const { configPath } = await evalDir();
    const seen: ProposeVariantsContext[] = [];
    await runToolOptimization({
      evalConfig: target(configPath),
      variants: [verbose],
      maxRounds: 2,
      proposeVariants: async (context) => {
        seen.push(context);
        return [];
      },
    });
    expect(seen).toHaveLength(1);
    const [context] = seen;
    expect(context!.round).toBe(1);
    expect(
      context!.history.map((r) => r.candidates.map((c) => c.variant.id))
    ).toEqual([['verbose']]);
    const baselineCases = context!.baseline.caseResults;
    // Without the held-out case, and as stored: traces without answers or
    // tool outputs.
    expect(baselineCases.map((c) => c.id)).not.toContain('case-6');
    const trace = baselineCases[0]!.trace;
    expect(trace).toBeDefined();
    expect(trace!.finalText).toBeUndefined();
    const candidate = context!.history[0]!.candidates[0]!.result.caseResults;
    const events = candidate.flatMap((c) => c.trace?.events ?? []);
    expect(events.some((event) => event.kind === 'tool_call')).toBe(true);
    expect(events.every((event) => !('output' in event))).toBe(true);
  }, 120_000);

  it('runs a round that did not finish again, and nothing else until then', async () => {
    const { configPath } = await evalDir();
    const started = await startToolOptimization({
      evalConfig: target(configPath),
    });
    // As a round whose run threw leaves the record: no run.
    started.record.rounds.push({
      round: 0,
      createdAt: new Date().toISOString(),
      proposer: 'agent',
      candidates: [verbose],
    });
    await writeOptimizationRecord(started.evalDirectory, started.record);

    const reopened = await openToolOptimization({
      evalConfig: target(configPath),
    });
    expect(reopened.pendingRound?.round).toBe(0);
    await expect(reopened.tryCandidates([concise])).rejects.toThrow(
      /Round 0 didn't finish/
    );
    const retried = await reopened.retry();
    expect(retried.round.candidates.map((c) => c.metricValue)).toEqual([1]);
    expect(reopened.pendingRound).toBeUndefined();
    await expect(reopened.retry()).rejects.toThrow(/no round to run again/);
    const record = await readOptimizationRecord(reopened.directory);
    expect(record.rounds[0]?.runId).toBe(retried.runId);
  }, 120_000);

  it('runs a round whose run is missing trials again, instead of resuming it', async () => {
    const { configPath } = await evalDir();
    const optimization = await startToolOptimization({
      evalConfig: target(configPath),
    });
    const { runId } = await optimization.tryCandidates([concise]);
    const runJson = path.join(
      runsDirectory(optimization.evalDirectory),
      runId,
      'run.json'
    );
    await editJson(runJson, (run) => {
      (run.phases as { collect: string }).collect = 'partial';
    });
    // Resumed trials would run against unchecked tools.
    await expect(
      resumeRun({ run: runId, configPath, rootDir: path.dirname(configPath) })
    ).rejects.toThrow(/isn't resumed[\s\S]*mst optimize try --retry/);

    const reopened = await openToolOptimization({
      evalConfig: target(configPath),
    });
    expect(reopened.pendingRound?.round).toBe(0);
    expect(reopened.state.rounds).toEqual([]);
    await expect(reopened.tryCandidates([verbose])).rejects.toThrow(
      /Round 0 didn't finish/
    );
    const retried = await reopened.retry();
    expect(retried.runId).not.toBe(runId);
    expect(retried.round.candidates.map((c) => c.variant.id)).toEqual([
      'concise',
    ]);
    const record = await readOptimizationRecord(reopened.directory);
    expect(record.rounds.map((round) => round.runId)).toEqual([retried.runId]);
  }, 120_000);

  it('keeps a complete run when storing it in the result store fails', async () => {
    const { configPath } = await evalDir();
    // A file where the store's directory would go: every upload fails.
    const blocker = path.join(path.dirname(configPath), 'blocker');
    await fs.writeFile(blocker, '');
    const evalConfig = {
      ...target(configPath),
      results: `file:${path.join(blocker, 'runs')}`,
    };
    const optimization = await startToolOptimization({ evalConfig });
    expect(optimization.record.grouping.runId).toBeDefined();
    const tried = await optimization.tryCandidates([verbose]);
    expect(tried.round.candidates.map((c) => c.metricValue)).toEqual([1]);
    const record = await readOptimizationRecord(optimization.directory);
    expect(record.rounds[0]?.runId).toBe(tried.runId);
    // Each run once: nothing was collected again.
    expect(await runIds(optimization.evalDirectory)).toHaveLength(3);
  }, 120_000);

  it('runs the grouping run before the next round when it is still to run', async () => {
    const { configPath } = await evalDir();
    const started = await startToolOptimization({
      evalConfig: target(configPath),
    });
    // As a stop during the grouping run leaves the record.
    started.record.grouping = { source: 'grouping-run' };
    await writeOptimizationRecord(started.evalDirectory, started.record);

    const reopened = await openToolOptimization({
      evalConfig: target(configPath),
    });
    expect(reopened.state.grouping).toBeUndefined();
    const before = await runIds(reopened.evalDirectory);
    await reopened.tryCandidates([verbose]);
    const record = await readOptimizationRecord(reopened.directory);
    expect(record.grouping.runId).toBeDefined();
    expect(record.grouping.runId).not.toBe(started.record.grouping.runId);
    expect(reopened.state.grouping).toBeDefined();
    expect(await runIds(reopened.evalDirectory)).toHaveLength(
      before.length + 2
    );
  }, 120_000);

  it('lets one process step an optimization at a time', async () => {
    const { configPath } = await evalDir();
    const optimization = await startToolOptimization({
      evalConfig: target(configPath),
    });
    const lock = path.join(optimization.directory, 'lock');
    const holder = {
      pid: process.pid,
      host: os.hostname(),
      since: new Date().toISOString(),
      step: 'run a round',
    };
    await fs.writeFile(lock, JSON.stringify(holder));
    await expect(optimization.tryCandidates([verbose])).rejects.toThrow(
      new RegExp(`in use: process ${process.pid}[\\s\\S]*delete`)
    );
    await expect(optimization.finish()).rejects.toThrow(/in use/);

    // A lock whose process is gone is taken over.
    const gone = spawnSync(process.execPath, ['-e', '']).pid;
    await fs.writeFile(lock, JSON.stringify({ ...holder, pid: gone }));
    await optimization.tryCandidates([verbose]);
    await expect(fs.access(lock)).rejects.toThrow();

    // A session whose record another process stepped since it read it.
    const first = await openToolOptimization({
      evalConfig: target(configPath),
    });
    const second = await openToolOptimization({
      evalConfig: target(configPath),
    });
    await second.tryCandidates([concise]);
    await expect(first.finish()).rejects.toThrow(/changed since this process/);
    const record = await readOptimizationRecord(optimization.directory);
    expect(record.rounds).toHaveLength(2);
    expect(record.finished).toBeUndefined();
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
