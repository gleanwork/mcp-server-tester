import { createContext, useContext } from 'react';
import type {
  RunReportEvent,
  RunReportPreference,
  RunReportTrial,
  RunReportWrites,
} from '../../types';
import { TONE, graderName } from '../Comparison/format';

/** A run report's trials and pairwise preferences, by variant ID, then case ID. */
export interface TrialLookup {
  trials: Record<string, Record<string, RunReportTrial[]>>;
  preferences: Record<string, Record<string, RunReportPreference[]>>;
  /** The baseline's ID, whose preferences are the other side of each variant's. */
  baselineId: string;
  /** Whether the run stored responses redacted. */
  redacted: boolean;
}

/**
 * Set by the run report so the case grid can show each trial in full. A
 * tool optimization report has none and shows each trial's calls only.
 */
export const TrialLookupContext = createContext<TrialLookup | null>(null);

export function useTrialLookup(): TrialLookup | null {
  return useContext(TrialLookupContext);
}

function Badge({ pass, unknown }: { pass: boolean; unknown?: boolean }) {
  if (unknown)
    return (
      <span
        className={`rounded px-1.5 text-xs font-bold ${TONE.warn}`}
        title="The judge couldn't tell from the transcript. The trial doesn't pass, and the judge's pass rate leaves it out."
      >
        UNKNOWN
      </span>
    );
  return (
    <span
      className={`rounded px-1.5 text-xs font-bold ${pass ? TONE.good : TONE.bad}`}
    >
      {pass ? 'PASS' : 'FAIL'}
    </span>
  );
}

function Block({ label, text }: { label: string; text: string }) {
  return (
    <details className="rounded border bg-muted/30">
      <summary className="cursor-pointer px-2 py-1 text-xs text-muted-foreground">
        {label}
      </summary>
      <pre className="max-h-64 overflow-auto whitespace-pre-wrap wrap-break-word px-2 pb-2 font-mono text-xs">
        {text}
      </pre>
    </details>
  );
}

function EventRow({ event }: { event: RunReportEvent }) {
  const name = [event.server, event.name].filter(Boolean).join(' · ');
  return (
    <li className="grid grid-cols-[minmax(0,1fr)] gap-1">
      <div className="flex flex-wrap items-baseline gap-2 text-xs">
        <span className="font-mono text-muted-foreground">{event.kind}</span>
        {name && <span className="font-mono font-semibold">{name}</span>}
        {event.isError && (
          <span className={`rounded px-1.5 font-semibold ${TONE.bad}`}>
            error
          </span>
        )}
        {event.simulatedWrite && (
          <span
            className={`rounded px-1.5 font-semibold ${TONE.warn}`}
            title="MST made up this reply. Nothing was written."
          >
            simulated
          </span>
        )}
      </div>
      {event.input && <Block label="input" text={event.input} />}
      {event.output && <Block label="output" text={event.output} />}
      {event.text && <Block label="text" text={event.text} />}
    </li>
  );
}

/**
 * `linear.list_issues(assignee: "me")`: a tool call, under its server when it
 * has one (two servers can have a tool of the same name), and its arguments,
 * shortened.
 */
function callText(event: RunReportEvent, max = 90): string {
  const name =
    event.server && event.name
      ? `${event.server}.${event.name}`
      : (event.name ?? event.kind);
  if (!event.input) return name;
  let args = event.input;
  try {
    const parsed: unknown = JSON.parse(event.input);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed))
      args = Object.entries(parsed as Record<string, unknown>)
        .map(([key, value]) => `${key}: ${JSON.stringify(value)}`)
        .join(', ');
  } catch {
    // Not JSON (already shortened): show it as is.
  }
  const text = `${name}(${args})`;
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** How a trial's transcript reads in one line: its tool calls, or that it called none. */
export function transcriptSummary(trial: RunReportTrial): string {
  const calls = trial.events.filter((e) => e.kind === 'tool_call');
  if (calls.length) return calls.map((e) => callText(e)).join(' → ');
  if (trial.events.length || trial.hasTranscript) return 'called no tools';
  return 'no transcript recorded';
}

