/**
 * A stored run's traces, as `telemetry.otlp` sends them while the run goes
 * (docs/telemetry.md): for sending a finished run to a collector it didn't
 * send to, or in a form the run's exporter doesn't (a plugin re-encodes and
 * re-batches them). Built from the run directory alone, with the same IDs,
 * so they join any traces the run did send.
 */
import { DEFAULT_CLIENT } from '../clientFields.js';
import type { StoredRun } from '../runFormat.js';
import {
  DEFAULT_MAX_ATTRIBUTE_CHARS,
  caseTrials,
  gradingSpans,
  pairwiseSpans,
  traceRequest,
  trialSpans,
  type OtlpTraceRequest,
  type RunAttributes,
  type SpanOptions,
} from './otlp.js';

export interface StoredRunTraceOptions {
  /** Also send what each trial said, as `telemetry.otlp.content`. Default false. */
  content?: boolean;
  /** As `telemetry.otlp.maxAttributeChars`. Default 16384. */
  maxAttributeChars?: number;
  /** Added to every trace's resource, as `telemetry.otlp.resourceAttributes`. */
  resourceAttributes?: Record<string, string>;
  /** Leave out the verdicts: only what the client did. Default false. */
  trialsOnly?: boolean;
}

/**
 * A stored run's traces: for each trial, its trace and then its verdicts,
 * and each variant's pairwise verdicts. One request per trial's trace, per
 * case's verdicts and per variant's pairwise verdicts, as the run sends them;
 * a collector with a limit on spans per request needs them split further.
 * A regrade's directory gives only its verdicts, which join the traces of the
 * run it graded; a run collected with `--no-grade` gives no verdicts.
 */
export function storedRunTraces(
  stored: StoredRun,
  options: StoredRunTraceOptions = {}
): OtlpTraceRequest[] {
  const { run, summary } = stored;
  // The run whose trials these are: a regrade's is the run it graded.
  const runId = run.gradedFrom ?? run.runId;
  const spanOptions: SpanOptions = {
    content: options.content === true,
    maxChars: options.maxAttributeChars ?? DEFAULT_MAX_ATTRIBUTE_CHARS,
  };
  const resource = options.resourceAttributes ?? {};
  // Times the run didn't record (a verdict's, an untimed trial's): when it
  // finished, so the same run always gives the same traces.
  const now = Date.parse(run.finishedAt);
  // As the run sent them: a regrade sends no trial traces (the run it graded
  // did), and a run that wasn't graded sends no verdicts.
  const sendTrials = run.gradedFrom === undefined;
  const sendVerdicts = !options.trialsOnly && run.phases?.grade !== 'skipped';
  const requests: OtlpTraceRequest[] = [];
  for (const variant of summary.variants) {
    const attributes: RunAttributes = {
      eval: run.evalName,
      runId,
      client:
        run.variants.find((recorded) => recorded.name === variant.name)
          ?.client ?? DEFAULT_CLIENT,
    };
    for (const caseResult of variant.result?.caseResults ?? []) {
      const result = { ...caseResult, variant: variant.name };
      const trials = caseTrials(result);
      for (const { trial, result: trialResult } of sendTrials ? trials : []) {
        const identity = {
          runId,
          variant: variant.name,
          caseId: result.id,
          trial,
        };
        // A trial of several keeps only its own outcome: what the run sent
        // with it (its case's dataset, tags and request) is the case's.
        const traced =
          trialResult === result
            ? result
            : {
                ...trialResult,
                datasetName: result.datasetName,
                tags: result.tags,
                request: result.request,
              };
        requests.push(
          traceRequest(
            trialSpans(traced, identity, attributes, { ...spanOptions, now }),
            attributes,
            resource
          )
        );
      }
      if (!sendVerdicts) continue;
      const verdicts = trials.flatMap(({ trial, result: trialResult }) =>
        gradingSpans(
          trialResult,
          { runId, variant: variant.name, caseId: result.id, trial },
          attributes,
          { ...spanOptions, gradingRunId: run.runId, now }
        )
      );
      if (verdicts.length)
        requests.push(traceRequest(verdicts, attributes, resource));
    }
    if (sendVerdicts && variant.pairwise) {
      const preferences = pairwiseSpans(variant.pairwise, runId, attributes, {
        ...spanOptions,
        gradingRunId: run.runId,
        now,
      });
      if (preferences.length)
        requests.push(traceRequest(preferences, attributes, resource));
    }
  }
  return requests;
}
