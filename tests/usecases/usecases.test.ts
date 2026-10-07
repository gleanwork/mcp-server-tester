/**
 * The use-case eval: each directory under cases/ is one comparison MST is
 * built to run (see README.md). The test copies it to a temp directory,
 * runs it through the `mst` CLI with the fixture plugin, and checks the
 * results.json it writes.
 *
 * Checks marked with a `gap` describe what MST should report but doesn't
 * yet; they run as expected failures, so fixing a gap fails the eval until
 * its `gap` is removed. Ledger checks compare each variant's metrics with the
 * usage and events the fixture client actually returned.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '../..');
const CLI = path.join(REPO, 'dist/cli/index.js');
const FIXTURES = path.join(HERE, 'fixtures');
const PLUGIN = path.join(FIXTURES, 'plugin.mjs');
const CASES = path.join(HERE, 'cases');

const LEDGER_METRICS = [
  'input_tokens_mean',
  'output_tokens_mean',
  'tool_count_mean',
  'mcp_call_count_mean',
  'builtin_event_count_mean',
] as const;
type LedgerMetric = (typeof LEDGER_METRICS)[number];

const CheckSchema = z
  .object({
    path: z.string().min(1),
    equals: z.unknown().optional(),
    exists: z.boolean().optional(),
    /** Why MST doesn't report this yet, and the plan step that fixes it. */
    gap: z.string().optional(),
  })
  .strict()
  .refine((check) => 'equals' in check || check.exists !== undefined, {
    message: 'a check needs `equals` or `exists`',
  });
type Check = z.infer<typeof CheckSchema>;

const ExpectedSchema = z
  .object({
    title: z.string(),
    /** Run the eval this many times; later runs see earlier results. */
    runs: z.number().int().positive().default(1),
    /** Exit code of the last run. */
    exitCode: z.number().int().default(0),
    /** Exit codes of every run, when they differ. */
    exitCodes: z.array(z.number().int()).optional(),
    /** The eval can't run yet; every check is an expected failure. */
    runGap: z.string().optional(),
    /** What the CLI must print while the run gap stands. */
    runGapError: z.string().optional(),
    checks: z.array(CheckSchema).default([]),
    ledger: z
      .object({
        metrics: z.array(z.enum(LEDGER_METRICS)).default([]),
        /** Variant deltas recomputed from the ledger: delta key and the metric it compares. */
        deltas: z
          .array(
            z
              .object({ key: z.string(), metric: z.enum(LEDGER_METRICS) })
              .strict()
          )
          .default([]),
        gaps: z.record(z.string(), z.string()).default({}),
        /** Variants whose client returns no trace, so the ledger has nothing to compare. */
        noTrace: z.array(z.string()).default([]),
      })
      .strict()
      .optional(),
  })
  .strict()
  .refine(
    (expected) =>
      (expected.runGap === undefined) === (expected.runGapError === undefined),
    {
      message: '`runGap` and `runGapError` go together',
    }
  );
type Expected = z.infer<typeof ExpectedSchema>;

interface LedgerEntry {
  variant: string;
  caseId: string | null;
  trial: number | null;
  usage?: { inputTokens: number; outputTokens: number };
  events: Array<{
    kind: string;
    source: string;
    name: string;
    server?: string;
  }>;
}

interface Outcome {
  exitCodes: Array<number | null>;
  output: string;
  results?: Record<string, unknown>;
  ledger: LedgerEntry[];
  workDir: string;
}

/** Variables the CLI sees: nothing from the developer's shell beyond these. */
const ENV_ALLOWLIST = ['PATH', 'HOME', 'TMPDIR', 'TEMP', 'TMP', 'SystemRoot'];

/** Replace each `"{{server <catalog> <label>}}"` with a stdio server entry. */
function render(source: string, file: string): string {
  const rendered = source.replace(
    /"\{\{server ([\w-]+) ([\w-]+)\}\}"/g,
    (_, catalog: string, label: string) =>
      JSON.stringify({
        transport: 'stdio',
        command: process.execPath,
        args: [
          path.join(FIXTURES, 'catalogServer.mjs'),
          path.join(FIXTURES, 'catalogs', `${catalog}.json`),
        ],
        label,
      })
  );
  const leftover = /\{\{server[^}]*\}\}/.exec(rendered);
  if (leftover)
    throw new Error(`${file}: unrendered placeholder ${leftover[0]}`);
  return rendered;
}

function resultFiles(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir, { recursive: true, encoding: 'utf8' })
    .filter((entry) => path.basename(entry) === 'results.json')
    .map((entry) => path.join(dir, entry));
}

function readLedger(file: string): LedgerEntry[] {
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as LedgerEntry);
}

