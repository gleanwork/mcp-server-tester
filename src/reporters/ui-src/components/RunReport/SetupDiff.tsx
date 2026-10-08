import type {
  RunReportDifference,
  RunReportVariant,
  VariantToolChange,
} from '../../types';
import { ChangeDiff } from '../Comparison/ChangeDiff';

/** What a variant runs with that the baseline doesn't: setup fields, then tool metadata. */
export function SetupDiff({
  variant,
  baselineName,
  differences,
  toolChanges,
}: {
  variant: RunReportVariant;
  baselineName: string;
  differences: RunReportDifference[];
  toolChanges: VariantToolChange[];
}) {
  const same = differences.length === 0 && toolChanges.length === 0;
  return (
    <section aria-labelledby="run-diff-h" className="grid gap-3">
      <h2 id="run-diff-h" className="text-lg font-semibold">
        What differs
      </h2>
      {variant.description && (
        <p className="max-w-[80ch] text-sm text-muted-foreground">
          <span className="font-mono">{variant.name}</span>:{' '}
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
                  <td className="whitespace-pre-wrap break-words px-3 py-2 font-mono text-xs text-muted-foreground">
                    {row.baseline ?? '—'}
                  </td>
                  <td className="whitespace-pre-wrap break-words px-3 py-2 font-mono text-xs">
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
    </section>
  );
}
