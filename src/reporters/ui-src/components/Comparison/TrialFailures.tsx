import type {
  MCPComparisonData,
  VariantComparisonEntry,
  VariantToolMistake,
} from '../../types';
import {
  FAILURE_COLOR,
  FAILURE_KINDS,
  FAILURE_LABEL,
  variantName,
} from './format';
import { useTrialLookup, type TrialLookup } from '../RunReport/TrialDetail';

/** The answer of one failed trial a mistake covers: what the user saw. */
function sampleAnswer(
  lookup: TrialLookup | null,
  variantId: string,
  mistake: VariantToolMistake
): { caseId: string; text: string } | null {
  if (!lookup) return null;
  for (const caseId of mistake.caseIds) {
    const trial = lookup.trials[variantId]?.[caseId]?.find(
      (t) => !t.pass && t.finalText
    );
    if (trial?.finalText) return { caseId, text: trial.finalText };
  }
  return null;
}

/** One variant's recurring mistakes, each with an answer it gave. */
function Mistakes({
  data,
  variant,
  lookup,
}: {
  data: MCPComparisonData;
  variant: VariantComparisonEntry;
  lookup: TrialLookup | null;
}) {
  return (
    <div className="grid gap-2">
      <h3 className="font-semibold">
        What went wrong for{' '}
        <span className="font-mono">{variantName(data, variant)}</span>
      </h3>
      {variant.mistakes.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No tool-call traces were recorded for its failed trials.
        </p>
      ) : (
        <ul className="grid gap-2 text-sm">
          {variant.mistakes.map((m, i) => {
            const sample = sampleAnswer(lookup, variant.id, m);
            return (
              <li key={i} className="grid gap-1 border-b pb-2">
                <span className="flex justify-between gap-3">
                  <span>
                    {m.called === null ? (
                      <>No tool called</>
                    ) : m.calledExpected ? (
                      <>
                        <span className="font-mono">{m.called}</span> called,
                        but the trial failed
                      </>
                    ) : (
                      <>
                        <span className="font-mono">{m.called}</span> called
                      </>
                    )}
                    {m.expected.length > 0 && !m.calledExpected && (
                      <>
                        ; expected{' '}
                        <span className="font-mono">
                          {m.expected.join(', ')}
                        </span>
                      </>
                    )}
                  </span>
                  <span className="whitespace-nowrap font-mono text-muted-foreground">
                    {m.trials} {m.trials === 1 ? 'trial' : 'trials'}
                  </span>
                </span>
                <span className="text-xs text-muted-foreground">
                  {m.caseIds.join(', ')}
                </span>
                {sample && (
                  <blockquote className="border-l-2 pl-2 text-xs text-foreground/90">
                    <span className="font-mono text-muted-foreground">
                      {sample.caseId}:
                    </span>{' '}
                    “
                    {sample.text.length > 200
                      ? `${sample.text.slice(0, 200).trimEnd()}…`
                      : sample.text}
                    ”
                  </blockquote>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

export function TrialFailures({
  data,
  selectedId,
}: {
  data: MCPComparisonData;
  selectedId: string;
}) {
  const lookup = useTrialLookup();
  const failing = data.variants.filter((v) => v.failedTrials > 0);
  const kinds = FAILURE_KINDS.filter((kind) =>
    data.variants.some((v) => v.failures[kind] > 0)
  );
  if (kinds.length === 0) return null;

  return (
    <section aria-labelledby="exp-fail-h" className="grid gap-2">
      <h2 id="exp-fail-h" className="text-lg font-semibold">
        Why trials failed
      </h2>
      <p className="text-sm text-muted-foreground">
        Every failed trial, grouped by what went wrong.
      </p>
      <div className="grid items-start gap-8 lg:grid-cols-[1.6fr_1fr]">
        <figure className="grid gap-3">
          <div className="grid gap-3">
            {data.variants.map((v) => (
              <div
                key={v.id}
                className="grid grid-cols-[max-content_1fr] items-center gap-3 sm:grid-cols-[max-content_1fr_140px]"
              >
                <span
                  className={`font-mono text-sm ${v.id === selectedId ? 'font-bold' : ''}`}
                >
                  {variantName(data, v)}
                </span>
                <span
                  className="flex h-[18px] overflow-hidden rounded-sm bg-muted"
                  role="img"
                  aria-label={`${v.failedTrials} of ${v.trials} trials failed: ${kinds
                    .map((k) => `${FAILURE_LABEL[k]} ${v.failures[k]}`)
                    .join(', ')}`}
                >
                  {kinds.map((k) =>
                    v.failures[k] > 0 ? (
                      <span
                        key={k}
                        className={FAILURE_COLOR[k]}
                        style={{
                          width: `${(v.failures[k] / Math.max(1, v.trials)) * 100}%`,
                        }}
                        title={`${FAILURE_LABEL[k]}: ${v.failures[k]}`}
                      />
                    ) : null
                  )}
                </span>
                <span className="col-start-2 font-mono text-xs text-muted-foreground sm:col-start-auto sm:text-right">
                  {v.failedTrials} of {v.trials} failed
                </span>
              </div>
            ))}
          </div>
          <div className="flex flex-wrap gap-4 text-xs text-muted-foreground">
            {kinds.map((k) => (
              <span key={k} className="inline-flex items-center gap-1">
                <span className={`h-3 w-3 rounded-sm ${FAILURE_COLOR[k]}`} />
                {FAILURE_LABEL[k]}
              </span>
            ))}
          </div>
          <figcaption className="text-xs text-muted-foreground">
            Bar length is the share of each variant’s trials that failed.
            Shorter is better.
          </figcaption>
          <details className="text-sm">
            <summary className="cursor-pointer text-muted-foreground">
              Failure counts as a table
            </summary>
            <div className="mt-2 overflow-x-auto rounded-lg border">
              <table className="w-full text-sm">
                <thead className="bg-muted/50 text-muted-foreground">
                  <tr>
                    <th
                      scope="col"
                      className="px-3 py-2 text-left font-semibold"
                    >
                      Variant
                    </th>
                    {kinds.map((k) => (
                      <th
                        key={k}
                        scope="col"
                        className="px-3 py-2 text-right font-semibold"
                      >
                        {FAILURE_LABEL[k]}
                      </th>
                    ))}
                    <th
                      scope="col"
                      className="px-3 py-2 text-right font-semibold"
                    >
                      Total
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {data.variants.map((v) => (
                    <tr key={v.id} className="border-t">
                      <th
                        scope="row"
                        className="px-3 py-2 text-left font-mono font-normal"
                      >
                        {variantName(data, v)}
                      </th>
                      {kinds.map((k) => (
                        <td key={k} className="px-3 py-2 text-right font-mono">
                          {v.failures[k]}
                        </td>
                      ))}
                      <td className="px-3 py-2 text-right font-mono">
                        {v.failedTrials}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </details>
        </figure>

        <div className="grid gap-6">
          {failing.map((variant) => (
            <Mistakes
              key={variant.id}
              data={data}
              variant={variant}
              lookup={lookup}
            />
          ))}
        </div>
      </div>
    </section>
  );
}
