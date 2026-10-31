#!/usr/bin/env tsx
/**
 * Measure MST's built-in judges on the calibration set (ADR 0009) and write
 * docs/judges.md.
 *
 * The set is 128 traces from a scripted client (scripts/calibration/): real
 * tool calls against MST's mock server and the filesystem reference server,
 * with answers written to be right or wrong in one way, so each trace's label
 * is known from how it was built. The script collects the traces once, then
 * for each judge model grades them (`mst grade`), fills in the labels on the
 * export (`mst label export`, `mst label import`), and measures each judge
 * (`mst judges check`).
 *
 * Usage:
 *   npm run calibrate-judges                        # the default judge model
 *   npm run calibrate-judges -- --model anthropic:claude-haiku-4-5 --model openai:gpt-5-mini,effort=low
 *   npm run calibrate-judges -- --no-docs           # print, don't write docs/judges.md
 *
 * Judges call their providers with the usual credentials (`ANTHROPIC_API_KEY`,
 * `OPENAI_API_KEY`, a gateway's `*_BASE_URL` with `MST_LLM_AUTH_COMMAND`).
 */
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { z } from 'zod';
import {
  calibrationCases,
  LABELS,
  TRACE_KINDS,
  type CalibrationQuestion,
  type TraceKind,
} from './calibration/cases.js';
import { missingVerdicts } from './calibration/verdicts.js';

const run = promisify(execFile);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CALIBRATION = path.join(ROOT, 'scripts/calibration');
const FILESYSTEM_SERVER = '@modelcontextprotocol/server-filesystem@2.1.0';
/** tsx's loader, resolved here: `--import tsx` resolves from the working directory. */
const TSX = import.meta.resolve('tsx');

/** The built-in judges the set measures, and the eval config entry for each. */
const JUDGES: Partial<
  Record<CalibrationQuestion, (model: JudgeModel) => Record<string, unknown>>
> = {
  correctness: (model) => ({
    type: 'rubric',
    rubric: 'correctness',
    ...model.options,
    provider: model.provider,
    model: model.model,
  }),
};

interface JudgeModel {
  provider: string;
  model: string;
  /** Judge settings for this model, such as a reasoning model's `effort`. */
  options: Record<string, string | number>;
}

const DEFAULT_MODELS: JudgeModel[] = [
  { provider: 'anthropic', model: 'claude-sonnet-4-6', options: {} },
];

/** `<provider>:<model>[,<setting>=<value>...]`, as `openai:gpt-5-mini,effort=low`. */
function parseModel(value: string): JudgeModel {
  const [name = '', ...settings] = value.split(',');
  const at = name.indexOf(':');
  if (at < 1)
    throw new Error(
      `--model takes <provider>:<model>[,<setting>=<value>...], not "${value}".`
    );
  const options: Record<string, string | number> = {};
  for (const setting of settings) {
    const eq = setting.indexOf('=');
    if (eq < 1)
      throw new Error(
        `"${setting}" in --model ${value} isn't <setting>=<value>.`
      );
    const raw = setting.slice(eq + 1);
    options[setting.slice(0, eq)] = /^\d+(\.\d+)?$/.test(raw)
      ? Number(raw)
      : raw;
  }
  return { provider: name.slice(0, at), model: name.slice(at + 1), options };
}

function parseArgs(argv: string[]): {
  models: JudgeModel[];
  docs: boolean;
  work?: string;
} {
  const models: JudgeModel[] = [];
  let docs = true;
  let work: string | undefined;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--model') {
      models.push(parseModel(argv[(i += 1)] ?? ''));
    } else if (arg === '--no-docs') docs = false;
    else if (arg === '--work') work = argv[(i += 1)];
    else throw new Error(`Unknown argument ${arg}.`);
  }
  return {
    models: models.length ? models : DEFAULT_MODELS,
    docs,
    ...(work ? { work } : {}),
  };
}

/**
 * Runs the CLI from source. `run` and `grade` exit 1 when cases fail, as
 * half of this set should; `casesMayFail` takes that as success unless the
 * CLI reported an error.
 */
