import type { VariantToolChange } from '../../types';

type Piece = { kind: 'same' | 'removed' | 'added'; text: string };

/** Word-level diff by longest common subsequence. Fine for tool-sized text. */
function wordDiff(before: string, after: string): Piece[] {
  const a = before.split(/(\s+)/);
  const b = after.split(/(\s+)/);
  const n = a.length;
  const m = b.length;
  const lcs = Array.from({ length: n + 1 }, () =>
    new Array<number>(m + 1).fill(0)
  );
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i]![j] =
        a[i] === b[j]
          ? lcs[i + 1]![j + 1]! + 1
          : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
    }
  }
  const out: Piece[] = [];
  const push = (kind: Piece['kind'], text: string) => {
    const last = out[out.length - 1];
    if (last && last.kind === kind) last.text += text;
    else out.push({ kind, text });
  };
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      push('same', a[i]!);
      i++;
      j++;
    } else if (lcs[i + 1]![j]! >= lcs[i]![j + 1]!) {
      push('removed', a[i++]!);
    } else {
      push('added', b[j++]!);
    }
  }
  while (i < n) push('removed', a[i++]!);
  while (j < m) push('added', b[j++]!);
  return out;
}

/** Share of words the two texts have in common. */
function overlap(before: string, after: string): number {
  const a = before.split(/\s+/);
  const b = new Set(after.split(/\s+/));
  return a.filter((w) => b.has(w)).length / Math.max(a.length, b.size);
}

function OneChange({
  change,
  variantLabel,
  baselineLabel,
}: {
  change: VariantToolChange;
  variantLabel: string;
  /** The baseline's label. Absent: "Current" (a tool optimization). */
  baselineLabel?: string;
}) {
  const block = 'whitespace-pre-wrap rounded-md px-3 py-2';
  const isSchema = change.field === 'inputSchema';
  if (
    change.before !== undefined &&
    !isSchema &&
    overlap(change.before, change.after) >= 0.6
  ) {
    return (
      <div className="leading-7">
        {wordDiff(change.before, change.after).map((p, i) =>
          p.kind === 'same' ? (
            <span key={i}>{p.text}</span>
          ) : p.kind === 'removed' ? (
            <del
              key={i}
              className="rounded-sm bg-red-500/10 px-0.5 decoration-red-500"
            >
              {p.text}
            </del>
          ) : (
            <ins
              key={i}
              className="rounded-sm bg-green-500/10 px-0.5 no-underline"
            >
              {p.text}
            </ins>
          )
        )}
      </div>
    );
  }
  return (
    <div className="grid gap-3">
      <div className="grid gap-1">
        <span className="text-xs font-semibold text-muted-foreground">
          {baselineLabel ?? 'Current'}
        </span>
        {change.before !== undefined ? (
          <div
            className={`${block} bg-red-500/10 ${isSchema ? 'font-mono text-xs' : ''}`}
          >
            {change.before}
          </div>
        ) : (
          <div className="text-xs text-muted-foreground">
            {baselineLabel
              ? 'Uses the server’s own text, which the run didn’t record.'
              : 'The server’s original text couldn’t be read.'}
          </div>
        )}
      </div>
      <div className="grid gap-1">
        <span className="text-xs font-semibold text-muted-foreground">
          {variantLabel}
        </span>
        <div
          className={`${block} bg-green-500/10 ${isSchema ? 'font-mono text-xs' : ''}`}
        >
          {change.after}
        </div>
      </div>
    </div>
  );
}

export function ChangeDiff({
  variantLabel,
  changes,
  baselineLabel,
}: {
  variantLabel: string;
  changes: VariantToolChange[];
  /** Set in an eval run's report, where the diff sits under "What differs". */
  baselineLabel?: string;
}) {
  return (
    <section aria-labelledby="exp-diff-h" className="grid max-w-[760px] gap-2">
      {baselineLabel ? (
        <h3 id="exp-diff-h" className="text-sm font-semibold">
          Tool metadata
        </h3>
      ) : (
        <h2 id="exp-diff-h" className="text-lg font-semibold">
          What <span className="font-mono">{variantLabel}</span> changed
        </h2>
      )}
      <div className="grid gap-4 rounded-lg border bg-card p-4 text-sm">
        {changes.length === 0 ? (
          <p className="text-muted-foreground">This variant changes nothing.</p>
        ) : (
          <>
            <p className="text-muted-foreground">
              Only {changes.length === 1 ? 'this text differs' : 'these differ'}
              . Everything else on the server is identical.
            </p>
            {changes.map((c) => (
              <div key={`${c.tool}:${c.field}`} className="grid gap-2">
                {changes.length > 1 && (
                  <h3 className="font-mono text-xs font-semibold">
                    {c.tool} · {c.field}
                  </h3>
                )}
                <OneChange
                  change={c}
                  variantLabel={variantLabel}
                  {...(baselineLabel ? { baselineLabel } : {})}
                />
                {c.before !== undefined && c.field === 'description' && (
                  <p className="text-xs text-muted-foreground">
                    {c.before.length} → {c.after.length} characters
                  </p>
                )}
              </div>
            ))}
          </>
        )}
      </div>
    </section>
  );
}
