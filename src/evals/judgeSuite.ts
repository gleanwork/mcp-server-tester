/**
 * `mst judge`: judge a saved run of a manifest. Loads the manifest, its
 * plugins and datasets as `mst run` does, runs the judges on the saved
 * responses, and writes the judged results (and, against a baseline run, a
 * pairwise comparison) to a new output directory.
 */

import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import type { EvalCaseResult } from '../types/reporter.js';
import type { EvalCase, EvalDataset } from './datasetTypes.js';
import type {
  EvaluationArmResult,
  EvaluationSummary,
} from './evalFrameworkTypes.js';
import {
  loadEvalManifest,
  type EvalManifest,
  type ExtensionConfig,
} from './evalManifest.js';
import { resolveManifestExtends } from './manifestExtends.js';
import { manifestIdentity } from './manifestIdentity.js';
import { parseManifestJudges, validateManifest } from './manifestValidation.js';
import { assertDatasetNamespaces, loadSuitePlugins } from './suitePlugins.js';
import { getDatasetSource } from './builtinDatasetSources.js';
import { buildEvalDataset } from './buildEvalDataset.js';
import { judgeSavedRun, withSavedArtifacts } from './judgeSavedRun.js';
import {
  comparePairwise,
  type PairwiseComparisonResult,
  type PairwiseJudgeSpec,
} from './pairwiseComparison.js';
import { computeMetrics, type MetricSpec } from './metrics.js';
import { passRate } from './evalRunComparison.js';
import { sumJudgeUsage } from '../judge/judgeContract.js';
import { CORE_METRICS } from './runEvalSuite.js';
import {
  REDACT_STORED_RESPONSES_BY_DEFAULT,
  redactStoredResponses,
} from './resultStore.js';
import type { Plugin } from '../plugins/plugin.js';

export interface JudgeSuiteOptions {
  manifestPath: string;
  /** The saved run: a `results.json`, or a stored arm result. */
  resultsPath: string;
  rootDir?: string;
  pluginPaths?: string[];
  plugins?: readonly Plugin[];
  /** Judge the cases of this arm only, with this arm's judges. */
  arm?: string;
  /**
   * A JSON file with the judges to run instead of the manifest's:
   * `{ "judges": [...], "pairwiseJudges": [...] }`, entries as a manifest
   * lists them.
   */
  judgesPath?: string;
  /** Where the run's evidence directories (`response.artifactsName`) are. */
  artifactsRoot?: string;
  /** A dataset file to read ground truth from instead of the manifest's datasets. */
  datasetPath?: string;
  /** A saved baseline run to compare with, using `pairwiseJudges`. */
  baselinePath?: string;
  baselineArtifactsRoot?: string;
  outputDir?: string;
  concurrency?: number;
}

export interface JudgeSuiteResult {
  outputDir: string;
  summary: EvaluationSummary;
  pairwise?: PairwiseComparisonResult;
}

const JudgesFileSchema = z
  .object({
    judges: z
      .array(
        z.union([z.string(), z.object({ type: z.string() }).passthrough()])
      )
      .optional(),
    pairwiseJudges: z
      .array(
        z.union([
          z.string(),
          z
            .object({
              type: z.string(),
              options: z.record(z.string(), z.unknown()).optional(),
              reps: z.number().int().positive().optional(),
            })
            .strict(),
        ])
      )
      .optional(),
  })
  .strict();

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The case results in a saved run file, and its summary if it is one. */
export function savedCaseResults(
  value: unknown,
  label: string
): { results: EvalCaseResult[]; summary?: EvaluationSummary; arm?: string } {
  if (
    isRecord(value) &&
    Array.isArray(value.results) &&
    Array.isArray(value.arms)
  )
    return {
      results: value.results as EvalCaseResult[],
      summary: value as unknown as EvaluationSummary,
    };
  // A stored arm result: `{ kind: 'eval-runner-result', data: { caseResults } }`.
  const data = isRecord(value) && isRecord(value.data) ? value.data : value;
  if (isRecord(data) && Array.isArray(data.caseResults)) {
    const labels =
      isRecord(value) &&
      isRecord(value.metadata) &&
      isRecord(value.metadata.labels)
        ? value.metadata.labels
        : undefined;
    return {
      results: data.caseResults as EvalCaseResult[],
      ...(typeof labels?.arm === 'string' && { arm: labels.arm }),
    };
  }
  throw new Error(
    `${label} is not a saved run: expected a results.json or a stored arm result.`
  );
}