async function mst(
  args: string[],
  cwd: string,
  casesMayFail = false
): Promise<string> {
  try {
    const { stdout } = await run(
      process.execPath,
      ['--import', TSX, path.join(ROOT, 'src/cli/index.ts'), ...args],
      { cwd, maxBuffer: 64 * 1024 * 1024, env: process.env }
    );
    return stdout;
  } catch (error) {
    const { code, stdout, stderr } = error as {
      code?: number;
      stdout?: string;
      stderr?: string;
    };
    if (casesMayFail && code === 1 && !(stderr ?? '').includes('mst: '))
      return stdout ?? '';
    throw new Error(
      `mst ${args.join(' ')} failed:\n${stderr ?? ''}${stdout ?? ''}`.trim()
    );
  }
}

function evalConfig(
  name: string,
  judges: Array<Record<string, unknown>>
): Record<string, unknown> {
  return {
    name,
    datasets: ['./cases.json'],
    plugins: [path.join(CALIBRATION, 'plugin.ts')],
    client: 'calibration/client/scripted',
    clientOptions: { files: path.join(CALIBRATION, 'files') },
    redactStoredResponses: false,
    run: { concurrency: 8 },
    servers: {
      mock: {
        transport: 'stdio',
        command: process.execPath,
        args: [
          '--import',
          TSX,
          path.join(ROOT, 'tests/mocks/simpleMCPServer.ts'),
        ],
        cwd: ROOT,
      },
      files: {
        transport: 'stdio',
        command: 'npx',
        args: ['-y', FILESYSTEM_SERVER, path.join(CALIBRATION, 'files')],
      },
    },
    judges,
  };
}

/** The run directories under an eval's runs folder. */
async function runIds(work: string, name: string): Promise<string[]> {
  const runs = path.join(work, '.mcp-test-results', name, 'runs');
  return existsSync(runs) ? fs.readdir(runs) : [];
}

async function newRun(
  work: string,
  name: string,
  before: string[],
  command: () => Promise<unknown>
): Promise<string> {
  await command();
  const added = (await runIds(work, name)).filter((id) => !before.includes(id));
  if (added.length !== 1)
    throw new Error(`Expected one new run of ${name}, found ${added.length}.`);
  return path.join(work, '.mcp-test-results', name, 'runs', added[0]!);
}

const ExportRow = z
  .object({
    judge: z.string(),
    variant: z.string(),
    caseId: z.string(),
    trial: z.union([z.number(), z.string()]).optional(),
    verdict: z.string().optional(),
    label: z.string().optional(),
  })
  .passthrough();

/**
 * Fills in each exported verdict's label from the case's trace kind. Throws
 * when a judge has no verdict on some trace (its provider failed, say):
 * numbers from part of the set aren't the set's.
 */
async function labelRun(directory: string, kinds: Map<string, TraceKind>) {
  const exported = path.join(
    directory,
    '..',
    `${path.basename(directory)}.export.jsonl`
  );
  await mst(
    ['label', 'export', directory, '--format', 'jsonl', '-o', exported],
    ROOT
  );
  const rows = (await fs.readFile(exported, 'utf8'))
    .split('\n')
    .filter(Boolean)
    .map((line) => ExportRow.parse(JSON.parse(line)))
    .filter((row) => row.verdict !== undefined);
  const missing = missingVerdicts(rows, Object.keys(JUDGES), kinds.size);
  if (missing.length)
    throw new Error(
      `${missing.join('; ')} in ${directory}: its judge failed on the rest (see the run's report), so the set isn't measured. Fix the cause and run again.`
    );
  const labeled = rows.flatMap((row) => {
    const kind = kinds.get(row.caseId);
    const label =
      kind && row.judge in LABELS[kind]
        ? LABELS[kind][row.judge as CalibrationQuestion]
        : null;
    return label
      ? [
          {
            ...row,
            label,
            note: `constructed: a ${kind} trace (scripts/calibration/cases.ts)`,
          },
        ]
      : [];
  });
  const file = path.join(
    directory,
    '..',
    `${path.basename(directory)}.labels.jsonl`
  );
  await fs.writeFile(
    file,
    labeled.map((row) => JSON.stringify(row)).join('\n') + '\n'
  );
  await mst(
    ['label', 'import', directory, file, '--labeler', 'constructed'],
    ROOT
  );
  await fs.rm(exported, { force: true });
  await fs.rm(file, { force: true });
}

