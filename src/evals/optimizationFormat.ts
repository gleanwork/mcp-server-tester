import fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { readJsonFile, writeJsonFile } from '../utils/jsonFile.js';
import { RUN_ID_PATTERN } from './runFormat.js';

/**
 * The tool optimization format, `mst.optimization/v1`: what a stored tool
 * optimization keeps (ADR 0008).
 *
 * ```text
 * <eval dir>/optimizations/latest.json
 * <eval dir>/optimizations/<id>/optimization.json
 * <eval dir>/optimizations/<id>/recommendation.md
 * ```
 *
 * The record holds the setup and the history, and names the runs that
 * measured each step (`<eval dir>/runs/<run-id>/`). It holds no scores: they
 * are computed from the runs whenever the record is read. Readers ignore
 * fields they don't know, so adding an optional field keeps the version.
 */
export const OPTIMIZATION_FORMAT = 'mst.optimization/v1' as const;

const RunIdSchema = z.string().regex(RUN_ID_PATTERN);

const CandidateSchema = z.looseObject({
  id: z.string(),
  description: z.string().optional(),
  tools: z.record(
    z.string(),
    z.looseObject({
      name: z.string().optional(),
      description: z.string().optional(),
      inputSchema: z.record(z.string(), z.unknown()).optional(),
    })
  ),
});

/** `optimization.json`. */
const OptimizationRecordSchema = z.looseObject({
  format: z.literal(OPTIMIZATION_FORMAT),
  kind: z.literal('optimization'),
  id: RunIdSchema,
  evalName: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
  mst: z.looseObject({ version: z.string() }),
  /** The eval config's variant every candidate copies. */
  baseVariant: z.string(),
  /** The tools candidates may change. Absent: every tool the servers serve. */
  editableTools: z.array(z.string()).optional(),
  metric: z.string(),
  better: z.enum(['higher', 'lower']),
  /** Most candidates the optimization runs, across every round. Absent: no limit. */
  maxVariants: z.number().int().positive().optional(),
  rules: z.looseObject({
    regressionCheck: z.enum(['significant', 'any-case']),
    regressionTag: z.string(),
    heldOutTag: z.string(),
    allowRegressions: z.boolean(),
  }),
  /** The run-time narrowing every run of the optimization uses. */
  selection: z
    .looseObject({
      cases: z.array(z.string()).optional(),
      filterTags: z.array(z.string()).optional(),
      maxCases: z.number().int().positive().optional(),
      trials: z.number().int().positive().optional(),
    })
    .optional(),
  /** Where every run collects its trials (`--env`), when not locally. */
  environment: z
    .looseObject({
      name: z.string(),
      options: z.record(z.string(), z.string()).optional(),
    })
    .optional(),
  /** The base variant's run. Its run.json holds the servers' tools. */
  baseline: z.looseObject({ runId: RunIdSchema }),
  /**
   * How cases split into capability and regression cases: the regression tag,
   * or a second run of the base variant (`runId`).
   */
  grouping: z.looseObject({
    source: z.enum(['declared', 'grouping-run']),
    runId: RunIdSchema.optional(),
  }),
  rounds: z.array(
    z.looseObject({
      round: z.number().int().nonnegative(),
      createdAt: z.string(),
      /** Who wrote the candidates: `agent` (mst optimize try), or a proposer. */
      proposer: z.string().optional(),
      candidates: z.array(CandidateSchema),
      /** The run that measured the candidates; absent while it runs. */
      runId: RunIdSchema.optional(),
    })
  ),
  finished: z
    .looseObject({
      at: z.string(),
      reason: z.string(),
      recommendation: z.enum(['apply', 'reject', 'inconclusive']).optional(),
      variantId: z.string().optional(),
    })
    .optional(),
});

export type OptimizationRecord = z.infer<typeof OptimizationRecordSchema>;
export type OptimizationRoundRecord = OptimizationRecord['rounds'][number];

/** The directory of an eval's tool optimizations. */
function optimizationsDirectory(evalDirectory: string): string {
  return path.join(evalDirectory, 'optimizations');
}

/** One optimization's directory. */
export function optimizationDirectory(
  evalDirectory: string,
  id: string
): string {
  return path.join(optimizationsDirectory(evalDirectory), id);
}

/** Reads `optimization.json`, saying what is wrong when it isn't one. */
export async function readOptimizationRecord(
  directory: string
): Promise<OptimizationRecord> {
  const file = path.join(directory, 'optimization.json');
  let value: unknown;
  try {
    value = await readJsonFile(file);
  } catch (error) {
    if (error instanceof SyntaxError) throw error;
    throw new Error(
      `${file} is missing: ${directory} isn't a tool optimization.`
    );
  }
  const format = (value as { format?: unknown } | null)?.format;
  if (format !== OPTIMIZATION_FORMAT) {
    const version =
      typeof format === 'string'
        ? /^mst\.optimization\/v(\d+)$/.exec(format)
        : null;
    throw new Error(
      version && Number(version[1]) > 1
        ? `${file} was written by a newer MST (${String(format)}). Upgrade MST to read it.`
        : `${file} isn't in the ${OPTIMIZATION_FORMAT} format.`
    );
  }
  return OptimizationRecordSchema.parse(value);
}

/** Writes `optimization.json` in one step, and points latest.json at it. */
export async function writeOptimizationRecord(
  evalDirectory: string,
  record: OptimizationRecord
): Promise<void> {
  const directory = optimizationDirectory(evalDirectory, record.id);
  await writeJsonFile(path.join(directory, 'optimization.json'), record);
  await writeJsonFile(
    path.join(optimizationsDirectory(evalDirectory), 'latest.json'),
    { format: OPTIMIZATION_FORMAT, kind: 'latest', id: record.id }
  );
}

/**
 * The optimization `reference` names: its id, the end of it (`3fa9c1`), or
 * the latest one when undefined. Throws with the ids there are.
 */
export async function findOptimization(
  evalDirectory: string,
  reference?: string
): Promise<string> {
  const root = optimizationsDirectory(evalDirectory);
  if (reference === undefined) {
    try {
      const latest = (await readJsonFile(path.join(root, 'latest.json'))) as {
        id?: unknown;
      };
      if (typeof latest.id === 'string') return latest.id;
    } catch {
      // Fall through to the error below.
    }
    throw new Error(
      `${evalDirectory} has no tool optimization. Start one with mst optimize start.`
    );
  }
  const ids = await fs
    .readdir(root, { withFileTypes: true })
    .then((entries) =>
      entries
        .filter(
          (entry) => entry.isDirectory() && RUN_ID_PATTERN.test(entry.name)
        )
        .map((entry) => entry.name)
    )
    .catch(() => [] as string[]);
  const matches = ids.filter(
    (id) => id === reference || id.endsWith(reference)
  );
  if (matches.length === 1) return matches[0]!;
  throw new Error(
    matches.length > 1
      ? `"${reference}" matches several optimizations: ${matches.join(', ')}.`
      : `No tool optimization "${reference}" in ${root}.${ids.length ? ` There are: ${ids.join(', ')}.` : ''}`
  );
}