/** Runs the case `runs` times into one output directory; returns the last run. */
function runCase(caseDir: string, runs: number): Outcome {
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mst-usecase-'));
  for (const name of fs.readdirSync(caseDir)) {
    if (name === 'expected.json') continue;
    const source = fs.readFileSync(path.join(caseDir, name), 'utf8');
    fs.writeFileSync(path.join(workDir, name), render(source, name));
  }
  const ledger = path.join(workDir, 'ledger.jsonl');
  const outDir = path.join(workDir, 'out');
  const env: Record<string, string> = {};
  for (const key of ENV_ALLOWLIST) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  const outcome: Outcome = { exitCodes: [], output: '', ledger: [], workDir };
  for (let run = 0; run < runs; run += 1) {
    fs.rmSync(ledger, { force: true });
    const before = new Set(resultFiles(outDir));
    const child = spawnSync(
      process.execPath,
      [
        CLI,
        'run',
        '--config',
        'eval.json',
        '--plugins',
        PLUGIN,
        '--root-dir',
        '.',
        '--output-dir',
        outDir,
      ],
      {
        cwd: workDir,
        encoding: 'utf8',
        env: { ...env, USECASE_LEDGER: ledger, USECASE_RUN: String(run) },
        timeout: 120_000,
      }
    );
    outcome.exitCodes.push(child.status);
    outcome.output = [
      `run ${run}: status=${child.status} signal=${child.signal ?? ''}`,
      child.error ? `spawn error: ${child.error.message}` : '',
      child.stdout,
      child.stderr,
    ].join('\n');
    const created = resultFiles(outDir).filter((file) => !before.has(file));
    outcome.results =
      created.length === 1
        ? (JSON.parse(fs.readFileSync(created[0]!, 'utf8')) as Record<
            string,
            unknown
          >)
        : undefined;
    outcome.ledger = readLedger(ledger);
  }
  return outcome;
}

/**
 * Resolve a dotted path. A segment may select from an array with
 * `[key=value]` (for example `variants[name=native]`) or an index `[0]`;
 * `length` gives an array's length or an object's key count. Segments are
 * split on `.` first, so selector values can't contain dots.
 */
function resolve(value: unknown, dotted: string): unknown {
  let current = value;
  for (const segment of dotted.split('.')) {
    const match = /^([^[\]]*)(?:\[(.+)\])?$/.exec(segment);
    if (!match) return undefined;
    const [, key, selector] = match;
    if (key === 'length' && selector === undefined) {
      if (Array.isArray(current)) return current.length;
      if (current && typeof current === 'object')
        return Object.keys(current).length;
      return undefined;
    }
    if (key) current = (current as Record<string, unknown> | undefined)?.[key];
    if (selector !== undefined) {
      if (!Array.isArray(current)) return undefined;
      const pair = /^(\w+)=(.*)$/.exec(selector);
      current = pair
        ? current.find(
            (item) =>
              String((item as Record<string, unknown>)?.[pair[1]!]) === pair[2]
          )
        : current[Number(selector)];
    }
  }
  return current;
}

/** The path a gap check's leaf hangs off, when it has one worth guarding. */
function anchorOf(dotted: string): string | undefined {
  const segments = dotted.split('.');
  return segments.length > 2 ? segments.slice(0, -1).join('.') : undefined;
}

function assertCheck(results: unknown, check: Check): void {
  const actual = resolve(results, check.path);
  if (check.exists !== undefined) {
    expect(
      actual !== undefined && actual !== null,
      `${check.path} exists`
    ).toBe(check.exists);
  }
  if ('equals' in check) {
    if (typeof check.equals === 'number') {
      expect(actual, check.path).toBeTypeOf('number');
      expect(actual as number, check.path).toBeCloseTo(check.equals, 9);
    } else {
      expect(actual, check.path).toEqual(check.equals);
    }
  }
}

/** Per-trial mean of a ledger metric over one variant's traces, or null with none. */
function ledgerMean(
  entries: LedgerEntry[],
  metric: LedgerMetric
): number | null {
  const trials = entries.filter((entry) => entry.caseId !== null);
  if (trials.length === 0) return null;
  const value = (entry: LedgerEntry): number => {
    switch (metric) {
      case 'input_tokens_mean':
        return entry.usage?.inputTokens ?? 0;
      case 'output_tokens_mean':
        return entry.usage?.outputTokens ?? 0;
      case 'tool_count_mean':
        return entry.events.filter((event) => event.kind === 'tool_call')
          .length;
      case 'mcp_call_count_mean':
        return entry.events.filter((event) => event.source === 'mcp').length;
      case 'builtin_event_count_mean':
        return entry.events.filter((event) => event.source === 'builtin')
          .length;
    }
  };
  return trials.reduce((sum, entry) => sum + value(entry), 0) / trials.length;
}

interface VariantResult {
  name: string;
  metrics: Record<string, unknown>;
}

/** The variants that must have ledger truth: every reported variant with a trace. */
function tracedVariants(outcome: Outcome, noTrace: string[]): VariantResult[] {
  const variants = (outcome.results?.variants ?? []) as VariantResult[];
  expect(variants.length, 'variants in results.json').toBeGreaterThan(0);
  const reported = new Set(variants.map((variant) => variant.name));
  for (const entry of outcome.ledger) {
    expect(
      reported.has(entry.variant),
      `ledger variant "${entry.variant}" is reported`
    ).toBe(true);
  }
  return variants.filter((variant) => !noTrace.includes(variant.name));
}

