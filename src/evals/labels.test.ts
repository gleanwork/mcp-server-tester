import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import { gradeRun, runEval } from './runEval.js';
import { resetPluginsForTests } from '../plugins/extensions.js';
import type { Plugin } from '../plugins/plugin.js';
import {
  checkImportedLabels,
  defaultSplit,
  formatLabels,
  judgedItems,
  parseCsv,
  parseLabels,
  readLabels,
  writeLabels,
} from './labels.js';
import {
  labelRecordPath,
  parseLabelRecord,
  readRunDirectory,
} from './runFormat.js';
import { labelExport, labelImport } from '../cli/commands/label/index.js';
import { resolveRunArgument } from '../cli/runArgument.js';

const dirs: string[] = [];

afterEach(async () => {
  resetPluginsForTests();
  await Promise.all(
    dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true }))
  );
});

/**
 * A stored run: two variants, two cases, two trials each, graded by a
 * keyword judge (it passes answers that name the certificate) and a pairwise
 * judge that prefers the longer answer.
 */
async function storedRun(
  options: {
    redact?: boolean;
    /** Add a second judge, which fails on every trial. */
    brokenJudge?: boolean;
  } = {}
) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mst-labels-'));
  dirs.push(dir);
  const plugin: Plugin = {
    meta: { name: 'labels-test-plugin', namespace: 'lb' },
    clients: {
      scripted: {
        schema: z.object({ type: z.string() }).passthrough(),
        evidence: 'structured',
        async run(input, _config, context) {
          const better = context.variant?.name === 'better';
          return {
            finalText: better
              ? `=SUM(A1) ${input.prompt}: the certificate expired, "after 41 minutes"`
              : `${input.prompt}: a deploy failed`,
            events: [],
            usage: { inputTokens: 1, outputTokens: 1, durationMs: 1 },
          };
        },
      },
    },
    judges: {
      keyword: {
        schema: z.object({ keyword: z.string() }).strict(),
        async evaluate({ trial }, judgeOptions) {
          return {
            score: trial.text?.includes(String(judgeOptions.keyword)) ? 1 : 0,
            reasoning: `looked for ${String(judgeOptions.keyword)}`,
          };
        },
      },
      broken: {
        schema: z.object({}).strict(),
        async evaluate() {
          throw new Error('the judge model is down');
        },
      },
    },
    pairwiseJudges: {
      longer: {
        schema: z.object({}).strict(),
        async compare({ baseline, candidate }) {
          return {
            preference:
              (candidate.text?.length ?? 0) > (baseline.text?.length ?? 0)
                ? ('candidate' as const)
                : ('tie' as const),
          };
        },
      },
    },
  };
  await fs.writeFile(
    path.join(dir, 'dataset.json'),
    JSON.stringify({
      name: 'outages',
      cases: [
        { id: 'cause', input: 'Why did checkout fail' },
        { id: 'duration', input: 'How long was checkout down' },
      ],
    })
  );
  await fs.writeFile(
    path.join(dir, 'eval.json'),
    JSON.stringify({
      name: 'labels-test',
      datasets: ['./dataset.json'],
      client: 'lb/client/scripted',
      trials: 2,
      redactStoredResponses: options.redact ?? false,
      servers: { docs: { transport: 'stdio', command: 'docs-server' } },
      judges: [
        { type: 'lb/judge/keyword', keyword: 'certificate' },
        ...(options.brokenJudge ? [{ type: 'lb/judge/broken' }] : []),
      ],
      pairwiseJudges: ['lb/pairwise-judge/longer'],
      variants: [
        { name: 'baseline', servers: ['docs'] },
        { name: 'better', servers: ['docs'] },
      ],
    })
  );
  const base = {
    configPath: path.join(dir, 'eval.json'),
    rootDir: dir,
    plugins: [plugin],
    report: false,
  };
  const result = await runEval(base);
  return { dir, base, directory: result.outputDir };
}

function capture() {
  const out: string[] = [];
  return { out, write: (text: string) => void out.push(text) };
}

