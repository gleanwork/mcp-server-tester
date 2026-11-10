/**
 * Grading a stored run (`mst grade`): each trial's stored transcript stands in for
 * the client run, so a run is graded with the same pipeline that collected
 * it, without starting a client.
 */
import path from 'node:path';
import type { MCPConfig } from '../config/mcpConfig.js';
import type { WriteRecord } from '../types/index.js';
import type { EvalCase, EvalDataset } from './datasetTypes.js';
import type {
  ClientRunResult,
  Transcript,
  TranscriptEvidence,
} from './evalFrameworkTypes.js';
import type { EvalConfig, EvalVariant } from './evalConfig.js';
import {
  failedExecution,
  type CaseExecution,
  type ClientExecution,
} from './caseExecution.js';
import { clientRunToExecution } from './clientTranscript.js';
import {
  trialArtifactsPath,
  type RunRecord,
  type TrialRecord,
} from './runFormat.js';
import { unknownTranscriptFields } from './transcriptFormat.js';
import { ALL_ARTIFACTS } from './allArtifacts.js';
import { endingOf, resumeCollects } from './trialEnding.js';
import fs from 'node:fs/promises';

/** A stored run to grade, and the ID of the run that grades it. */
export interface RunReplay {
  /** The stored run's `run.json`. */
  run: RunRecord;
  /** The stored run's directory. */
  directory: string;
  /** The new run's ID: the stored run's with the next `.g<n>`. */
  runId: string;
  /** The run that collected the transcripts: a regrade's own source, or the run. */
  gradedFrom: string;
  /** When that run collected them: its summary's `timestamp`. */
  collectedAt: string;
  /** Stored trials by variant, then case, in trial order. */
  trials: Map<string, Map<string, TrialRecord[]>>;
  /**
   * `mst run --resume`: the stored run's missing trials are collected again,
   * and the run is graded into its own directory, not as a regrade.
   */
  resume?: boolean;
}

/**
 * The replay of a stored run: its trials grouped by variant and case. Fails
 * when the transcripts can't be graded: none were stored, or they were stored
 * without the answers and tool outputs judges read.
 */
export function runReplay(
  run: RunRecord,
  directory: string,
  trials: readonly TrialRecord[],
  runId: string,
  collectedAt: string
): RunReplay {
  if (trials.length === 0)
    throw new Error(`Run ${run.runId} stored no trials to grade.`);
  if (run.redactStoredResponses)
    throw new Error(
      `Run ${run.runId} stored redacted transcripts, without the answers and tool outputs graders read, so it can't be graded again. Collect with "redactStoredResponses": false in the eval config (mst run --no-grade requires it).`
    );
  const byVariant = new Map<string, Map<string, TrialRecord[]>>();
  for (const trial of trials) {
    // The path comes from a file anyone could edit: it must be the trial's
    // own place in the run, or judges could be shown any directory.
    if (
      trial.artifacts !== undefined &&
      trial.artifacts !==
        trialArtifactsPath(trial.variant, trial.caseId, trial.trial)
    )
      throw new Error(
        `Run ${run.runId}'s trial ${trial.trial} of case "${trial.caseId}" on variant "${trial.variant}" names artifacts at "${trial.artifacts}", not at ${trialArtifactsPath(trial.variant, trial.caseId, trial.trial)}: the run directory was changed.`
      );
    const byCase =
      byVariant.get(trial.variant) ?? new Map<string, TrialRecord[]>();
    byVariant.set(trial.variant, byCase);
    byCase.set(trial.caseId, [...(byCase.get(trial.caseId) ?? []), trial]);
  }
  for (const byCase of byVariant.values())
    for (const list of byCase.values()) list.sort((a, b) => a.trial - b.trial);
  return {
    run,
    directory,
    runId,
    gradedFrom: run.gradedFrom ?? run.runId,
    collectedAt,
    trials: byVariant,
  };
}

/**
 * The eval config's variants that the stored run ran, in the config's order.
 * Fails for a stored variant the config no longer has.
 */
