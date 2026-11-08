import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import { runEval } from './runEval.js';
import { RUN_SCHEMAS } from './runFormat.js';
import { resetPluginsForTests } from '../plugins/extensions.js';
import type { Plugin } from '../plugins/plugin.js';
import type {
  ClientDefinition,
  ClientRunResult,
} from './evalFrameworkTypes.js';

const dirs: string[] = [];

afterEach(async () => {
  resetPluginsForTests();
  vi.restoreAllMocks();
  await Promise.all(
    dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true }))
  );
});

interface Fixture {
  run(): ReturnType<typeof runEval>;
  runDirectory(): Promise<string>;
}

/** A two-variant eval of cases `one` and `two` on `client`. */
async function fixture(
  client: Omit<ClientDefinition, 'schema'>,
  { trials = 1 }: { trials?: number } = {}
): Promise<Fixture> {
  const plugin: Plugin = {
    meta: { name: 'progress-test-plugin', namespace: 'test' },
    clients: {
      probe: {
        schema: z.object({ type: z.string() }),
        evidence: 'structured',
        ...client,
      },
    },
  };
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mst-run-progress-'));
  dirs.push(dir);
  await fs.writeFile(
    path.join(dir, 'cases.json'),
    JSON.stringify({
      name: 'cases',
      cases: ['one', 'two'].map((id) => ({
        id,
        input: id,
        assertions: { containsText: 'OK' },
      })),
    })
  );
  const configPath = path.join(dir, 'eval.json');
  await fs.writeFile(
    configPath,
    JSON.stringify({
      name: 'progress',
      client: 'test/client/probe',
      datasets: ['./cases.json'],
      servers: {},
      trials,
      variants: [{ name: 'baseline' }, { name: 'candidate' }],
    })
  );
  const outputDir = path.join(dir, 'out');
  return {
    run: () =>
      runEval({ configPath, rootDir: dir, plugins: [plugin], outputDir }),
    async runDirectory() {
      const runs = path.join(outputDir, 'runs');
      const [id] = await fs.readdir(runs);
      return path.join(runs, id!);
    },
  };
}

async function readJson<T>(file: string): Promise<T> {
  return JSON.parse(await fs.readFile(file, 'utf8')) as T;
}

const transcript = (variant: string, id: string, trial: number) =>
  path.join(variant, id, `${trial}.json`);

/** What the run has on disk so far: run.json's phases and variants, and its transcripts. */
async function onDisk(f: Fixture) {
  const runDirectory = await f.runDirectory();
  const run = await readJson<{
    phases: unknown;
    variants: Array<{ name: string }>;
  }>(path.join(runDirectory, 'run.json'));
  const transcripts = (
    await fs.readdir(path.join(runDirectory, 'transcripts'), {
      recursive: true,
    })
  )
    .filter((name) => name.endsWith('.json'))
    .sort();
  return {
    phases: run.phases,
    variants: run.variants.map((variant) => variant.name),
    transcripts,
  };
}

const ok = (): ClientRunResult => ({ finalText: 'OK', events: [] });

describe('a run saves each trial when it finishes', () => {
  it('for a client that runs one case at a time', async () => {
    const seen: Array<Awaited<ReturnType<typeof onDisk>>> = [];
    const f: Fixture = await fixture(
      {
        async run(input) {
          if (input.prompt === 'two' && seen.length === 0)
            seen.push(await onDisk(f));
          return ok();
        },
      },
      { trials: 2 }
    );
    await f.run();
    // Case one's trials are on disk while case two runs; the run says it
    // isn't finished.
    expect(seen).toEqual([
      {
        phases: { collect: 'partial', grade: 'partial' },
        variants: [],
        transcripts: [
          transcript('baseline', 'one', 0),
          transcript('baseline', 'one', 1),
        ],
      },
    ]);
  });

  it('for a batch client, as it reports each result', async () => {
    let seen: Awaited<ReturnType<typeof onDisk>> | undefined;
    const f: Fixture = await fixture({
      async open() {
        let index = 0;
        return {
          async run() {
            if (index++ === 1 && !seen) seen = await onDisk(f);
            return { result: ok(), continuation: 'continue' };
          },
          async reset() {},
          async close() {},
        };
      },
    });
    await f.run();
    expect(seen).toEqual({
      phases: { collect: 'partial', grade: 'partial' },
      variants: [],
      transcripts: [transcript('baseline', 'one', 0)],
    });
  });

  it('writes the trial record the run ends with', async () => {
    let early: Record<string, unknown> | undefined;
    const f: Fixture = await fixture({
      async open() {
        return {
          async run() {
            return { result: ok(), continuation: 'continue' };
          },
          async reset() {},
          async close() {
            early ??= await readJson(
              path.join(
                await f.runDirectory(),
                'transcripts',
                transcript('baseline', 'one', 0)
              )
            );
          },
        };
      },
    });
    await f.run();
    const final = await readJson<Record<string, unknown>>(
      path.join(
        await f.runDirectory(),
        'transcripts',
        transcript('baseline', 'one', 0)
      )
    );
    expect(RUN_SCHEMAS.trial.safeParse(early).success).toBe(true);
    // Grading adds to the trial's wall clock; nothing else changes.
    const { durationMs: _early, ...earlyRecord } = early!;
    const { durationMs: _final, ...finalRecord } = final;
    expect(earlyRecord).toEqual(finalRecord);
  });

  it('stores an early transcript redacted', async () => {
    let early: string | undefined;
    const f: Fixture = await fixture({
      async open() {
        return {
          async run() {
            return {
              result: { finalText: 'OK private answer', events: [] },
              continuation: 'continue',
            };
          },
          async reset() {},
          async close() {
            early ??= await fs.readFile(
              path.join(
                await f.runDirectory(),
                'transcripts',
                transcript('baseline', 'one', 0)
              ),
              'utf8'
            );
          },
        };
      },
    });
    await f.run();
    expect(early).toBeDefined();
    expect(early).not.toContain('private answer');
  });

  it('keeps earlier trials and records the failed trial when a session throws', async () => {
    const f: Fixture = await fixture({
      async open() {
        let index = 0;
        return {
          async run() {
            if (index++) throw new Error('the desktop went away');
            return { result: ok(), continuation: 'continue' };
          },
          async reset() {},
          async close() {},
        };
      },
    });
    const result = await f.run();
    expect(
      result.summary.results.filter((c) => c.id === 'one').every((c) => c.pass)
    ).toBe(true);
    expect(
      result.summary.results
        .filter((c) => c.id === 'two')
        .every((c) => c.error?.includes('the desktop went away'))
    ).toBe(true);
    expect((await onDisk(f)).transcripts).toHaveLength(4);
  });
});