const Rate = z.object({
  k: z.number(),
  n: z.number(),
  value: z.number().nullable(),
  low: z.number().nullable(),
  high: z.number().nullable(),
});

const Check = z
  .object({
    judge: z.string(),
    judgeIdentity: z.string().optional(),
    judgeModels: z.array(z.string()),
    labels: z.number(),
    humanPass: z.number(),
    humanFail: z.number(),
    tpr: Rate,
    tnr: Rate,
    kappa: z.number().nullable(),
    unknown: Rate,
    usable: z.boolean(),
    reasons: z.array(z.string()),
    disagreements: z.array(
      z
        .object({ caseId: z.string(), verdict: z.string(), label: z.string() })
        .passthrough()
    ),
  })
  .passthrough();
type Check = z.infer<typeof Check>;

function percent(value: number | null): string {
  return value === null ? 'n/a' : `${(value * 100).toFixed(0)}%`;
}

function rate(r: z.infer<typeof Rate>): string {
  return r.value === null
    ? 'n/a'
    : `${percent(r.value)} (${percent(r.low)}–${percent(r.high)})`;
}

function kindTable(): string {
  const questions = Object.keys(LABELS.sound) as CalibrationQuestion[];
  const head = `| Trace kind | ${questions.map((q) => `\`${q}\``).join(' | ')} |`;
  const rule = `| ${['---', ...questions.map(() => '---')].join(' | ')} |`;
  const rows = TRACE_KINDS.map(
    (kind) =>
      `| ${kind} | ${questions.map((q) => LABELS[kind][q] ?? 'no label').join(' | ')} |`
  );
  return [head, rule, ...rows].join('\n');
}

/** A check, with the judge model's settings as the script was given them. */
type Measured = Check & { settings: string };

function modelName(check: Measured): string {
  return `${check.judgeModels.join(', ')}${check.settings ? ` (${check.settings})` : ''}`;
}

/** Each check's disagreements: the traces a person would read first. */
function disagreements(checks: Measured[]): string {
  const lines = checks.flatMap((check) =>
    check.disagreements.map(
      (d) =>
        `- \`${check.judge}\` on ${modelName(check)}: \`${d.caseId}\`, judged ${d.verdict}, labeled ${d.label}.`
    )
  );
  return lines.length ? lines.join('\n') : 'None.';
}