async function readJson(file: string): Promise<unknown> {
  return JSON.parse(await fs.readFile(file, 'utf8')) as unknown;
}

function normalize(entry: string | Record<string, unknown>): ExtensionConfig {
  return (
    typeof entry === 'string' ? { type: entry } : entry
  ) as ExtensionConfig;
}

function armSummaries(results: EvalCaseResult[]): EvaluationArmResult[] {
  const names = [...new Set(results.map((r) => r.arm ?? 'default'))];
  return names.map((name) => {
    const caseResults = results.filter((r) => (r.arm ?? 'default') === name);
    const totalJudgeUsage = sumJudgeUsage(caseResults.map((r) => r.judgeUsage));
    return {
      name,
      servers: [],
      result: {
        caseResults,
        total: caseResults.length,
        passed: caseResults.filter((r) => r.pass).length,
        failed: caseResults.filter((r) => !r.pass).length,
        durationMs: 0,
        ...(totalJudgeUsage !== undefined && { totalJudgeUsage }),
      },
      metrics: computeMetrics([...CORE_METRICS] as MetricSpec[], caseResults)
        .aggregated,
    } as EvaluationArmResult;
  });
}

export async function judgeSuite(
  options: JudgeSuiteOptions
): Promise<JudgeSuiteResult> {
  const startTime = Date.now();
  const rootDir = options.rootDir ?? process.cwd();
  const manifestDir = path.dirname(path.resolve(options.manifestPath));
  const resolve = (file: string) =>
    path.isAbsolute(file) ? file : path.resolve(rootDir, file);

  const loaded = loadEvalManifest(options.manifestPath, { rootDir });
  const namespaces = await loadSuitePlugins({
    manifestPath: options.manifestPath,
    manifest: loaded,
    rootDir,
    pluginPaths: options.pluginPaths,
    plugins: options.plugins,
  });
  const rawManifest = resolveManifestExtends(loaded, namespaces);
  const manifest: EvalManifest = validateManifest(
    { ...rawManifest, host: rawManifest.host ?? { type: 'claude-cli' } },
    { namespaces }
  );
  const arm = options.arm
    ? manifest.arms?.find((candidate) => candidate.name === options.arm)
    : undefined;
  if (options.arm && manifest.arms?.length && !arm)
    throw new Error(`No arm "${options.arm}" in ${options.manifestPath}.`);
  const rawArm = rawManifest.arms?.find(
    (candidate) => candidate.name === options.arm
  );

  // The judges: the file's, else the arm's or manifest's, as `mst run` merges them.
  const file = options.judgesPath
    ? JudgesFileSchema.parse(await readJson(resolve(options.judgesPath)))
    : undefined;
  let judges: ExtensionConfig[];
  let rawJudges: ExtensionConfig[];
  if (file?.judges) {
    rawJudges = file.judges.map(normalize);
    judges = parseManifestJudges(rawJudges, namespaces);
  } else {
    judges = arm?.judges ?? manifest.judges ?? [];
    rawJudges = rawArm?.judges ?? rawManifest.judges ?? [];
  }
  const pairwiseJudges: PairwiseJudgeSpec[] = (file?.pairwiseJudges ?? []).map(
    (entry) => (typeof entry === 'string' ? { type: entry } : entry)
  );
  if (options.baselinePath && pairwiseJudges.length === 0)
    throw new Error(
      'A baseline run needs pairwise judges: list them as "pairwiseJudges" in --judges.'
    );
  if (!options.baselinePath && judges.length === 0)
    throw new Error(
      `No judges to run: ${options.manifestPath} lists none and no --judges file gives any.`
    );

  // Ground truth: the cases as the run loaded them.
  const sourceManifest: EvalManifest = {
    ...manifest,
    maxCases: undefined,
    filterTags: undefined,
    run: undefined,
  };
  const datasets: EvalDataset[] = options.datasetPath
    ? [
        buildEvalDataset(
          await readJson(resolve(options.datasetPath)),
          undefined,
          sourceManifest
        ),
      ]
    : await Promise.all(
        manifest.datasets.map((source) =>
          getDatasetSource(source.type).load(source, {
            rootDir,
            manifestDir,
            manifest: sourceManifest,
          })
        )
      );
  for (const dataset of datasets) assertDatasetNamespaces(dataset, namespaces);
  const cases = new Map<string, EvalCase>();
  for (const dataset of datasets)
    for (const evalCase of dataset.cases) cases.set(evalCase.id, evalCase);

  const saved = savedCaseResults(
    await readJson(resolve(options.resultsPath)),
    options.resultsPath
  );
  const inArm = (result: EvalCaseResult) =>
    !options.arm || (result.arm ?? saved.arm ?? options.arm) === options.arm;
  const selected = saved.results
    .filter(inArm)
    .map((result) =>
      result.arm || !saved.arm ? result : { ...result, arm: saved.arm }
    );
  const missing = selected.filter((result) => !cases.has(result.id));
  if (missing.length > 0)
    console.warn(
      `[mst] ${missing.length} saved case(s) are not in the datasets and are judged from their saved request: ${missing
        .slice(0, 5)
        .map((result) => result.id)
        .join(', ')}`
    );

  const judged =
    judges.length > 0
      ? await judgeSavedRun({
          caseResults: selected,
          judges: judges as Array<Record<string, unknown>>,
          rawJudges: rawJudges as Array<Record<string, unknown>>,
          cases,
          ...(options.artifactsRoot && {
            artifactsRoot: resolve(options.artifactsRoot),
          }),
          concurrency: options.concurrency ?? manifest.concurrency ?? 4,
        })
      : selected;

  let pairwise: PairwiseComparisonResult | undefined;
  if (options.baselinePath) {
    const baseline = savedCaseResults(
      await readJson(resolve(options.baselinePath)),
      options.baselinePath
    ).results.filter(inArm);
    const withArtifacts = (
      results: readonly EvalCaseResult[],
      root: string | undefined
    ) =>
      results.map((result) => ({
        ...result,
        response: withSavedArtifacts(
          result.response,
          root ? resolve(root) : undefined
        ),
      }));
    pairwise = await comparePairwise({
      baseline: {
        name: 'baseline',
        caseResults: withArtifacts(baseline, options.baselineArtifactsRoot),
      },
      candidate: {
        name: 'candidate',
        caseResults: withArtifacts(selected, options.artifactsRoot),
      },
      judges: pairwiseJudges,
      cases,
      concurrency: options.concurrency ?? manifest.concurrency ?? 4,
    });
  }

  const arms = armSummaries(judged);
  const totalJudgeUsage = sumJudgeUsage([
    ...judged.map((r) => r.judgeUsage),
    pairwise?.usage,
  ]);
  const runId = randomUUID();
  const summary: EvaluationSummary = {
    schemaVersion: 1,
    ...(saved.summary
      ? {
          manifestId: saved.summary.manifestId,
          contentHash: saved.summary.contentHash,
        }
      : manifestIdentity(rawManifest)),
    runId,
    judgedRun: {
      ...(saved.summary?.runId !== undefined && { runId: saved.summary.runId }),
      ...(saved.summary?.timestamp !== undefined && {
        timestamp: saved.summary.timestamp,
      }),
    },
    timestamp: new Date().toISOString(),
    durationMs: Date.now() - startTime,
    manifestName: manifest.name,
    arms,
    metrics: {
      total: judged.length,
      passed: judged.filter((r) => r.pass).length,
      failed: judged.filter((r) => !r.pass).length,
      passRate: passRate({
        passed: judged.filter((r) => r.pass).length,
        total: judged.length,
      }),
      ...(arms[0]?.metrics ?? {}),
    },
    telemetry: {
      cases: judged.length,
      toolCalls: 0,
      failedCases: judged.filter((r) => !r.pass).length,
      ...(totalJudgeUsage !== undefined && { totalJudgeUsage }),
    },
    armDeltas: {},
    results: judged,
  };

  const outputDir = path.join(
    options.outputDir
      ? resolve(options.outputDir)
      : path.join(rootDir, '.mcp-test-results', manifest.name, 'judged'),
    runId
  );
  const redact =
    (manifest.redactStoredResponses as boolean | undefined) ??
    REDACT_STORED_RESPONSES_BY_DEFAULT;
  await fs.mkdir(outputDir, { recursive: true });
  await fs.writeFile(
    path.join(outputDir, 'results.json'),
    `${JSON.stringify(redact ? redactStoredResponses(summary) : summary, null, 2)}\n`
  );
  if (pairwise)
    await fs.writeFile(
      path.join(outputDir, 'pairwise.json'),
      `${JSON.stringify(pairwise, null, 2)}\n`
    );
  return { outputDir, summary, ...(pairwise && { pairwise }) };
}
