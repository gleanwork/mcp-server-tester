import type {
  RunReportDifference,
  RunReportVariant,
  VariantToolChange,
} from '../../types';
import { ChangeDiff } from '../Comparison/ChangeDiff';

/** One candidate's setup, against the baseline's. */
export interface SetupDiffEntry {
  variant: RunReportVariant;
  differences: RunReportDifference[];
  toolChanges: VariantToolChange[];
}

/** What one variant runs with that the baseline doesn't: setup fields, then tool metadata. */
function VariantDiff({
  entry: { variant, differences, toolChanges },
  baselineName,
  titled,
}: {
  entry: SetupDiffEntry;
  baselineName: string;
  /** Whether to name the variant above its diff: when the section shows several. */
  titled: boolean;
}) {
  const same = differences.length === 0 && toolChanges.length === 0;
  return (
    <div className="grid gap-3">
      {titled && (
        <h3 className="font-mono text-sm font-semibold">{variant.name}</h3>
      )}
      {variant.description && (
        <p className="max-w-[80ch] text-sm text-muted-foreground">
          {titled ? null : (
            <>
              <span className="font-mono">{variant.name}</span>:{' '}
            </>
          )}
          {variant.description}
        </p>
      )}
      {same ? (
        <p className="text-sm text-muted-foreground">
          No recorded setting differs from{' '}
          <span className="font-mono">{baselineName}</span>: client, model,
          server labels, client options, tool metadata, input template and
          judges are the same.
        </p>
      ) : null}
      {differences.length > 0 && (
        <div className="overflow-x-auto rounded-lg border bg-card">
          <table className="w-full text-sm">
            <thead className="bg-muted/50 text-muted-foreground">
              <tr>
                <th scope="col" className="px-3 py-2 text-left font-semibold">
                  Setting
                </th>
                <th scope="col" className="px-3 py-2 text-left font-semibold">
                  <span className="font-mono">{baselineName}</span> (baseline)
                </th>
                <th scope="col" className="px-3 py-2 text-left font-semibold">
                  <span className="font-mono">{variant.name}</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {differences.map((row) => (
                <tr key={row.field} className="border-t align-top">
                  <th
                    scope="row"
                    className="px-3 py-2 text-left font-mono font-normal"
                  >
                    {row.field}
                  </th>
                  <td className="whitespace-pre-wrap wrap-break-word px-3 py-2 font-mono text-xs text-muted-foreground">
                    {row.baseline ?? '—'}
                  </td>
                  <td className="whitespace-pre-wrap wrap-break-word px-3 py-2 font-mono text-xs">
                    {row.variant ?? '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {toolChanges.length > 0 && (
        <ChangeDiff
          variantLabel={variant.name}
          changes={toolChanges}
          baselineLabel={baselineName}
        />
      )}
    </div>
  );
}

/** What each variant runs with that the baseline doesn't. */
export function SetupDiff({
  variants,
  baselineName,
}: {
  variants: SetupDiffEntry[];
  baselineName: string;
}) {
  if (variants.length === 0) return null;
  return (
    <section aria-labelledby="run-diff-h" className="grid gap-3">
      <h2 id="run-diff-h" className="text-lg font-semibold">
        What differs
      </h2>
      <div className="grid gap-6">
        {variants.map((entry) => (
          <VariantDiff
            key={entry.variant.id}
            entry={entry}
            baselineName={baselineName}
            titled={variants.length > 1}
          />
        ))}
      </div>
    </section>
  );
}