function docs(checks: Measured[], date: string): string {
  const rows = checks.map(
    (check) =>
      `| \`${check.judge}\` | ${modelName(check)} | \`${(check.judgeIdentity ?? 'none').slice(0, 12)}\` | ${check.humanFail} / ${check.humanPass} | ${rate(check.tpr)} | ${rate(check.tnr)} | ${check.kappa === null ? 'n/a' : check.kappa.toFixed(2)} | ${percent(check.unknown.value)} | ${check.usable ? 'yes' : `no: ${check.reasons.join('; ')}`} |`
  );
  return `<!-- Written by scripts/calibrate-judges.ts. Run \`npm run calibrate-judges\` to update it. -->

# Built-in judges on the calibration set

MST measures its built-in judges on a small calibration set, the way [\`mst judges check\`](./cli.md#judges-check---measure-a-judge-against-labels) measures any judge against labels ([ADR 0009](./adr/0009-users-calibrate-judges-against-their-own-labels.md)). The numbers show whether a built-in judge is a reasonable judge of agent traces. They are not a calibration for your data: label some of your own trials and run \`mst judges check\` on them.

## The set

The set has ${calibrationCases().length} traces. A scripted client (\`scripts/calibration/plugin.ts\`) makes real tool calls against MST's mock server and the filesystem reference server (\`${FILESYSTEM_SERVER}\`, over a small made-up project in \`scripts/calibration/files/\`). Then it gives an answer written to be right or wrong in one way. There are 16 tasks (settings and history of the project, arithmetic, weather), each in 8 kinds of trace.

**No person reviewed these labels.** Each trace's label comes from its kind, by the table below, so the labels are only as right as the table and the traces that \`scripts/calibration/cases.ts\` builds. The labels are stored with the labeler \`constructed\`. The answers are short and written to be clearly right or wrong, so the set is easier than real traces.

${kindTable()}

A label is \`pass\` or \`fail\` for the judge's question. "No label" means the kind has no single right answer to the question. Half the cases, by a hash of the case ID, are in the \`test\` split, and the numbers below use only those.

## Results

Measured on ${date}. TPR is the share of the failing traces the judge failed; TNR is the share of the passing traces it passed. Each has a 95% Wilson interval. A judge is usable when it gave a verdict on at least 15 failing and 15 passing labels, the lower bound of both TPR and TNR is at least 80%, and it answered \`unknown\` on at most 10% of them. The identity changes when the judge's prompt, version, model or settings do; a different identity needs measuring again.

| Judge | Model | Identity | Labels (fail / pass) | TPR | TNR | Kappa | Unknown | Usable |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
${rows.join('\n')}

\`correctness\` is the \`rubric\` judge with its built-in \`correctness\` rubric, which asks whether the answer is correct against the reference. It gets the trial's response as JSON, tool calls included, so it can fail a right answer because a tool call failed: that is a disagreement with the \`false-success\` labels, which pass a right answer on this question.

## Disagreements

The \`test\` traces where a judge's verdict and the label differ. Read a case's trace in \`scripts/calibration/cases.ts\` to see why.

${disagreements(checks)}
`;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const work =
    options.work ??
    (await fs.mkdtemp(path.join(os.tmpdir(), 'mst-calibration-')));
  await fs.mkdir(work, { recursive: true });
  const cases = calibrationCases();
  const kinds = new Map(cases.map((c) => [c.id, c.metadata.kind]));
  await fs.writeFile(
    path.join(work, 'cases.json'),
    JSON.stringify({ name: 'calibration', cases }, null, 2)
  );
  const name = 'mst-calibration';
  await fs.writeFile(
    path.join(work, 'collect.json'),
    JSON.stringify(evalConfig(name, []), null, 2)
  );
  console.log(`Collecting ${cases.length} traces in ${work}...`);
  const collected = await newRun(work, name, await runIds(work, name), () =>
    mst(
      ['run', '-c', 'collect.json', '--root-dir', work, '--no-report'],
      work,
      true
    )
  );
  const checks: Measured[] = [];
  for (const model of options.models) {
    const config = `grade-${model.provider}-${model.model.replace(/[^\w.-]/g, '_')}.json`;
    await fs.writeFile(
      path.join(work, config),
      JSON.stringify(
        evalConfig(
          name,
          Object.values(JUDGES).map((judge) => judge(model))
        ),
        null,
        2
      )
    );
    console.log(`Grading with ${model.provider}:${model.model}...`);
    const graded = await newRun(work, name, await runIds(work, name), () =>
      mst(
        ['grade', collected, '-c', config, '--root-dir', work, '--no-report'],
        work,
        true
      )
    );
    await labelRun(graded, kinds);
    for (const judge of Object.keys(JUDGES)) {
      const output = await mst(
        ['judges', 'check', graded, '--judge', judge, '--json', '--no-record'],
        ROOT
      );
      for (const check of z.array(z.unknown()).parse(JSON.parse(output)))
        checks.push({
          ...Check.parse(check),
          settings: Object.entries(model.options)
            .map(([key, value]) => `${key} ${value}`)
            .join(', '),
        });
    }
  }
  for (const check of checks)
    console.log(
      `${check.judge} on ${modelName(check)}: TPR ${rate(check.tpr)}, TNR ${rate(check.tnr)}, unknown ${percent(check.unknown.value)}, ${check.usable ? 'usable' : `not usable (${check.reasons.join('; ')})`}`
    );
  if (options.docs) {
    const file = path.join(ROOT, 'docs/judges.md');
    await fs.writeFile(
      file,
      docs(checks, new Date().toISOString().slice(0, 10))
    );
    await run(path.join(ROOT, 'node_modules/.bin/prettier'), ['--write', file]);
    console.log(`Wrote ${path.relative(ROOT, file)}.`);
  }
  if (!options.work) await fs.rm(work, { recursive: true, force: true });
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
