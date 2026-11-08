/**
 * The `writes` grader (ADR 0014): checks a trial's write record, never its
 * transcript, for the writes its case expects (`expected.writes`), with
 * `toolsTriggered`'s matching rules. Its scores rest on what MST's dry-run
 * proxies recorded: `requested` evidence. A required write found only as an
 * unclassified call (MST saw the call, not whether it wrote) is `called`.
 *
 * The record must agree with the transcript: an unreported write (recorded,
 * no call in the transcript) or an unrecorded write (a write call in the
 * transcript that never reached its server's proxy) fails the grader,
 * whatever the case expects.
 */
import type { ValidationResult } from './types.js';
import { partialMatch } from './toolCalls.js';
import type { ExpectedWrites } from '../../evals/datasetTypes.js';
import type { WriteEvidence, WriteRecord } from '../../types/index.js';
import { recordEvidence } from '../../evals/writeEvidence.js';

/** A write grader's result, with what it rests on. */
export interface WritesValidationResult extends ValidationResult {
  evidence: WriteEvidence;
}

type ExpectedWrite = ExpectedWrites['calls'][number];

/** A write in the record as the grader matches it: a dispatcher's by its target. */
interface Candidate {
  server: string;
  tool: string;
  arguments: unknown;
  /** An unclassified call: MST saw the call, not whether it wrote. */
  unclassified: boolean;
}

function describe(write: { server?: string; tool: string }): string {
  return write.server ? `${write.server}.${write.tool}` : write.tool;
}

function sameIdentity(candidate: Candidate, expected: ExpectedWrite): boolean {
  return (
    candidate.tool === expected.tool &&
    (expected.server === undefined || candidate.server === expected.server)
  );
}

function matches(candidate: Candidate, expected: ExpectedWrite): boolean {
  if (!sameIdentity(candidate, expected)) return false;
  if (expected.arguments === undefined) return true;
  const actual =
    typeof candidate.arguments === 'object' && candidate.arguments !== null
      ? (candidate.arguments as Record<string, unknown>)
      : {};
  return partialMatch(actual, expected.arguments);
}

function find(
  candidates: readonly Candidate[],
  expected: ExpectedWrite,
  from = 0
): number {
  for (let i = from; i < candidates.length; i++)
    if (matches(candidates[i]!, expected)) return i;
  return -1;
}

/**
 * Checks `record` against `expected`. With no record, MST saw none of the
 * trial's writes, so the grader fails.
 */
export function validateWrites(
  record: WriteRecord | undefined,
  expected: ExpectedWrites | undefined
): WritesValidationResult {
  if (!record)
    return {
      pass: false,
      evidence: 'called',
      message:
        "This trial has no write record: none of its servers' writes go through a dry-run proxy, so the writes grader can't check them.",
    };

  const problems: string[] = [];
  if (record.unreported > 0)
    problems.push(
      `${record.unreported} recorded write${record.unreported === 1 ? ' has' : 's have'} no call in the transcript (unreported)`
    );
  if (record.unrecorded.length > 0)
    problems.push(
      `the transcript has write calls that never reached their server's proxy (unrecorded): ${record.unrecorded.map(describe).join(', ')}`
    );

  const writes: Candidate[] = record.writes.map((write) => ({
    server: write.server,
    tool: write.target ?? write.tool,
    arguments: write.arguments,
    unclassified: false,
  }));
  const dispatches: Candidate[] = record.unclassified
    .filter((call) => call.reason === 'dispatch' && call.target !== undefined)
    .map((call) => ({
      server: call.server,
      tool: call.target!,
      arguments: call.arguments,
      unclassified: true,
    }));
  const calls = expected?.calls ?? [];
  let evidence: WriteEvidence = recordEvidence(record);
  const missing: ExpectedWrite[] = [];

  if ((expected?.order ?? 'any') === 'strict') {
    let from = 0;
    for (const write of calls) {
      const at = find(writes, write, from);
      if (at >= 0) {
        from = at + 1;
        continue;
      }
      if (write.required === false) continue;
      if (find(dispatches, write) >= 0) evidence = 'called';
      else missing.push(write);
    }
  } else {
    for (const write of calls) {
      if (write.required === false || find(writes, write) >= 0) continue;
      if (find(dispatches, write) >= 0) evidence = 'called';
      else missing.push(write);
    }
  }
  if (missing.length > 0)
    problems.push(
      `expected write${missing.length === 1 ? '' : 's'} not in the record: ${missing
        .map(
          (write) =>
            `${describe(write)}${write.arguments ? ` with ${JSON.stringify(write.arguments)}` : ''}`
        )
        .join(', ')}`
    );

  if (expected?.exclusive === true) {
    const unexpected = writes.filter(
      (write) => !calls.some((call) => sameIdentity(write, call))
    );
    if (unexpected.length > 0)
      problems.push(
        `writes outside the expected list: ${unexpected.map(describe).join(', ')}`
      );
  }

  const details = {
    recorded: writes.map(describe),
    ...(dispatches.length > 0
      ? { unclassified: dispatches.map(describe) }
      : {}),
    attribution: record.attribution,
  };
  if (problems.length > 0)
    return {
      pass: false,
      evidence,
      message: `Writes: ${problems.join('; ')}.`,
      details,
    };
  return {
    pass: true,
    evidence,
    message: `${
      calls.length > 0
        ? 'Every expected write is in the write record'
        : 'The write record agrees with the transcript'
    }${
      evidence === 'called'
        ? ", but it has calls MST couldn't classify: called, not requested."
        : '.'
    }`,
    details,
  };
}
