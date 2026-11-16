/**
 * The `mst.history/v1` format's schema: `history.json`, as
 * `schema/history/v1/history.schema.json` publishes it. Readers ignore fields
 * they don't know, so every object is loose. The types are in
 * `src/types/history.ts`; `parseHistoryIndex` in `runHistory.ts` returns this
 * schema's output as a `HistoryIndex`, so the compiler keeps the two in step.
 */
import { z } from 'zod';
import { RUN_ID_PATTERN } from './runFormat.js';
import { WriteModeSchema } from './runFileSchemas.js';
import { schemaId } from '../schemaIds.js';

/** The history format. Readers ignore fields they don't know. */
export const HISTORY_FORMAT = 'mst.history/v1' as const;

const PhaseSchema = z.enum(['complete', 'partial', 'skipped', 'failed']);

const JudgeSchema = z.looseObject({
  trials: z.number(),
  passRate: z.number().optional(),
  meanScore: z.number().optional(),
  unknown: z.number().optional(),
  caseIdentities: z.record(z.string(), z.string()).optional(),
});

const PairwiseSchema = z.looseObject({
  judge: z.string(),
  reference: z.looseObject({
    variant: z.string(),
    runId: z.string().optional(),
  }),
  compared: z.number(),
  wins: z.number(),
  ties: z.number(),
  losses: z.number(),
  errors: z.number(),
  winRate: z.number().optional(),
  low: z.number().optional(),
  high: z.number().optional(),
});

const SincePreviousSchema = z.looseObject({
  runId: z.string(),
  passRateDelta: z.number().optional(),
  trialPassRateDelta: z.number().optional(),
  change: z
    .looseObject({
      mean: z.number(),
      lower: z.number(),
      upper: z.number(),
      cases: z.number(),
      pBetter: z.number(),
      pWorse: z.number(),
      assessment: z.enum(['better', 'worse', 'unclear']),
    })
    .optional(),
  regressed: z.boolean(),
  regressedCases: z.array(z.string()),
  improvedCases: z.array(z.string()),
});

const VariantSchema = z.looseObject({
  name: z.string(),
  baseline: z.boolean(),
  client: z.string().optional(),
  model: z.string().optional(),
  servers: z.array(z.string()),
  clientApps: z.array(z.string()).optional(),
  setupHash: z.string(),
  setupParts: z.record(z.string(), z.string()).optional(),
  writeModes: z.record(z.string(), WriteModeSchema).optional(),
  optionKey: z.string().optional(),
  cases: z.number(),
  incomplete: z.number().optional(),
  casePassRate: z.number().optional(),
  trialPassRate: z.number().optional(),
  headline: z
    .looseObject({
      group: z.enum(['capability', 'regression']),
      cases: z.number(),
      passRate: z.number(),
      low: z.number().optional(),
      high: z.number().optional(),
    })
    .optional(),
  judges: z.record(z.string(), JudgeSchema),
  pairwise: z.record(z.string(), PairwiseSchema),
  costUsd: z.number().optional(),
  costSource: z.enum(['client', 'pricing', 'mixed']).optional(),
  unpricedModels: z.array(z.string()).optional(),
  tokens: z
    .looseObject({
      input: z.number().optional(),
      output: z.number().optional(),
      cacheRead: z.number().optional(),
      cacheCreation: z.number().optional(),
    })
    .optional(),
  durationMs: z
    .looseObject({ p50: z.number(), p95: z.number(), mean: z.number() })
    .optional(),
  toolCalls: z.number().optional(),
  mcpCalls: z.number().optional(),
  attempts: z.number(),
  infrastructureFailures: z.number(),
  clientErrors: z.number(),
  outcomes: z.record(
    z.string(),
    z.tuple([z.number(), z.number(), z.union([z.literal(0), z.literal(1)])])
  ),
  era: z.number().int().nonnegative().optional(),
  sincePrevious: SincePreviousSchema.optional(),
});

const ChangeSchema = z.looseObject({
  reason: z.string(),
  variant: z.string().optional(),
  breaks: z.boolean(),
});

const RunSchema = z.looseObject({
  runId: z.string().regex(RUN_ID_PATTERN),
  collectedRunId: z.string().regex(RUN_ID_PATTERN),
  collectedAt: z.string(),
  createdAt: z.string(),
  finishedAt: z.string(),
  status: z.enum(['complete', 'incomplete', 'ungraded', 'failed']),
  phases: z.looseObject({ collect: PhaseSchema, grade: PhaseSchema }),
  partial: z.boolean(),
  selection: z
    .looseObject({
      variants: z.array(z.string()).optional(),
      cases: z.array(z.string()).optional(),
      filterTags: z.array(z.string()).optional(),
      maxCases: z.number().optional(),
      trials: z.number().optional(),
      shard: z.string().optional(),
    })
    .optional(),
  selectionHash: z.string().optional(),
  configId: z.string(),
  contentHash: z.string(),
  mstVersion: z.string(),
  gradedFrom: z.string().optional(),
  supersededBy: z.string().optional(),
  gradings: z.array(z.string()).optional(),
  runner: z.string().optional(),
  baseline: z.string(),
  datasets: z.array(
    z.looseObject({
      name: z.string(),
      caseCount: z.number(),
      contentHash: z.string(),
      type: z.string().optional(),
      source: z.enum(['snapshot', 'live']).optional(),
      snapshot: z.string().optional(),
    })
  ),
  caseIds: z.array(z.string()),
  caseIdsHash: z.string(),
  regressionCases: z.array(z.string()).optional(),
  trialsPerCase: z.looseObject({ min: z.number(), max: z.number() }),
  judges: z.array(
    z.looseObject({
      type: z.string(),
      level: z.string(),
      identity: z.string().optional(),
      version: z.string().optional(),
      optionsHash: z.string(),
    })
  ),
  plugins: z
    .array(
      z.looseObject({
        namespace: z.string(),
        name: z.string(),
        version: z.string().optional(),
        settings: z.string().optional(),
      })
    )
    .optional(),
  redacted: z.boolean(),
  simulateWrites: z.literal(true).optional(),
  variants: z.array(VariantSchema),
  era: z.number().int().nonnegative().optional(),
  changes: z.array(ChangeSchema).optional(),
  builder: z.number().int(),
});

/** `history.json`. */
export const HistoryIndexSchema = z.looseObject({
  format: z.literal(HISTORY_FORMAT),
  kind: z.literal('history'),
  evalName: z.string(),
  updatedAt: z.string(),
  runs: z.array(RunSchema),
  skipped: z.array(z.looseObject({ runId: z.string(), reason: z.string() })),
});

/** The JSON Schema of `history.json`, as `schema/history/v1/` publishes it. */
export function historyJsonSchema(): Record<string, unknown> {
  return {
    $id: schemaId('history/v1/history.schema.json'),
    ...(z.toJSONSchema(HistoryIndexSchema, {
      target: 'draft-7',
      io: 'output',
    }) as Record<string, unknown>),
  };
}