const WRITE_MODE_TEXT: Record<
  RunReportWrites['writes'][number]['mode'],
  string
> = {
  planned: 'stopped',
  simulated: 'stopped, simulated reply',
  'server-planned': 'stopped by the server',
};

/**
 * What the trial's dry-run proxies recorded (ADR 0014): each write they
 * stopped, and the writes the record and the transcript disagree about.
 */
function WriteRecordView({ writes }: { writes: RunReportWrites }) {
  const problems = [
    writes.unreported > 0 &&
      `${writes.unreported} unreported (recorded, not in the transcript)`,
    writes.unrecorded.length > 0 &&
      `${writes.unrecorded.length} unrecorded (in the transcript, never reached the server): ${writes.unrecorded.map((w) => `${w.server}.${w.tool}`).join(', ')}`,
    writes.unclassified.length > 0 &&
      `${writes.unclassified.length} unclassified: ${writes.unclassified.map((c) => `${c.server}.${c.tool} (${c.reason})`).join(', ')}`,
  ].filter((problem): problem is string => typeof problem === 'string');
  return (
    <div
      className="grid grid-cols-[minmax(0,1fr)] gap-1 text-xs"
      aria-label="Write record"
    >
      <span className="font-semibold">
        Write record
        <span className="ml-2 font-normal text-muted-foreground">
          {writes.writes.length === 0
            ? 'no writes'
            : `${writes.writes.length} write${writes.writes.length === 1 ? '' : 's'}`}
          {writes.attribution === 'matched' &&
            ' · trials overlapped: only writes matching this trial’s calls'}
        </span>
      </span>
      {writes.writes.length > 0 && (
        <ol className="grid gap-1">
          {writes.writes.map((write, i) => (
            <li key={i} className="grid grid-cols-[minmax(0,1fr)] gap-1">
              <span className="flex flex-wrap items-baseline gap-2">
                <span className="font-mono font-semibold">
                  {write.server}.{write.tool}
                  {write.target && ` → ${write.target}`}
                </span>
                <span className="text-muted-foreground">
                  {WRITE_MODE_TEXT[write.mode]}
                </span>
              </span>
              {write.input && <Block label="arguments" text={write.input} />}
            </li>
          ))}
        </ol>
      )}
      {problems.map((problem, i) => (
        <p key={i} className={`rounded px-2 py-1 ${TONE.warn}`}>
          {problem}
        </p>
      ))}
    </div>
  );
}

const EXCERPT = 280;

/** The answer, its start shown inline: what the user would have read. */
function Answer({ text }: { text: string }) {
  const long = text.length > EXCERPT;
  return (
    <div className="grid grid-cols-[minmax(0,1fr)] gap-1">
      <blockquote className="whitespace-pre-wrap wrap-break-word border-l-2 pl-2 text-xs text-foreground/90">
        {long ? `${text.slice(0, EXCERPT).trimEnd()}…` : text}
      </blockquote>
      {long && <Block label="full answer" text={text} />}
    </div>
  );
}