export function replayedVariants(
  evalConfig: EvalConfig,
  replay: RunReplay
): EvalVariant[] {
  const variants: EvalVariant[] = evalConfig.variants?.length
    ? evalConfig.variants
    : [{ name: 'default' }];
  const missing = [...replay.trials.keys()].filter(
    (name) => !variants.some((variant) => variant.name === name)
  );
  if (missing.length)
    throw new Error(
      `Run ${replay.run.runId} ran variant ${missing.map((name) => `"${name}"`).join(', ')}, which the eval config doesn't have. Variants: ${variants.map((variant) => variant.name).join(', ')}.`
    );
  return variants.filter((variant) => replay.trials.has(variant.name));
}

/** Fails for a stored case that no dataset has any more. */
export function assertReplayedCases(
  replay: RunReplay,
  datasets: readonly EvalDataset[]
): void {
  const known = new Set(
    datasets.flatMap((dataset) => dataset.cases.map((evalCase) => evalCase.id))
  );
  const missing = [
    ...new Set(
      [...replay.trials.values()].flatMap((byCase) =>
        [...byCase.keys()].filter((id) => !known.has(id))
      )
    ),
  ];
  if (missing.length)
    throw new Error(
      `Run ${replay.run.runId} ran case ${missing
        .slice(0, 5)
        .map((id) => `"${id}"`)
        .join(
          ', '
        )}${missing.length > 5 ? ` and ${missing.length - 5} more` : ''}, which the eval's datasets no longer have.`
    );
}

/**
 * A dataset's cases the stored run ran on a variant, each with the number of
 * trials it stored.
 */
export function replayedCases(
  dataset: EvalDataset,
  replay: RunReplay,
  variant: string
): EvalDataset {
  const byCase = replay.trials.get(variant) ?? new Map<string, TrialRecord[]>();
  return {
    ...dataset,
    cases: dataset.cases
      .filter((evalCase) => byCase.has(evalCase.id))
      .map(
        (evalCase): EvalCase => ({
          ...evalCase,
          trials: byCase.get(evalCase.id)!.length,
        })
      ),
  };
}

/**
 * A trial's stored artifacts, as a directory that resolves inside the run:
 * a symbolic link on the way can't point judges elsewhere.
 */
async function storedArtifactsDir(
  directory: string,
  relative: string
): Promise<string> {
  const [run, dir] = await Promise.all([
    fs.realpath(directory),
    fs.realpath(path.join(directory, relative)),
  ]);
  if (dir !== path.join(run, relative))
    throw new Error(
      `${path.join(directory, relative)} leads outside the run directory.`
    );
  return dir;
}

/**
 * Fails, before anything is graded, when a trial's stored artifacts are
 * missing or lead outside the run directory.
 */
export async function assertStoredArtifacts(replay: RunReplay): Promise<void> {
  for (const byCase of replay.trials.values())
    for (const trials of byCase.values())
      for (const trial of trials)
        if (trial.artifacts !== undefined)
          await storedArtifactsDir(replay.directory, trial.artifacts).catch(
            (error: unknown) => {
              throw new Error(
                `Run ${replay.run.runId}'s artifacts for trial ${trial.trial} of case "${trial.caseId}" on variant "${trial.variant}" can't be read: ${error instanceof Error ? error.message : String(error)}`
              );
            }
          );
}

