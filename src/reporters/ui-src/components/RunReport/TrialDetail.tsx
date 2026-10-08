import { createContext, useContext } from 'react';
import type {
  RunReportEvent,
  RunReportPreference,
  RunReportTrial,
} from '../../types';
import { TONE } from '../Comparison/format';

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

function Badge({ pass }: { pass: boolean }) {
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
      <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words px-2 pb-2 font-mono text-xs">
        {text}
      </pre>
    </details>
  );
}

function EventRow({ event }: { event: RunReportEvent }) {
  const name = [event.server, event.name].filter(Boolean).join(' · ');
  return (
    <li className="grid gap-1">
      <div className="flex flex-wrap items-baseline gap-2 text-xs">
        <span className="font-mono text-muted-foreground">{event.kind}</span>
        {name && <span className="font-mono font-semibold">{name}</span>}
        {event.isError && (
          <span className={`rounded px-1.5 font-semibold ${TONE.bad}`}>
            error
          </span>
        )}
      </div>
      {event.input && <Block label="input" text={event.input} />}
      {event.output && <Block label="output" text={event.output} />}
      {event.text && <Block label="text" text={event.text} />}
    </li>
  );
}

/** One trial in full: its scores, its trace, its answer. */
export function TrialView({
  trial,
  index,
}: {
  trial: RunReportTrial;
  index: number;
}) {
  return (
    <li className="grid gap-2 rounded-md border p-2 text-sm">
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
        <ul className="grid gap-1" aria-label="Scores">
          {trial.scores.map((score, i) => (
            <li key={i} className="grid gap-0.5 text-xs">
              <span className="flex flex-wrap items-baseline gap-2">
                <Badge pass={score.pass} />
                <span className="font-mono font-semibold">{score.grader}</span>
                {score.score !== undefined && (
                  <span className="font-mono text-muted-foreground">
                    score {Number(score.score.toFixed(2))}
                  </span>
                )}
              </span>
              {(score.reasoning ?? score.details) && (
                <span className="text-muted-foreground">
                  {score.reasoning ?? score.details}
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
      {trial.events.length > 0 ? (
        <details>
          <summary className="cursor-pointer text-xs text-muted-foreground">
            Trace: {trial.events.length}{' '}
            {trial.events.length === 1 ? 'event' : 'events'}
            {(() => {
              const calls = trial.events.filter((e) => e.kind === 'tool_call');
              return calls.length
                ? ` · called ${calls.map((e) => e.name).join(' → ')}`
                : ' · no tool calls';
            })()}
          </summary>
          <ol className="mt-2 grid gap-2">
            {trial.events.map((event, i) => (
              <EventRow key={i} event={event} />
            ))}
          </ol>
        </details>
      ) : (
        <p className="text-xs text-muted-foreground">No trace recorded.</p>
      )}
      {trial.finalText && <Block label="answer" text={trial.finalText} />}
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
    <div className="grid gap-1 rounded-md border p-2 text-xs">
      <span className="font-semibold">Pairwise, against the baseline</span>
      {preferences.map((p, i) => (
        <div key={i} className="grid gap-0.5">
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