/** One trial in full: its scores, its transcript, its answer. */
export function TrialView({
  trial,
  index,
}: {
  trial: RunReportTrial;
  index: number;
}) {
  return (
    <li className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-2 rounded-md border p-2 text-sm">
      <div className="flex items-center justify-between gap-2">
        <span className="font-semibold">
          Trial {index + 1}
          {trial.durationMs !== undefined && (
            <span className="ml-2 font-normal text-muted-foreground">
              {(trial.durationMs / 1000).toFixed(1)} s
            </span>
          )}
          {trial.tokens !== undefined && (
            <span className="ml-2 font-normal text-muted-foreground">
              {(trial.tokens / 1000).toFixed(1)}k tokens
            </span>
          )}
        </span>
        <Badge pass={trial.pass} />
      </div>
      {trial.infrastructureError && (
        <p className={`rounded px-2 py-1 text-xs ${TONE.warn}`}>
          Infrastructure failure: not graded.
        </p>
      )}
      {trial.error && (
        <p className={`rounded px-2 py-1 font-mono text-xs ${TONE.bad}`}>
          {trial.error}
        </p>
      )}
      {trial.scores.length > 0 && (
        <ul
          className="grid grid-cols-[minmax(0,1fr)] gap-1"
          aria-label="Scores"
        >
          {trial.scores.map((score, i) => (
            <li
              key={i}
              className="grid grid-cols-[minmax(0,1fr)] gap-0.5 text-xs"
            >
              <span className="flex flex-wrap items-baseline gap-2">
                <Badge pass={score.pass} unknown={score.unknown === true} />
                <span className="font-mono font-semibold">
                  {score.judge ? score.grader : graderName(score.grader)}
                </span>
                {score.score !== undefined && (
                  <span className="font-mono text-muted-foreground">
                    score {Number(score.score.toFixed(2))}
                  </span>
                )}
                {score.writeEvidence && (
                  <span
                    className="text-muted-foreground"
                    title="What this score of a write rests on: the answer (claimed), the transcript (called), or a dry-run proxy's record (requested)."
                  >
                    write evidence: {score.writeEvidence}
                  </span>
                )}
              </span>
              {(score.reasoning ?? score.details) && (
                <span className="text-muted-foreground">
                  {score.reasoning ?? score.details}
                </span>
              )}
              {score.jury && (
                <ul className="ml-4 grid gap-0.5" aria-label="Jury votes">
                  {score.jury.map((vote, j) => (
                    <li key={j} className="flex flex-wrap items-baseline gap-2">
                      <span className="font-mono">
                        {vote.model ?? `member ${j + 1}`}
                      </span>
                      <span className="font-semibold">{vote.verdict}</span>
                      {vote.reasoning && (
                        <span className="text-muted-foreground">
                          {vote.reasoning}
                        </span>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </li>
          ))}
        </ul>
      )}
      {trial.events.length > 0 ? (
        <details>
          <summary className="cursor-pointer wrap-break-word font-mono text-xs text-muted-foreground">
            {transcriptSummary(trial)}
          </summary>
          <ol className="mt-2 grid gap-2">
            {trial.events.map((event, i) => (
              <EventRow key={i} event={event} />
            ))}
          </ol>
        </details>
      ) : (
        <p className="font-mono text-xs text-muted-foreground">
          {transcriptSummary(trial)}
        </p>
      )}
      {trial.writes && <WriteRecordView writes={trial.writes} />}
      {trial.finalText && <Answer text={trial.finalText} />}
    </li>
  );
}

const PREFERENCE_TEXT: Record<string, string> = {
  candidate: 'prefers this variant',
  baseline: 'prefers the baseline',
  tie: 'tie',
  none: 'no preference',
};

/** Each pairwise judge's preference for this case, against the baseline. */
export function Preferences({
  preferences,
}: {
  preferences: RunReportPreference[];
}) {
  if (preferences.length === 0) return null;
  return (
    <div className="grid grid-cols-[minmax(0,1fr)] gap-1 rounded-md border p-2 text-xs">
      <span className="font-semibold">Pairwise, against the baseline</span>
      {preferences.map((p, i) => (
        <div key={i} className="grid grid-cols-[minmax(0,1fr)] gap-0.5">
          <span>
            <span className="font-mono font-semibold">{p.judge}</span>:{' '}
            {p.error ? (
              <span className="text-red-700 dark:text-red-300">{p.error}</span>
            ) : (
              (PREFERENCE_TEXT[p.preference] ?? p.preference)
            )}
          </span>
          {p.reasoning && (
            <span className="text-muted-foreground">{p.reasoning}</span>
          )}
        </div>
      ))}
    </div>
  );
}
