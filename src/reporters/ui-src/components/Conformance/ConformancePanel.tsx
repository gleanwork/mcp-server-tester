import React from 'react';
import {
  ShieldCheck,
  ShieldX,
  CheckCircle2,
  XCircle,
  AlertTriangle,
  MinusCircle,
} from 'lucide-react';
import type {
  MCPConformanceCheck,
  MCPConformanceResultData,
} from '../../types';

interface ConformancePanelProps {
  conformanceChecks: MCPConformanceResultData[];
  isExpanded: boolean;
}

type CheckStatus = 'pass' | 'fail' | 'warning' | 'skipped';

function statusOf(check: MCPConformanceCheck): CheckStatus {
  if (check.skipped) return 'skipped';
  if (check.pass) return 'pass';
  return (check.severity ?? 'must') === 'should' ? 'warning' : 'fail';
}

/** Worst status first, so a group reports its most severe occurrence. */
const STATUS_RANK: Record<CheckStatus, number> = {
  fail: 0,
  warning: 1,
  pass: 2,
  skipped: 3,
};

interface ProtocolGroup {
  label: string;
  checks: Array<MCPConformanceCheck & { status: CheckStatus }>;
}

/**
 * Groups results by negotiated protocol, then aggregates each check name
 * within a group: the group shows the worst status any occurrence had.
 * Grouping by protocol keeps a check that fails on one era from being hidden
 * by passes on another.
 */
function groupByProtocol(results: MCPConformanceResultData[]): ProtocolGroup[] {
  const byProtocol = new Map<string, MCPConformanceCheck[]>();
  for (const result of results) {
    const protocol = result.protocol;
    const label =
      result.scope ??
      (protocol?.negotiated
        ? `Protocol ${protocol.negotiated}${protocol.era ? ` · ${protocol.era}` : ''}`
        : 'protocol unknown');
    const existing = byProtocol.get(label) ?? [];
    existing.push(...(result.checks ?? []));
    byProtocol.set(label, existing);
  }

  return [...byProtocol.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([label, checks]) => {
      const byName = new Map<string, MCPConformanceCheck[]>();
      for (const check of checks) {
        const group = byName.get(check.name) ?? [];
        group.push(check);
        byName.set(check.name, group);
      }
      const aggregated = [...byName.values()].map((group) => {
        const ranked = group
          .map((check) => ({ ...check, status: statusOf(check) }))
          .sort((a, b) => STATUS_RANK[a.status] - STATUS_RANK[b.status]);
        return ranked[0]!;
      });
      return { label, checks: aggregated };
    });
}

function StatusIcon({ status }: { status: CheckStatus }) {
  const className = 'w-4 h-4 mt-0.5 flex-shrink-0';
  switch (status) {
    case 'pass':
      return (
        <CheckCircle2
          className={`${className} text-green-600 dark:text-green-400`}
        />
      );
    case 'warning':
      return (
        <AlertTriangle
          className={`${className} text-amber-600 dark:text-amber-400`}
        />
      );
    case 'skipped':
      return <MinusCircle className={`${className} text-muted-foreground`} />;
    default:
      return (
        <XCircle className={`${className} text-red-600 dark:text-red-400`} />
      );
  }
}

export function ConformancePanel({
  conformanceChecks,
  isExpanded,
}: ConformancePanelProps) {
  if (!conformanceChecks || conformanceChecks.length === 0) {
    return null;
  }

  const groups = groupByProtocol(conformanceChecks);
  const all = groups.flatMap((group) => group.checks);
  const count = (status: CheckStatus) =>
    all.filter((check) => check.status === status).length;
  const failed = count('fail');
  const warnings = count('warning');
  const skipped = count('skipped');
  const ran = all.length - skipped;
  const allPassed = failed === 0;
  const serverInfo = conformanceChecks[0]?.serverInfo;

  return (
    <div className="rounded-lg border bg-card shadow-sm overflow-hidden">
      <div
        className={`px-4 py-3 border-b ${
          allPassed
            ? 'bg-green-500/10 border-green-500/20'
            : 'bg-amber-500/10 border-amber-500/20'
        }`}
      >
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            {allPassed ? (
              <ShieldCheck className="w-5 h-5 text-green-600 dark:text-green-400" />
            ) : (
              <ShieldX className="w-5 h-5 text-amber-600 dark:text-amber-400" />
            )}
            <h3 className="font-semibold">MCP Conformance Checks</h3>
            {serverInfo && (
              <span className="text-sm text-muted-foreground">
                ({serverInfo.name}
                {serverInfo.version && ` v${serverInfo.version}`})
              </span>
            )}
          </div>
          <span
            className={`text-sm font-medium ${
              allPassed
                ? 'text-green-600 dark:text-green-400'
                : 'text-amber-600 dark:text-amber-400'
            }`}
          >
            {ran - failed - warnings}/{ran} passed
            {warnings > 0 &&
              ` · ${warnings} warning${warnings === 1 ? '' : 's'}`}
            {skipped > 0 ? ` · ${skipped} skipped` : null}
          </span>
        </div>
      </div>

      {isExpanded && (
        <div className="max-h-96 overflow-y-auto">
          {groups.map((group) => (
            <div key={group.label}>
              {groups.length > 1 || group.label !== 'protocol unknown' ? (
                <div className="px-4 py-1.5 bg-muted/40 text-xs font-medium text-muted-foreground uppercase tracking-wide">
                  {group.label}
                </div>
              ) : null}
              <div className="divide-y divide-border">
                {group.checks.map((check) => (
                  <div
                    key={`${group.label}:${check.name}`}
                    className="px-4 py-3 hover:bg-muted/30 transition-colors"
                  >
                    <div className="flex items-start gap-3">
                      <StatusIcon status={check.status} />
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2">
                          <code
                            className={`text-sm font-semibold font-mono ${
                              check.status === 'fail'
                                ? 'text-red-700 dark:text-red-300'
                                : 'text-foreground'
                            }`}
                          >
                            {check.name}
                          </code>
                          {check.severity === 'should' ? (
                            <span className="text-xs text-muted-foreground">
                              SHOULD
                            </span>
                          ) : null}
                          {check.specRef ? (
                            <a
                              href={check.specRef}
                              target="_blank"
                              rel="noreferrer"
                              className="text-xs text-muted-foreground underline"
                            >
                              spec
                            </a>
                          ) : null}
                        </div>
                        <p className="text-sm text-muted-foreground mt-1">
                          {check.message}
                        </p>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
