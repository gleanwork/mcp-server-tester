import type { RunReportVariant } from '../../types';
import { TONE, pct } from '../Comparison/format';

const MODE_TEXT: Record<string, string> = {
  planned: 'planned (stopped)',
  simulated: 'simulated (stopped, made-up reply)',
  'server-planned': 'server-planned (stopped by the server)',
  live: 'live (writes reach the service)',
  unguarded: 'unguarded (writes not recorded)',
  'read-only': 'read-only',
};

/** What a write case's pass rests on, in words. */
const EVIDENCE_TEXT: Record<string, string> = {
  claimed: 'the answer says so',
  called: 'the transcript has the call',
  requested: 'a dry-run proxy recorded the request',
  applied: "a check read the service's state",
};

/**
 * Each variant's servers' write modes and its write cases (ADR 0014): the
 * pass rate, the weakest evidence it rests on, and the writes the records
 * and transcripts disagree about. Nothing when no variant has any.
 */
export function WriteSummary({ variants }: { variants: RunReportVariant[] }) {
  const rows = variants.filter((variant) => variant.writes);
  if (rows.length === 0) return null;
  return (
    <section aria-labelledby="run-writes-h" className="grid gap-2">
      <h2
        id="run-writes-h"
        className="text-sm font-semibold text-muted-foreground"
      >
        Writes
      </h2>
      <ul className="grid gap-2 text-sm">
        {rows.map((variant) => {
          const writes = variant.writes!;
          const disagreements = [
            writes.unreported
              ? `${writes.unreported} unreported (recorded, not in a transcript)`
              : null,
            writes.unrecorded
              ? `${writes.unrecorded} unrecorded (in a transcript, never reached the server)`
              : null,
            writes.unclassified
              ? `${writes.unclassified} unclassified calls`
              : null,
            // ADR 0014: a write case on a variant with an unguarded server
            // is unguarded too, whatever its graders say.
            writes.casePassRate !== undefined &&
            Object.values(writes.modes ?? {}).includes('unguarded')
              ? `write cases are unguarded: MST didn't record ${Object.entries(
                  writes.modes ?? {}
                )
                  .filter(([, mode]) => mode === 'unguarded')
                  .map(([server]) => server)
                  .join(', ')}'s writes`
              : null,
          ].filter((text): text is string => text !== null);
          return (
            <li key={variant.id} className="grid gap-1">
              <span>
                <span className="font-mono font-semibold">{variant.name}</span>
                {writes.casePassRate !== undefined && (
                  <>
                    : {pct(writes.casePassRate)} of write cases passed
                    {writes.evidence &&
                      `, resting at weakest on ${writes.evidence} (${EVIDENCE_TEXT[writes.evidence] ?? writes.evidence})`}
                  </>
                )}
              </span>
              {writes.modes && (
                <span className="font-mono text-xs text-muted-foreground">
                  {Object.entries(writes.modes)
                    .map(
                      ([server, mode]) =>
                        `${server}: ${MODE_TEXT[mode] ?? mode}`
                    )
                    .join(' · ')}
                </span>
              )}
              {disagreements.map((text, i) => (
                <span
                  key={i}
                  className={`rounded px-2 py-1 text-xs ${TONE.warn}`}
                >
                  {text}
                </span>
              ))}
            </li>
          );
        })}
      </ul>
      {rows.some((variant) => variant.writes!.casePassRate !== undefined) && (
        <p className="text-xs text-muted-foreground">
          No write case reaches applied: MST has no outcome check yet, so no
          grader reads the service's state after a trial.
        </p>
      )}
    </section>
  );
}
