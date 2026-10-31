import type { RunReportJudgeCalibration, RunReportVariant } from '../../types';
import { TONE, pct, type Tone } from '../Comparison/format';

const STATUS: Record<
  RunReportJudgeCalibration['status'],
  { label: string; tone: Tone }
> = {
  calibrated: { label: 'Calibrated', tone: 'good' },
  'not-usable': { label: 'Not usable', tone: 'bad' },
  stale: { label: 'Stale', tone: 'warn' },
  uncalibrated: { label: 'Not calibrated', tone: 'neutral' },
  mixed: { label: 'Mixed versions', tone: 'warn' },
};

/** Why a judge's status is what it is, in one sentence. */
function statusTitle(row: RunReportJudgeCalibration): string {
  const c = row.calibration;
  switch (row.status) {
    case 'calibrated':
      return `Checked against ${c?.labels ?? 0} test labels on ${c?.createdAt.slice(0, 10) ?? '?'}: TPR ${c?.tpr === null || c?.tpr === undefined ? 'n/a' : pct(c.tpr)}, TNR ${c?.tnr === null || c?.tnr === undefined ? 'n/a' : pct(c.tnr)}.`;
    case 'not-usable':
      return `This judge failed its check: ${c?.reasons.join('; ') ?? ''}.`;
    case 'stale':
      return `The judge changed since it was checked on ${c?.createdAt.slice(0, 10) ?? '?'}. Run mst judges check on labels for this run.`;
    case 'mixed':
      return 'More than one version of this judge graded this variant, so no calibration applies.';
    case 'uncalibrated':
      return 'No check of this judge against labels. Label its verdicts (mst label) and run mst judges check.';
  }
}

/**
 * Each pointwise judge's pass rate per variant, its calibration, and the
 * pass rate corrected for its errors when a usable calibration applies
 * (ADR 0009). The raw rate is always shown.
 */
export function JudgeCalibration({
  variants,
}: {
  variants: RunReportVariant[];
}) {
  const rows = variants.flatMap((variant) =>
    (variant.judgeCalibration ?? []).map((judge) => ({ variant, judge }))
  );
  if (rows.length === 0) return null;
  const single = variants.length === 1;
  const th = 'px-3 py-2 text-left align-bottom font-semibold';
  const thNum = `${th} text-right`;
  const td = 'px-3 py-2 align-middle';
  const tdNum = `${td} text-right font-mono`;
  const unversioned = rows.some(({ judge }) => judge.unversioned);
  return (
    <section aria-labelledby="run-judges-h" className="grid gap-2">
      <h2 id="run-judges-h" className="text-lg font-semibold">
        Judges
      </h2>
      <p className="text-sm text-muted-foreground">
        A judge&apos;s pass rate is the share of trials it passed, leaving out
        the ones it couldn&apos;t decide. With a usable calibration, the
        corrected rate estimates the share people would pass.
      </p>
      <div className="overflow-x-auto rounded-lg border bg-card">
        <table className="w-full text-sm">
          <thead className="bg-muted/50 text-muted-foreground">
            <tr>
              <th scope="col" className={th}>
                Judge
              </th>
              {!single && (
                <th scope="col" className={th}>
                  Variant
                </th>
              )}
              <th scope="col" className={thNum}>
                Pass rate
              </th>
              <th scope="col" className={thNum}>
                Corrected
              </th>
              <th scope="col" className={thNum}>
                Unknown
              </th>
              <th scope="col" className={th}>
                Calibration
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map(({ variant, judge }) => {
              const status = STATUS[judge.status];
              return (
                <tr
                  key={`${variant.id}\u0000${judge.judge}`}
                  className="border-t"
                >
                  <th
                    scope="row"
                    className={`${td} text-left font-mono font-normal`}
                  >
                    {judge.judge}
                  </th>
                  {!single && (
                    <td className={`${td} font-mono`}>{variant.name}</td>
                  )}
                  <td className={tdNum}>
                    {judge.passRate === undefined ? (
                      '—'
                    ) : (
                      <span title={`${judge.passed} of ${judge.judged}`}>
                        {pct(judge.passRate)}
                      </span>
                    )}
                  </td>
                  <td className={tdNum}>
                    {judge.corrected ? (
                      <span
                        title={`95% interval, from this run's trials and the calibration's labels`}
                      >
                        {pct(judge.corrected.value)}{' '}
                        <span className="text-xs text-muted-foreground">
                          {pct(judge.corrected.low)}–{pct(judge.corrected.high)}
                        </span>
                      </span>
                    ) : (
                      <span className="text-muted-foreground">—</span>
                    )}
                  </td>
                  <td className={tdNum}>{judge.unknown}</td>
                  <td className={td}>
                    <span
                      title={statusTitle(judge)}
                      className={`w-fit whitespace-nowrap rounded-full px-2 py-px text-xs font-semibold ${TONE[status.tone]}`}
                    >
                      {status.label}
                      {judge.unversioned ? ' · unversioned' : ''}
                    </span>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {unversioned && (
        <p className="text-sm text-muted-foreground">
          An unversioned judge declares no version, and neither does its plugin,
          so the report can&apos;t tell when its calibration goes stale. Set the
          judge&apos;s <code>version</code>.
        </p>
      )}
    </section>
  );
}
