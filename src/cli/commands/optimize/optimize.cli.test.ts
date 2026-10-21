/**
 * `mst optimize` through the built CLI, as an agent drives it: start,
 * evidence, try, finish, each its own process. Uses the use-case fixtures'
 * model client, which calls the tool whose description mentions
 * "postmortems". Build first (`npm run build`).
 */
import { createBintastic, type BintasticProject } from 'bintastic';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const { setupProject, teardownProject, runBin } = createBintastic({
  binPath: fileURLToPath(
    new URL('../../../../dist/cli/index.js', import.meta.url)
  ),
});

const FIXTURES = fileURLToPath(
  new URL('../../../../tests/usecases/fixtures', import.meta.url)
);

describe('mst optimize', () => {
  let project: BintasticProject;

  beforeEach(async () => {
    project = await setupProject();
    await project.write({
      'cases.json': JSON.stringify({
        name: 'triggering',
        cases: [
          ...Array.from({ length: 6 }, (_, i) => ({
            id: `case-${i}`,
            input: `Find what we know about outage ${i}`,
            assertions: {
              toolsTriggered: { calls: [{ name: 'search', required: true }] },
            },
          })),
          {
            id: 'greeting',
            input: 'Hello there',
            tags: ['regression'],
            assertions: { toolCallCount: { max: 0 } },
          },
        ],
      }),
      'eval.json': JSON.stringify({
        name: 'optimize-cli',
        datasets: ['./cases.json'],
        plugins: [path.join(FIXTURES, 'plugin.mjs')],
        servers: {
          docs: {
            transport: 'stdio',
            command: process.execPath,
            args: [
              path.join(FIXTURES, 'catalogServer.mjs'),
              path.join(FIXTURES, 'catalogs', 'docs.json'),
            ],
          },
        },
        client: 'usecase/client/model',
        clientOptions: {
          policy: [
            { when: { inputStartsWith: 'Hello' }, steps: [] },
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
      }),
      'round-0.json': JSON.stringify([
        {
          id: 'covers',
          description: 'Name what search covers',
          tools: {
            search: {
              description:
                'Search documents by title and body: postmortems, runbooks and planning notes.',
            },
          },
        },
      ]),
      'bad.json': JSON.stringify([
        { id: 'covers', tools: { read_document: { description: 'Read.' } } },
      ]),
    });
  });

  afterEach(() => {
    teardownProject();
  });

  it('starts, shows evidence, tries a round and finishes', async () => {
    const start = await runBin(
      'optimize',
      'start',
      '-c',
      'eval.json',
      '--tool',
      'search',
      '--max-variants',
      '2'
    );
    expect(start.stderr).toBe('');
    expect(start.exitCode).toBe(0);
    expect(start.stdout).toMatch(/Started tool optimization \S+\./);
    expect(start.stdout).toContain('passRate 14.3%');
    expect(start.stdout).toContain('the ones tagged regression');
    expect(start.stdout).toContain('0 of 2 candidates tried, 2 left');
    expect(start.stdout).toContain(
      'Next: mst optimize evidence -c eval.json --id'
    );

    const evidence = await runBin('optimize', 'evidence', '-c', 'eval.json');
    expect(evidence.exitCode).toBe(0);
    expect(evidence.stdout).toContain('### search (editable)');
    expect(evidence.stdout).toContain(
      '`case-0` [capability] 0/1 trials passed.'
    );
    expect(evidence.stdout).toContain(
      '`greeting` [regression] 1/1 trials passed.'
    );
    expect(evidence.stdout).toContain('failed trial: (no tool calls)');

    const json = await runBin(
      'optimize',
      'evidence',
      '-c',
      'eval.json',
      '--json'
    );
    expect(JSON.parse(String(json.stdout))).toMatchObject({
      metric: 'passRate',
      budget: { maxVariants: 2, tried: 0, left: 2 },
      nextRound: 0,
    });

    // A refused candidate runs nothing and says why.
    const bad = await runBin('optimize', 'try', 'bad.json', '-c', 'eval.json');
    expect(bad.exitCode).toBe(1);
    expect(bad.stderr).toContain(
      "the optimization can't change this tool. Editable tools: search."
    );

    const tried = await runBin(
      'optimize',
      'try',
      'round-0.json',
      '-c',
      'eval.json'
    );
    expect(tried.stderr).toBe('');
    expect(tried.exitCode).toBe(0);
    expect(tried.stdout).toMatch(
      /covers\s+100\.0%\s+\+85\.7 pts\s+clearly better\n/
    );
    expect(tried.stdout).toContain('1 of 2 candidates tried, 1 left');

    const finish = await runBin('optimize', 'finish', '-c', 'eval.json');
    expect(finish.exitCode).toBe(0);
    expect(finish.stdout).toContain('Apply covers');
    const recommendation = String(finish.stdout).match(
      /Recommendation: (.+)/
    )?.[1];
    const markdown = await fs.readFile(
      path.join(project.baseDir, recommendation!.trim()),
      'utf8'
    );
    expect(markdown).toContain('apply `covers`');
    expect(markdown).toContain('| Capability cases (6) | 0% | 100%');
    expect(markdown).toContain('| Regression cases (1) | 100% | 100%');
  }, 120_000);

  it('says how to start when there is no optimization', async () => {
    const result = await runBin('optimize', 'evidence', '-c', 'eval.json');
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain(
      'has no tool optimization. Start one with mst optimize start.'
    );
  });
});
