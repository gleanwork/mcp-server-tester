/**
 * An eval's six "weekly" runs, made offline: a scripted client, judge and
 * pairwise judge, three variants (`official`, the baseline on a vendor's
 * official server, `glean` and `glean-plus`), run through `runEval` with
 * the clock set to each week's Monday. In week 2 a trial is lost to an
 * infrastructure failure, in week 3 the client app updates, in week 4 the
 * judge's version changes (a new era), and week 5 is a partial run of
 * `glean` alone. `npm run preview-history` and tests/history-page.spec.ts
 * use it.
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { runEval } from '../../src/evals/runEval.js';
import type { Plugin } from '../../src/plugins/plugin.js';

/** The week being run, 1–6, and its clock. */
let week = 1;
const RealDate = Date;
const weekStart = (n: number) => RealDate.UTC(2026, 9, 5 + (n - 1) * 7, 9);
let clockOffset = 0;
/** Runs start on each week's Monday; time moves on from there. */
class WeeklyDate extends RealDate {
  constructor(...args: unknown[]) {
    if (args.length === 0) super(RealDate.now() + clockOffset);
    else super(...(args as [string]));
  }
  static override now(): number {
    return RealDate.now() + clockOffset;
  }
}

/** A number in [0, 1) from its parts: the same week, variant, case and trial give the same one. */
function chance(...parts: Array<string | number>): number {
  return (
    createHash('sha256').update(parts.join('|')).digest().readUInt32BE(0) /
    2 ** 32
  );
}

/** How likely each variant's trial is to find the answer, week by week. */
const SKILL: Record<string, number[]> = {
  official: [0.55, 0.56, 0.55, 0.57, 0.56, 0.56],
  glean: [0.62, 0.66, 0.52, 0.7, 0.74, 0.8],
  'glean-plus': [0.66, 0.7, 0.74, 0.76, 0.76, 0.84],
};
const PRICE: Record<string, number> = {
  official: 1,
  glean: 1.3,
  'glean-plus': 1.8,
};

/** Trials so far of each week's variant and case. */
const attempts = new Map<string, number>();

const plugin: Plugin = {
  meta: { name: 'preview-history', namespace: 'preview' },
  clients: {
    scripted: {
      schema: z.object({ type: z.string() }).passthrough(),
      evidence: 'structured',
      run: async (input, _config, context) => {
        const variant = context.variant?.name ?? 'official';
        const key = `${week}|${variant}|${input.prompt}`;
        const trial = attempts.get(key) ?? 0;
        attempts.set(key, trial + 1);
        const roll = chance(week, variant, input.prompt, trial);
        if (week === 2 && variant === 'glean' && input.prompt.includes('#7'))
          return {
            finalText: '',
            events: [],
            ending: {
              kind: 'infrastructure',
              broke: 'network',
              retryable: true,
              reason: 'The search API was unreachable.',
            },
          };
        const found = roll < SKILL[variant]![week - 1]!;
        const calls =
          1 +
          Math.floor(chance('calls', week, variant, input.prompt, trial) * 4);
        const tokens = Math.round(
          (6000 + chance('tokens', week, variant, input.prompt, trial) * 9000) *
            PRICE[variant]!
        );
        // The trial takes its time on the run's clock, not the real one.
        const durationMs =
          8000 +
          Math.round(
            chance('time', week, variant, input.prompt, trial) *
              20000 *
              PRICE[variant]! *
              (week >= 5 && variant !== 'official' ? 0.8 : 1)
          );
        clockOffset += durationMs;
        return {
          finalText: found
            ? `ANSWER for ${input.prompt}`
            : `Not sure: ${input.prompt}`,
          events: Array.from({ length: calls }, (_, index) => ({
            kind: 'tool_call' as const,
            source: 'mcp' as const,
            name: index === 0 ? 'search' : 'read_document',
            server: variant === 'official' ? 'vendor' : 'glean',
            arguments: { query: input.prompt },
            output: 'results',
            isError: false,
          })),
          usage: {
            inputTokens: tokens,
            outputTokens: Math.round(tokens / 12),
            cacheReadInputTokens: Math.round(tokens * 0.4),
            durationMs,
          },
          telemetry: {
            clientApp: {
              name: 'Claude',
              version: week < 3 ? '2.31104.0' : '2.31201.4',
            },
          },
        };
      },
    },
  },
  judges: {
    // Version 2 (week 4 on) is stricter: it wants the answer early.
    quality: {
      version: '1',
      schema: z.object({}).passthrough(),
      evaluate: async ({ trial }) => {
        const found = trial.text.startsWith('ANSWER');
        return {
          score: found ? (week >= 4 ? 0.8 : 0.9) : 0.2,
          pass: found,
          reasoning: found ? 'It answers.' : 'It does not answer.',
        };
      },
    },
  },
  pairwiseJudges: {
    prefer: {
      schema: z.object({}).passthrough(),
      compare: async (input) => {
        const candidate = input.candidate.text.startsWith('ANSWER');
        const baseline = input.baseline.text.startsWith('ANSWER');
        return {
          preference:
            candidate === baseline
              ? 'tie'
              : candidate
                ? 'candidate'
                : 'baseline',
          strength: 1,
          reasoning: 'One of them answers.',
        };
      },
    },
  },
};

/**
 * Six "weekly" runs of the `weekly-mcp` eval into `dir`, each through
 * `runEval`: returns the eval's directory.
 */
export async function weeklyRuns(dir: string): Promise<string> {
  const cases = Array.from({ length: 12 }, (_, i) => ({
    id: `question-${String(i + 1).padStart(2, '0')}`,
    input: `Question #${i + 1}: where is the planning doc for project ${i + 1}?`,
    ...(i < 3 ? { tags: ['regression'] } : {}),
    assertions: { containsText: 'ANSWER' },
  }));
  await fs.writeFile(
    path.join(dir, 'cases.json'),
    JSON.stringify({ name: 'weekly-questions', cases })
  );
  const config = () => ({
    name: 'weekly-mcp',
    datasets: ['./cases.json'],
    client: 'preview/client/scripted',
    model: 'claude-sonnet-4-6',
    servers: {},
    trials: 3,
    judges: ['preview/judge/quality'],
    pairwiseJudges: ['preview/pairwise-judge/prefer'],
    pricing: {
      'claude-sonnet-4-6': { input: 3, output: 15, cacheRead: 0.3 },
    },
    variants: [
      { name: 'official', description: "The vendor's official MCP server." },
      { name: 'glean', description: 'The Glean MCP server, this week.' },
      {
        name: 'glean-plus',
        description: 'The Glean MCP server with the new search tool.',
      },
    ],
  });
  globalThis.Date = WeeklyDate as DateConstructor;
  let evalDirectory = '';
  try {
    for (week = 1; week <= 6; week++) {
      clockOffset = weekStart(week) - RealDate.now();
      // A new judge version is a new judge identity: a new era.
      (plugin.judges!.quality as { version?: string }).version =
        week >= 4 ? '2' : '1';
      await fs.writeFile(path.join(dir, 'eval.json'), JSON.stringify(config()));
      const result = await runEval({
        configPath: path.join(dir, 'eval.json'),
        rootDir: dir,
        plugins: [plugin],
        // Week 5: one variant only, a partial run.
        ...(week === 5 ? { variant: ['glean'] } : {}),
      });
      evalDirectory = path.dirname(path.dirname(result.outputDir));
      console.log(
        `week ${week}: ${path.basename(result.outputDir)}${week === 5 ? ' (partial)' : ''}`
      );
    }
  } finally {
    globalThis.Date = RealDate;
  }
  return evalDirectory;
}