describe('labels', () => {
  it("lists each judge's verdicts: per trial, and per case for a pairwise judge", async () => {
    const t = await storedRun();
    const items = judgedItems(await readRunDirectory(t.directory));
    const pointwise = items.filter((item) => item.trial !== undefined);
    expect(pointwise).toHaveLength(8);
    expect(new Set(pointwise.map((item) => item.judge))).toEqual(
      new Set(['lb/judge/keyword'])
    );
    expect(
      pointwise
        .filter((item) => item.variant === 'better')
        .every((item) => item.verdict === 'pass' && item.judgeIdentity)
    ).toBe(true);
    expect(
      pointwise
        .filter((item) => item.variant === 'baseline')
        .map((item) => item.verdict)
    ).toEqual(['fail', 'fail', 'fail', 'fail']);
    expect(pointwise[0]).toMatchObject({
      input: 'Why did checkout fail',
      answer: 'Why did checkout fail: a deploy failed',
    });
    const pairwise = items.filter((item) => item.baseline !== undefined);
    expect(pairwise).toEqual([
      expect.objectContaining({
        judge: 'lb/pairwise-judge/longer',
        variant: 'better',
        baseline: 'baseline',
        caseId: 'cause',
        verdict: 'candidate',
      }),
      expect.objectContaining({ caseId: 'duration', verdict: 'candidate' }),
    ]);
  });

  it('exports a sheet to fill in, and imports its labels into the run', async () => {
    const t = await storedRun();
    const sheet = path.join(t.dir, 'labels.csv');
    const err = capture();
    await labelExport(t.directory, { output: sheet }, undefined, err.write);
    expect(err.out.join('')).toContain('Wrote 10 verdicts and 0 labels');
    const rows = parseCsv(await fs.readFile(sheet, 'utf8'));
    expect(rows[0]).toEqual([
      'judge',
      'criterion',
      'variant',
      'baseline',
      'caseId',
      'trial',
      'split',
      'verdict',
      'label',
      'labeler',
      'labeledAt',
      'note',
      'input',
      'answer',
    ]);
    expect(rows).toHaveLength(11);
    // An answer a spreadsheet would run as a formula reads back as written.
    const better = rows.find((row) => row[2] === 'better' && row[5] === '0')!;
    expect(better[13]).toMatch(/^=SUM\(A1\) .*"after 41 minutes"$/);
    expect(await fs.readFile(sheet, 'utf8')).toContain(`"'=SUM(A1)`);

    // A person disagrees with one verdict and agrees with the others.
    const filled = rows.map((row, index) => {
      if (index === 0) return row;
      const copy = [...row];
      copy[8] =
        copy[3] !== ''
          ? 'candidate'
          : copy[2] === 'baseline' && copy[4] === 'cause' && copy[5] === '0'
            ? 'pass'
            : copy[7]!;
      return copy;
    });
    const csv = filled
      .map((row) =>
        row
          .map((cell) =>
            /[",\n]/.test(cell) ? `"${cell.replace(/"/g, '""')}"` : cell
          )
          .join(',')
      )
      .join('\n');
    await fs.writeFile(sheet, csv);
    const out = capture();
    await labelImport(t.directory, sheet, { labeler: 'ana' }, out.write);
    expect(out.out.join('')).toMatch(/^Imported 10 labels into /);

    const labels = await readLabels(t.directory);
    expect(labels).toHaveLength(10);
    expect(labels.every((label) => label.labeler === 'ana')).toBe(true);
    expect(
      labels.every((label) => label.split === defaultSplit(label.caseId))
    ).toBe(true);
    const disagreed = labels.find(
      (label) =>
        label.variant === 'baseline' &&
        label.caseId === 'cause' &&
        'trial' in label &&
        label.trial === 0
    );
    expect(disagreed?.label).toBe('pass');
    await expect(
      fs.stat(
        path.join(
          t.directory,
          'labels',
          'lb%2Fjudge%2Fkeyword',
          'baseline',
          'cause',
          '0.json'
        )
      )
    ).resolves.toBeDefined();
    await expect(
      fs.stat(
        path.join(
          t.directory,
          'labels',
          'lb%2Fpairwise-judge%2Flonger',
          'better',
          'cause',
          'vs',
          'baseline.json'
        )
      )
    ).resolves.toBeDefined();

    // The export now carries the labels; JSONL reads back the same.
    const jsonl = capture();
    await labelExport(t.directory, { format: 'jsonl' }, jsonl.write);
    const lines = jsonl.out.join('').trim().split('\n');
    expect(lines).toHaveLength(10);
    expect(
      checkImportedLabels(
        parseLabels('jsonl', jsonl.out.join(''), 'labels.jsonl'),
        judgedItems(await readRunDirectory(t.directory)),
        labels
      ).map((label) => [label.judge, label.label, label.labeler])
    ).toEqual(labels.map((label) => [label.judge, label.label, 'ana']));
  });

  it("writes judgekeeper's records, and reads its human labels back", async () => {
    const t = await storedRun();
    const stored = await readRunDirectory(t.directory);
    const items = judgedItems(stored);
    const [label] = checkImportedLabels(
      [
        {
          judge: 'lb/judge/keyword',
          variant: 'baseline',
          caseId: 'cause',
          trial: 1,
          label: 'fail',
          source: 'test',
        },
      ],
      items,
      [],
      { labeler: 'ana', now: new Date('2026-10-30T00:00:00Z') }
    );
    const records = formatLabels('judgekeeper', stored, items, [label!])
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    // One LLM record per pass/fail verdict; pairwise verdicts are left out.
    expect(
      records.filter((record) => record.annotator_kind === 'LLM')
    ).toHaveLength(8);
    const human = records.filter((record) => record.annotator_kind === 'HUMAN');
    expect(human).toEqual([
      {
        schema_version: 2,
        target_id: 'baseline/cause/1',
        name: 'lb/judge/keyword',
        annotator_kind: 'HUMAN',
        label: 'fail',
        created_at: '2026-10-30T00:00:00.000Z',
        metadata: {
          mst: {
            runId: stored.run.runId,
            variant: 'baseline',
            caseId: 'cause',
            trial: 1,
            split: defaultSplit('cause'),
            labeler: 'ana',
          },
        },
      },
    ]);
    expect(records[0]).toMatchObject({
      annotator_kind: 'LLM',
      label: 'fail',
      output: 'Why did checkout fail: a deploy failed',
      evaluator: { version: items[0]!.judgeIdentity },
    });
    // judgekeeper's own HUMAN lines, without MST's metadata, import by target_id.
    const imported = parseLabels(
      'judgekeeper',
      [
        JSON.stringify({
          target_id: 'better/duration/0',
          name: 'lb/judge/keyword',
          annotator_kind: 'HUMAN',
          label: 'PASS',
        }),
        JSON.stringify({
          target_id: 'better/duration/0',
          name: 'lb/judge/keyword',
          annotator_kind: 'LLM',
          label: 'pass',
        }),
      ].join('\n'),
      'marks.jsonl'
    );
    expect(checkImportedLabels(imported, items, [])).toEqual([
      expect.objectContaining({
        variant: 'better',
        caseId: 'duration',
        trial: 0,
        label: 'pass',
      }),
    ]);
  });

  it('imports nothing when a label is for a verdict the run lacks, or reads wrong', async () => {
    const t = await storedRun();
    const sheet = path.join(t.dir, 'bad.jsonl');
    await fs.writeFile(
      sheet,
      [
        {
          judge: 'lb/judge/keyword',
          variant: 'better',
          caseId: 'cause',
          trial: 0,
          label: 'pass',
        },
        {
          judge: 'correctness',
          variant: 'better',
          caseId: 'cause',
          trial: 0,
          label: 'pass',
        },
        {
          judge: 'lb/judge/keyword',
          variant: 'better',
          caseId: 'cause',
          trial: 9,
          label: 'pass',
        },
        {
          judge: 'lb/judge/keyword',
          variant: 'better',
          caseId: 'duration',
          trial: 0,
          label: 'maybe',
        },
        {
          judge: 'lb/judge/keyword',
          variant: 'better',
          caseId: 'cause',
          trial: 0,
          label: 'fail',
        },
        {
          judge: 'lb/pairwise-judge/longer',
          variant: 'better',
          baseline: 'baseline',
          caseId: 'cause',
          label: 'pass',
        },
      ]
        .map((row) => JSON.stringify(row))
        .join('\n')
    );
    const error = await labelImport(t.directory, sheet, {}, () => {}).catch(
      (caught: Error) => caught
    );
    expect(error).toBeInstanceOf(Error);
    const message = (error as Error).message;
    expect(message).toContain("5 labels can't be imported, so none were:");
    expect(message).toContain(
      'bad.jsonl:2: the run has no verdict from "correctness" for trial 0 of case "cause" on variant "better" (its judges: lb/judge/keyword, lb/pairwise-judge/longer).'
    );
    expect(message).toContain('bad.jsonl:3: the run has no verdict');
    expect(message).toContain(
      'bad.jsonl:4: label "maybe" isn\'t pass or fail.'
    );
    expect(message).toContain('bad.jsonl:5 labels what');
    expect(message).toContain(
      'bad.jsonl:6: label "pass" isn\'t baseline, candidate, tie.'
    );
    expect(await readLabels(t.directory)).toEqual([]);
  });

  it('keeps a split a person chose when the label is replaced', async () => {
    const t = await storedRun();
    const items = judgedItems(await readRunDirectory(t.directory));
    const label = {
      judge: 'lb/judge/keyword',
      variant: 'better',
      caseId: 'cause',
      trial: 0,
      source: 'test',
    };
    const split = defaultSplit('cause') === 'test' ? 'dev' : 'test';
    const first = checkImportedLabels(
      [{ ...label, label: 'pass', split }],
      items,
      []
    );
    await writeLabels(t.directory, first);
    const second = checkImportedLabels(
      [{ ...label, label: 'fail' }],
      items,
      await readLabels(t.directory)
    );
    await writeLabels(t.directory, second);
    expect(await readLabels(t.directory)).toEqual([
      expect.objectContaining({ label: 'fail', split }),
    ]);
  });

  it("carries a run's labels into its regrade", async () => {
    const t = await storedRun();
    const items = judgedItems(await readRunDirectory(t.directory));
    const labels = checkImportedLabels(
      [
        {
          judge: 'lb/judge/keyword',
          variant: 'better',
          caseId: 'cause',
          trial: 1,
          label: 'fail',
          source: 'test',
        },
      ],
      items,
      []
    );
    await writeLabels(t.directory, labels);
    const regrade = await gradeRun({
      ...t.base,
      run: path.basename(t.directory),
    });
    expect(regrade.outputDir).not.toBe(t.directory);
    expect(await readLabels(regrade.outputDir)).toEqual(labels);
    expect(labelRecordPath(labels[0]!)).toBe(
      path.join('labels', 'lb%2Fjudge%2Fkeyword', 'better', 'cause', '1.json')
    );
  });

  it("warns that a redacted run's export has no answers", async () => {
    const t = await storedRun({ redact: true });
    const out = capture();
    const err = capture();
    await labelExport(t.directory, { format: 'jsonl' }, out.write, err.write);
    expect(err.out.join('')).toContain('redacts stored responses');
    const rows = out.out
      .join('')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(rows.some((row) => 'answer' in row)).toBe(false);
    expect(rows[0]).toMatchObject({ input: 'Why did checkout fail' });
  });

  it('finds a run by its directory, its eval directory, or its short ID', async () => {
    const t = await storedRun();
    const short = path.basename(t.directory).split('-').pop()!;
    const evalDirectory = path.dirname(path.dirname(t.directory));
    const root = path.dirname(evalDirectory);
    expect(await resolveRunArgument(t.directory)).toBe(t.directory);
    expect(await resolveRunArgument(evalDirectory)).toBe(t.directory);
    expect(await resolveRunArgument(short, root)).toBe(t.directory);
    await expect(resolveRunArgument('abcdef', root)).rejects.toThrow(
      "isn't a run directory"
    );
  });

  it('exports only the judges asked for, and names the others when none match', async () => {
    const t = await storedRun();
    const out = capture();
    await labelExport(
      t.directory,
      { format: 'jsonl', judge: ['lb/pairwise-judge/longer'] },
      out.write
    );
    expect(out.out.join('').trim().split('\n')).toHaveLength(2);
    await expect(
      labelExport(t.directory, { judge: ['correctness'] }, () => {})
    ).rejects.toThrow(
      'has no verdicts from correctness; its judges are lb/judge/keyword, lb/pairwise-judge/longer.'
    );
  });
});

describe('label checks', () => {
  it("keeps other judges' verdicts when one judge fails, and can't label the failed one", async () => {
    const t = await storedRun({ brokenJudge: true });
    const items = judgedItems(await readRunDirectory(t.directory));
    expect(
      items.filter((item) => item.judge === 'lb/judge/keyword' && item.verdict)
    ).toHaveLength(8);
    expect(
      items.filter((item) => item.judge === 'lb/judge/broken' && item.verdict)
    ).toEqual([]);
    const label = {
      variant: 'better',
      caseId: 'cause',
      trial: 0,
      label: 'pass',
      source: 'test',
    };
    expect(() =>
      checkImportedLabels([{ ...label, judge: 'lb/judge/broken' }], items, [])
    ).toThrow('the run has no verdict from "lb/judge/broken"');
    expect(
      checkImportedLabels([{ ...label, judge: 'lb/judge/keyword' }], items, [])
    ).toHaveLength(1);
  });

  it('rejects a criterion its judge never reported, and names that look like object keys', async () => {
    const t = await storedRun();
    const items = judgedItems(await readRunDirectory(t.directory));
    const label = {
      judge: 'lb/judge/keyword',
      variant: 'better',
      caseId: 'cause',
      trial: 0,
      source: 'test',
    };
    expect(() =>
      checkImportedLabels(
        [{ ...label, criterion: 'cites-source', label: 'pass' }],
        items,
        []
      )
    ).toThrow('no verdict from "lb/judge/keyword#cites-source"');
    for (const value of ['constructor', '__proto__', 'toString'])
      expect(() =>
        checkImportedLabels([{ ...label, label: value }], items, [])
      ).toThrow(`label "${value}" isn't pass or fail.`);
  });

  it("keeps a name's spaces, so it matches the verdict it labels", () => {
    expect(
      parseLabels(
        'jsonl',
        JSON.stringify({
          judge: 'j',
          variant: ' v ',
          caseId: ' c',
          trial: ' 1 ',
          label: ' pass ',
        }),
        'labels.jsonl'
      )
    ).toEqual([
      expect.objectContaining({
        variant: ' v ',
        caseId: ' c',
        trial: 1,
        label: 'pass',
      }),
    ]);
  });

  it("stores a preference for each baseline, and refuses a record that's both kinds", () => {
    const fields = {
      format: 'mst.run/v1',
      kind: 'label',
      judge: 'p',
      variant: 'b',
      caseId: 'c',
      split: 'test',
      labeler: 'ana',
      labeledAt: '2026-10-30T00:00:00Z',
      label: 'tie',
    };
    const a = parseLabelRecord({ ...fields, baseline: 'a' }, 'a.json');
    const c = parseLabelRecord({ ...fields, baseline: 'c' }, 'c.json');
    expect(labelRecordPath(a as never)).not.toBe(labelRecordPath(c as never));
    expect(() =>
      parseLabelRecord(
        { ...fields, baseline: 'a', trial: '../../escaped' },
        'bad.json'
      )
    ).toThrow("bad.json isn't a label");
    expect(() =>
      parseLabelRecord(
        { ...fields, label: 'pass', trial: 0, baseline: 'a' },
        'both.json'
      )
    ).toThrow("both.json isn't a label");
  });
});

describe('parseCsv', () => {
  it('reads quoted cells with commas, quotes and line breaks', () => {
    expect(parseCsv('a,b\r\n"x, ""y""","line\nbreak"\r\n,\n')).toEqual([
      ['a', 'b'],
      ['x, "y"', 'line\nbreak'],
      ['', ''],
    ]);
  });

  it('refuses a quote left open, which would swallow the rows after it', () => {
    expect(() => parseCsv('a,note\n1,"open\n2,lost\n')).toThrow(
      'CSV line 4: a quoted cell has no closing quote'
    );
    expect(() => parseCsv('a\n"x"y\n')).toThrow(
      'CSV line 2: a quoted cell must end at a comma or line break.'
    );
  });
});
