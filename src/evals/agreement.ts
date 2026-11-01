/**
 * Agreement between judges that rated the same trials: Krippendorff's α
 * for nominal values (ADR 0009's juries). Each unit is one trial, and each
 * value one jury member's verdict; a member with no verdict on a trial is
 * missing there.
 */

/**
 * Krippendorff's α, nominal: 1 when the raters always agree, 0 when they
 * agree as often as chance would, below 0 when less. Units with fewer than
 * two values don't count. Undefined when no unit has two values, or when
 * every value is the same, so that chance agreement is total and α has no
 * meaning.
 */
export function krippendorffAlpha(
  units: ReadonlyArray<ReadonlyArray<string | undefined>>
): number | undefined {
  // The coincidence matrix: each pair of values within a unit, weighted
  // by 1 / (values in the unit - 1).
  const coincidences = new Map<string, Map<string, number>>();
  const add = (c: string, k: string, weight: number) => {
    const row = coincidences.get(c) ?? new Map<string, number>();
    row.set(k, (row.get(k) ?? 0) + weight);
    coincidences.set(c, row);
  };
  for (const unit of units) {
    const values = unit.filter((v): v is string => v !== undefined);
    if (values.length < 2) continue;
    const weight = 1 / (values.length - 1);
    for (let i = 0; i < values.length; i++)
      for (let j = 0; j < values.length; j++)
        if (i !== j) add(values[i]!, values[j]!, weight);
  }
  const totals = new Map<string, number>();
  let n = 0;
  let observed = 0;
  for (const [c, row] of coincidences)
    for (const [k, weight] of row) {
      totals.set(c, (totals.get(c) ?? 0) + weight);
      n += weight;
      if (c !== k) observed += weight;
    }
  if (n < 2) return undefined;
  let expected = 0;
  for (const [c, nc] of totals)
    for (const [k, nk] of totals) if (c !== k) expected += nc * nk;
  if (expected === 0) return undefined;
  return 1 - ((n - 1) * observed) / expected;
}
