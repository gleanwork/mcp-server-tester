/**
 * How strong a pass's evidence about writes is (ADR 0014), weakest first:
 * the client said it wrote (`claimed`), its transcript has the call
 * (`called`), a dry-run proxy recorded the request (`requested`), or a check
 * read the service's state (`applied`, which MST doesn't have yet).
 */
import type { WriteEvidence } from '../types/index.js';

/** The write evidence levels, weakest first. */
const WRITE_EVIDENCE_LEVELS: readonly WriteEvidence[] = [
  'claimed',
  'called',
  'requested',
  'applied',
];

/** The weakest of `levels`, or undefined when there are none. */
export function weakestWriteEvidence(
  levels: Iterable<WriteEvidence | undefined>
): WriteEvidence | undefined {
  let weakest: number | undefined;
  for (const level of levels) {
    if (level === undefined) continue;
    const rank = WRITE_EVIDENCE_LEVELS.indexOf(level);
    if (weakest === undefined || rank < weakest) weakest = rank;
  }
  return weakest === undefined ? undefined : WRITE_EVIDENCE_LEVELS[weakest];
}
