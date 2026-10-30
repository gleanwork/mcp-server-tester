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

/** The words of the command a `Next:` line prints, after `mst`. */
function nextCommand(stdout: unknown): string[] {
  const line = String(stdout).match(
    /Next: mst (optimize evidence [^,\n]+)/
  )?.[1];
  expect(line).toBeDefined();
  return line!.trim().split(' ');
}

/**
 * Splits a printed command into words as a POSIX shell does, for the quoting
 * `mst` prints: '...', and \' between quoted parts.
 */
function shellWords(command: string): string[] {
  const words: string[] = [];
  let word = '';
  let quoted = false;
  let escaped = false;
  let started = false;
  for (const char of command) {
    if (escaped) {
      word += char;
      escaped = false;
    } else if (quoted) {
      if (char === "'") quoted = false;
      else word += char;
    } else if (char === "'") {
      quoted = true;
      started = true;
    } else if (char === '\\') {
      escaped = true;
      started = true;
    } else if (char === ' ') {
      if (started || word) words.push(word);
      word = '';
      started = false;
    } else word += char;
  }
  if (started || word) words.push(word);
  return words;
}

describe('mst optimize', () => {
  let project: BintasticProject;
  let files: Record<string, string>;

  beforeEach(async () => {
    project = await setupProject();
    files = {
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
      'not-json.json': '[{ id: covers }',
    };
    await project.write(files);
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

  it('prints Next: commands that find the optimization, and keeps its narrowing', async () => {
    // The eval in a directory of its own, with its results there too.
    await project.write({ evals: files });
    const start = await runBin(
      'optimize',
      'start',
      '-c',
      'evals/eval.json',
      '--root-dir',
      'evals',
      '--trials',
      '2',
      '--max-variants',
      '1'
    );
    // Two trials a case only warns.
    expect(start.stderr).not.toMatch(/error/i);
    expect(start.exitCode).toBe(0);
    await expect(
      fs.access(path.join(project.baseDir, 'evals', '.mcp-test-results'))
    ).resolves.toBeUndefined();

    // The printed command, as an agent copies it.
    const next = nextCommand(start.stdout);
    expect(next).toContain('--root-dir');
    const evidence = await runBin(...next);
    expect(evidence.stderr).not.toMatch(/error/i);
    expect(evidence.exitCode).toBe(0);
    // --trials 2 holds for every run of the optimization.
    expect(evidence.stdout).toContain(
      '`case-0` [capability] 0/2 trials passed.'
    );

    // Candidates from stdin, wrapped in { candidates }.
    const flags = next.slice(2);
    const round = JSON.parse(files['round-0.json']!) as unknown[];
    const tried = await runBin('optimize', 'try', '-', ...flags, {
      input: JSON.stringify({ candidates: round }),
    });
    expect(tried.stderr).not.toMatch(/error/i);
    expect(tried.exitCode).toBe(0);
    expect(tried.stdout).toContain('covers');
    expect(tried.stdout).toContain(
      'The budget is spent. Next: mst optimize finish'
    );

    const finish = await runBin('optimize', 'finish', ...flags);
    expect(finish.exitCode).toBe(0);
    const recommendation = String(finish.stdout).match(
      /Recommendation: (.+)/
    )?.[1];
    const markdown = await fs.readFile(
      path.join(project.baseDir, recommendation!.trim()),
      'utf8'
    );
    expect(markdown).toContain('It ended when the variant budget ran out');
  }, 120_000);

  it('prints Next: commands that keep every store flag, quoted, and records the proposer', async () => {
    // A secrets file is found from --root-dir.
    await project.write({
      'my evals': { ...files, "it's secret.json": '{}' },
    });
    const start = await runBin(
      'optimize',
      'start',
      '-c',
      'my evals/eval.json',
      '--root-dir',
      'my evals',
      '--output-dir',
      'my out',
      '--results',
      'file:my store',
      '--store',
      'my creds',
      '--secrets-file',
      "it's secret.json",
      '--max-variants',
      '2'
    );
    expect(start.stderr).not.toMatch(/error/i);
    expect(start.exitCode).toBe(0);
    const line = String(start.stdout).match(
      /Next: mst (optimize evidence [^\n]+)/
    )?.[1];
    expect(line).toBeDefined();
    const next = shellWords(line!);
    const id = next[next.indexOf('--id') + 1];
    expect(next).toEqual([
      'optimize',
      'evidence',
      '-c',
      'my evals/eval.json',
      '--output-dir',
      'my out',
      '--root-dir',
      'my evals',
      '--secrets-file',
      "it's secret.json",
      '--store',
      'my creds',
      '--results',
      'file:my store',
      '--id',
      id,
    ]);

    // The command as an agent copies it reopens the same optimization.
    const evidence = await runBin(...next);
    expect(evidence.stderr).not.toMatch(/error/i);
    expect(evidence.exitCode).toBe(0);
    expect(evidence.stdout).toContain('### search');

    const tried = await runBin(
      'optimize',
      'try',
      'round-0.json',
      ...next.slice(2),
      '--proposer',
      'Ada'
    );
    expect(tried.stderr).not.toMatch(/error/i);
    expect(tried.exitCode).toBe(0);
    const record = JSON.parse(
      await fs.readFile(
        path.join(
          project.baseDir,
          'my out',
          'optimizations',
          id!,
          'optimization.json'
        ),
        'utf8'
      )
    ) as { rounds: Array<{ proposer: string }> };
    expect(record.rounds.map((round) => round.proposer)).toEqual(['Ada']);
    // --results reached every run, the round's too.
    const stored = await fs.readdir(path.join(project.baseDir, 'my store'), {
      recursive: true,
    });
    expect(stored.length).toBeGreaterThan(0);
  }, 120_000);

  it('refuses bad flags and input, and finishes with nothing tried', async () => {
    const sideways = await runBin(
      'optimize',
      'start',
      '-c',
      'eval.json',
      '--better',
      'sideways'
    );
    expect(sideways.exitCode).toBe(1);
    expect(sideways.stderr).toContain(
      '--better must be higher or lower, got "sideways"'
    );
    const none = await runBin(
      'optimize',
      'start',
      '-c',
      'eval.json',
      '--max-variants',
      '0'
    );
    expect(none.exitCode).toBe(1);
    expect(none.stderr).toContain('--max-variants must be a positive integer');

    const start = await runBin('optimize', 'start', '-c', 'eval.json');
    expect(start.exitCode).toBe(0);
    const neither = await runBin('optimize', 'try', '-c', 'eval.json');
    expect(neither.exitCode).toBe(1);
    expect(neither.stderr).toContain('Give a candidates file');
    const both = await runBin(
      'optimize',
      'try',
      'round-0.json',
      '--retry',
      '-c',
      'eval.json'
    );
    expect(both.exitCode).toBe(1);
    expect(both.stderr).toContain(
      'Give a candidates file or --retry, not both.'
    );
    const retry = await runBin('optimize', 'try', '--retry', '-c', 'eval.json');
    expect(retry.exitCode).toBe(1);
    expect(retry.stderr).toContain('has no round to run again');
    const notJson = await runBin(
      'optimize',
      'try',
      'not-json.json',
      '-c',
      'eval.json'
    );
    expect(notJson.exitCode).toBe(1);
    expect(notJson.stderr).toContain("not-json.json isn't JSON");

    const finish = await runBin('optimize', 'finish', '-c', 'eval.json');
    expect(finish.exitCode).toBe(0);
    expect(finish.stdout).toContain(
      'No candidates ran, so there is nothing to recommend.'
    );
  }, 120_000);

  it('says how to start when there is no optimization', async () => {
    const result = await runBin('optimize', 'evidence', '-c', 'eval.json');
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain(
      'has no tool optimization. Start one with mst optimize start.'
    );
  });
});