if (!fs.existsSync(CLI)) {
  throw new Error(
    `The use-case runs the built CLI. Run \`npm run build\` first (missing ${CLI}).`
  );
}

const caseDirs = fs
  .readdirSync(CASES)
  .filter((name) => fs.existsSync(path.join(CASES, name, 'expected.json')))
  .sort();

for (const name of caseDirs) {
  const caseDir = path.join(CASES, name);
  const expected: Expected = ExpectedSchema.parse(
    JSON.parse(fs.readFileSync(path.join(caseDir, 'expected.json'), 'utf8'))
  );
  const blocked = expected.runGap !== undefined;
  const gapped = (gap: string | undefined) =>
    blocked || gap !== undefined ? it.fails : it;

  describe(`${name}: ${expected.title}`, () => {
    let outcome: Outcome;
    let failed = false;
    beforeAll(() => {
      outcome = runCase(caseDir, expected.runs);
    });
    afterAll(() => {
      if (failed || (!outcome?.results && !blocked)) {
        console.error(`[${name}] kept ${outcome?.workDir}\n${outcome?.output}`);
      } else if (!process.env.USECASE_KEEP) {
        fs.rmSync(outcome.workDir, { recursive: true, force: true });
      }
    });
    /** A test body that, when it fails unexpectedly, keeps the run for inspection. */
    const track =
      (gap: string | undefined, body: () => void): (() => void) =>
      () => {
        try {
          body();
        } catch (error) {
          if (!blocked && gap === undefined) failed = true;
          throw error;
        }
      };

    if (blocked) {
      it(`can't run yet: ${expected.runGap}`, () => {
        expect(outcome.output).toMatch(new RegExp(expected.runGapError!));
      });
    }

    gapped(undefined)(
      `exits ${expected.exitCodes ? expected.exitCodes.join(', ') : expected.exitCode} and writes results.json`,
      track(undefined, () => {
        expect(outcome.results, outcome.output).toBeDefined();
        expect(outcome.exitCodes, outcome.output).toEqual(
          expected.exitCodes ?? [
            ...Array(expected.runs - 1).fill(outcome.exitCodes[0]),
            expected.exitCode,
          ]
        );
      })
    );

    for (const check of expected.checks) {
      const label =
        'equals' in check
          ? `${check.path} = ${JSON.stringify(check.equals)}`
          : `${check.path} ${check.exists ? 'exists' : 'is absent'}`;
      const anchor = anchorOf(check.path);
      if (check.gap && anchor && !blocked) {
        // A gap check must fail for its own reason, not because what it
        // hangs off (a variant, a delta) went missing.
        it(
          `${anchor} exists (for: ${label})`,
          track(undefined, () => {
            expect(resolve(outcome.results, anchor), anchor).toBeDefined();
          })
        );
      }
      gapped(check.gap)(
        check.gap ? `${label} (gap: ${check.gap})` : label,
        track(check.gap, () => assertCheck(outcome.results, check))
      );
    }

    const ledger = expected.ledger;
    for (const metric of ledger?.metrics ?? []) {
      const gap = ledger?.gaps[metric];
      gapped(gap)(
        gap
          ? `variant ${metric} matches the client ledger (gap: ${gap})`
          : `variant ${metric} matches the client ledger`,
        track(gap, () => {
          for (const variant of tracedVariants(outcome, ledger!.noTrace)) {
            const truth = ledgerMean(
              outcome.ledger.filter((entry) => entry.variant === variant.name),
              metric
            );
            expect(
              truth,
              `ledger has traces for ${variant.name}`
            ).not.toBeNull();
            expect(
              variant.metrics[metric],
              `${variant.name}.${metric}`
            ).toBeTypeOf('number');
            expect(
              variant.metrics[metric] as number,
              `${variant.name}.${metric}`
            ).toBeCloseTo(truth!, 9);
          }
        })
      );
    }
    for (const delta of ledger?.deltas ?? []) {
      const gap = ledger?.gaps[delta.key];
      gapped(gap)(
        gap
          ? `variantDeltas.*.${delta.key} matches the client ledger (gap: ${gap})`
          : `variantDeltas.*.${delta.key} matches the client ledger`,
        track(gap, () => {
          const [baseline, ...others] = tracedVariants(
            outcome,
            ledger!.noTrace
          );
          const mean = (variant: VariantResult) =>
            ledgerMean(
              outcome.ledger.filter((entry) => entry.variant === variant.name),
              delta.metric
            )!;
          for (const variant of others) {
            const reported = resolve(
              outcome.results,
              `variantDeltas.${variant.name}.${delta.key}`
            );
            expect(
              reported,
              `variantDeltas.${variant.name}.${delta.key}`
            ).toBeTypeOf('number');
            expect(
              reported as number,
              `variantDeltas.${variant.name}.${delta.key}`
            ).toBeCloseTo(mean(variant) - mean(baseline!), 9);
          }
        })
      );
    }
  });
}