/** A stored trial as the execution that produced it. */
async function storedExecution(
  trial: TrialRecord,
  directory: string,
  servers: MCPConfig[],
  evidence: TranscriptEvidence
): Promise<CaseExecution> {
  const transcript = trial.transcript as Transcript | undefined;
  // A trial a grader couldn't score stores "Not graded: …" as its error. The
  // client ran; finishing its grading is what a regrade is for.
  const runnerError =
    trial.gradingError === undefined ? trial.error : undefined;
  // As it was recorded: a regrade never changes how an attempt ended.
  const ending = endingOf(trial);
  if (!transcript) {
    const execution = failedExecution(
      runnerError ?? 'The stored trial has no transcript.'
    );
    return { ...execution, preExecutionDurationMs: trial.durationMs, ending };
  }
  const run: ClientRunResult = {
    events: transcript.events ?? [],
    finalText: transcript.finalText ?? '',
    ...(transcript.error !== undefined ? { error: transcript.error } : {}),
    // What the trial recorded beyond its events: a resume rewrites every
    // stored transcript from this run, so a field left out here is lost.
    ...(transcript.modelCalls?.length
      ? { modelCalls: transcript.modelCalls }
      : {}),
    ...(transcript.hostTelemetry
      ? { hostTelemetry: transcript.hostTelemetry }
      : {}),
    ...(transcript.startedAt ? { startedAt: transcript.startedAt } : {}),
    ...(transcript.completedAt ? { completedAt: transcript.completedAt } : {}),
    ...((trial.clientUsage ?? transcript.usage)
      ? {
          usage: (trial.clientUsage ??
            transcript.usage) as ClientRunResult['usage'],
        }
      : {}),
    ...(trial.clientTelemetry
      ? { telemetry: trial.clientTelemetry as Record<string, unknown> }
      : {}),
    ...(trial.clientDiagnostics
      ? {
          diagnostics:
            trial.clientDiagnostics as ClientRunResult['diagnostics'],
        }
      : {}),
    // The copy the run kept: judges read what they read when it ran.
    ...(trial.artifacts
      ? {
          artifacts: {
            dir: await storedArtifactsDir(directory, trial.artifacts),
            include: ALL_ARTIFACTS,
          },
        }
      : {}),
  };
  const execution = clientRunToExecution(
    run,
    (trial.transcriptEvidence as TranscriptEvidence | undefined) ??
      transcript.evidence ??
      evidence,
    servers
  );
  const completed: ClientExecution = {
    ...execution,
    // Fields a newer MST or client recorded: the regraded transcript keeps
    // them, as it keeps unknown fields in events and the write record.
    ...(execution.transcript
      ? {
          transcript: {
            ...unknownTranscriptFields(trial.transcript ?? {}),
            ...execution.transcript,
          },
        }
      : {}),
    response: {
      ...execution.response,
      ...(trial.skillLoads
        ? {
            skillLoads:
              trial.skillLoads as ClientExecution['response']['skillLoads'],
          }
        : {}),
    },
    ...(trial.clientMetadata
      ? {
          clientMetadata:
            trial.clientMetadata as ClientExecution['clientMetadata'],
        }
      : {}),
    // What its proxies recorded when it ran (ADR 0014): a regrade checks the
    // same writes.
    ...(trial.writeRecord
      ? { writeRecord: trial.writeRecord as WriteRecord }
      : {}),
    // The trial took this long when it ran; grading adds its own time.
    preExecutionDurationMs: trial.durationMs,
    ending,
  };
  // An error the runner recorded, not the client, still fails the trial.
  return runnerError !== undefined && completed.error === undefined
    ? { ...completed, error: runnerError }
    : completed;
}

/**
 * The case executor for a variant of a replay: each call returns the case's
 * next stored trial.
 */
export function replayExecutor(
  replay: RunReplay,
  variant: string,
  servers: MCPConfig[],
  evidence: TranscriptEvidence,
  /** For a resume: a missing trial as it was collected again. */
  collected?: (caseId: string, trial: number) => CaseExecution | undefined
): (evalCase: EvalCase) => Promise<CaseExecution> {
  const next = new Map<string, number>();
  return async (evalCase) => {
    const trials = replay.trials.get(variant)?.get(evalCase.id) ?? [];
    const index = next.get(evalCase.id) ?? 0;
    next.set(evalCase.id, index + 1);
    const trial = trials[index];
    if (collected && resumeCollects(trial)) {
      const execution = collected(evalCase.id, index);
      if (execution) return execution;
    }
    if (!trial)
      return failedExecution(
        new Error(
          `Run ${replay.run.runId} has no trial ${index} of case "${evalCase.id}" on variant "${variant}".`
        )
      );
    return storedExecution(trial, replay.directory, servers, evidence);
  };
}
