import React, { useState } from 'react';
import type { EvalCaseResult } from '../../types';

/**
 * Strips ANSI escape codes from a string.
 *
 * Terminal applications (including Playwright) use ANSI codes for colored output,
 * but these appear as raw text like `[31m` when displayed in HTML.
 */
function stripAnsiCodes(text: string): string {
  // Match ANSI escape sequences: ESC[ followed by parameters and a command letter
  // eslint-disable-next-line no-control-regex
  return text.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '');
}

function formatResponsePreview(response: unknown): string {
  return JSON.stringify(response, null, 2);
}

interface CollapsibleSectionProps {
  title: string;
  defaultOpen?: boolean;
  children: React.ReactNode;
  badge?: React.ReactNode;
}

function CollapsibleSection({
  title,
  defaultOpen = true,
  children,
  badge,
}: CollapsibleSectionProps) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div>
      <button
        onClick={() => setOpen((o) => !o)}
        className="flex items-center gap-2 w-full text-left mb-2 group"
      >
        <svg
          className={`h-3 w-3 text-muted-foreground transition-transform ${open ? 'rotate-90' : ''}`}
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2.5}
            d="M9 5l7 7-7 7"
          />
        </svg>
        <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground group-hover:text-foreground transition-colors">
          {title}
        </h3>
        {badge}
      </button>
      {open && children}
    </div>
  );
}

interface DetailModalProps {
  result: EvalCaseResult | null;
  onClose: () => void;
}

export function DetailModal({ result, onClose }: DetailModalProps) {
  if (!result) return null;

  const responseText = formatResponsePreview(result.response);
  const isLargeResponse = responseText.length > 500;
  const hasAssertions = Object.keys(result.expectations ?? {}).length > 0;
  const hasIterations =
    result.iterationResults && result.iterationResults.length > 0;
  const displayRate = result.assertionPassRate ?? result.accuracy;
  const infraErrorRate = result.infrastructureErrorRate;

  return (
    <>
      {/* Backdrop */}
      <div
        className="fixed inset-0 bg-black/60 backdrop-blur-sm z-50"
        onClick={onClose}
      />

      {/* Modal */}
      <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
        <div
          className="bg-card rounded-lg border shadow-xl max-w-4xl w-full max-h-[90vh] overflow-hidden flex flex-col"
          onClick={(e) => e.stopPropagation()}
        >
          {/* Header */}
          <div className="flex items-center justify-between p-6 border-b bg-muted/50">
            <div className="flex items-center gap-3 flex-wrap min-w-0">
              <h2 className="text-xl font-semibold truncate">{result.id}</h2>
              {/* Pass/fail */}
              <span
                className={`inline-flex items-center gap-1 px-3 py-1 rounded-full text-sm font-semibold shrink-0 ${
                  result.pass
                    ? 'bg-green-500/20 text-green-700 dark:text-green-400'
                    : 'bg-red-500/20 text-red-700 dark:text-red-400'
                }`}
              >
                {result.pass ? '✓ Pass' : '✗ Fail'}
              </span>
              {/* Assertion pass rate badge — only for multi-iteration cases */}
              {displayRate !== undefined && (
                <span
                  className={`inline-flex items-center gap-1 px-3 py-1 rounded-full text-sm font-semibold shrink-0 ${
                    displayRate >= 0.8
                      ? 'bg-green-500/20 text-green-700 dark:text-green-400'
                      : displayRate >= 0.5
                        ? 'bg-amber-500/20 text-amber-700 dark:text-amber-400'
                        : 'bg-red-500/20 text-red-700 dark:text-red-400'
                  }`}
                >
                  {(displayRate * 100).toFixed(0)}% pass rate
                  {hasIterations && (
                    <span className="text-xs opacity-70">
                      ({result.iterationResults!.filter((r) => r.pass).length}/
                      {
                        result.iterationResults!.filter(
                          (r) => !r.isInfrastructureError
                        ).length
                      }
                      )
                    </span>
                  )}
                </span>
              )}
              {/* Infrastructure error rate badge — only when non-zero */}
              {infraErrorRate !== undefined && infraErrorRate > 0 && (
                <span className="inline-flex items-center gap-1 px-3 py-1 rounded-full text-sm font-semibold shrink-0 bg-orange-500/20 text-orange-700 dark:text-orange-400">
                  {(infraErrorRate * 100).toFixed(0)}% infra errors
                  {hasIterations && (
                    <span className="text-xs opacity-70">
                      (
                      {
                        result.iterationResults!.filter(
                          (r) => r.isInfrastructureError
                        ).length
                      }
                      /{result.iterationResults!.length})
                    </span>
                  )}
                </span>
              )}
            </div>
            <button
              onClick={onClose}
              className="p-2 rounded-md hover:bg-accent transition-colors shrink-0"
            >
              <svg
                className="h-5 w-5"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M6 18L18 6M6 6l12 12"
                />
              </svg>
            </button>
          </div>

          {/* Body */}
          <div className="flex-1 overflow-y-auto scrollbar-thin p-6 space-y-5">
            {/* Metadata badges */}
            <div className="flex flex-wrap items-center gap-2">
              <span
                className={`px-2 py-1 rounded text-xs font-medium ${
                  result.source === 'eval'
                    ? 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300'
                    : 'bg-purple-100 text-purple-700 dark:bg-purple-900/30 dark:text-purple-300'
                }`}
              >
                {result.source === 'eval' ? 'Eval Dataset' : 'Test Suite'}
              </span>
              {result.authType && (
                <span
                  className={`px-2 py-1 rounded text-xs font-medium ${
                    result.authType === 'oauth'
                      ? 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300'
                      : result.authType === 'api-token'
                        ? 'bg-indigo-100 text-indigo-700 dark:bg-indigo-900/30 dark:text-indigo-300'
                        : 'bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300'
                  }`}
                >
                  {result.authType === 'api-token'
                    ? 'API Token'
                    : result.authType === 'oauth'
                      ? 'OAuth'
                      : 'No Auth'}
                </span>
              )}
              {result.project && (
                <span className="px-2 py-1 rounded text-xs font-medium bg-cyan-100 text-cyan-700 dark:bg-cyan-900/30 dark:text-cyan-300">
                  {result.project}
                </span>
              )}
              <span className="px-2 py-1 rounded text-xs font-medium bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400">
                {result.durationMs.toFixed(0)}ms
              </span>
            </div>

            {/* Error — always show first if present */}
            {result.error && (
              <div>
                <h3 className="text-xs font-semibold uppercase tracking-wide text-destructive mb-2">
                  Error
                </h3>
                <pre className="bg-destructive/10 text-destructive p-4 rounded-md text-sm overflow-x-auto whitespace-pre-wrap">
                  {stripAnsiCodes(result.error)}
                </pre>
              </div>
            )}

            {/* Assertions — shown before response, this is what matters */}
            {hasAssertions && (
              <CollapsibleSection
                title="Assertions"
                defaultOpen={true}
                badge={
                  <span className="text-xs text-muted-foreground ml-auto">
                    {
                      Object.values(result.expectations).filter((e) => e?.pass)
                        .length
                    }
                    /{Object.values(result.expectations).filter(Boolean).length}{' '}
                    passed
                  </span>
                }
              >
                <div className="space-y-2">
                  {Object.entries(result.expectations)
                    .filter(([_, exp]) => exp !== undefined)
                    .map(([type, exp]) => (
                      <div
                        key={type}
                        className={`p-3 rounded-md border-l-4 ${
                          exp.pass
                            ? 'border-green-500 bg-green-500/10'
                            : 'border-red-500 bg-red-500/10'
                        }`}
                      >
                        <div className="flex items-center gap-2 mb-1">
                          <span
                            className={`text-sm font-semibold ${
                              exp.pass
                                ? 'text-green-700 dark:text-green-400'
                                : 'text-red-700 dark:text-red-400'
                            }`}
                          >
                            {exp.pass ? '✓' : '✗'} {type}
                          </span>
                        </div>
                        {exp.details && (
                          <pre className="text-xs text-muted-foreground font-mono whitespace-pre-wrap">
                            {stripAnsiCodes(exp.details)}
                          </pre>
                        )}
                      </div>
                    ))}
                </div>
              </CollapsibleSection>
            )}

            {/* Iterations breakdown — for multi-iteration cases */}
            {hasIterations && (
              <CollapsibleSection
                title="Iterations"
                defaultOpen={true}
                badge={
                  displayRate !== undefined ? (
                    <span className="text-xs text-muted-foreground ml-auto">
                      pass rate: {(displayRate * 100).toFixed(0)}%
                      {infraErrorRate !== undefined && infraErrorRate > 0 && (
                        <span className="ml-2 text-orange-600 dark:text-orange-400">
                          ({(infraErrorRate * 100).toFixed(0)}% infra errors)
                        </span>
                      )}
                    </span>
                  ) : undefined
                }
              >
                <div className="overflow-x-auto">
                  <table className="w-full text-sm border-collapse">
                    <thead>
                      <tr className="border-b text-xs text-muted-foreground">
                        <th className="text-left py-2 pr-4 font-medium">#</th>
                        <th className="text-left py-2 pr-4 font-medium">
                          Result
                        </th>
                        <th className="text-left py-2 pr-4 font-medium">
                          Duration
                        </th>
                        <th className="text-left py-2 font-medium">Error</th>
                      </tr>
                    </thead>
                    <tbody>
                      {result.iterationResults!.map((iter, i) => (
                        <tr
                          key={i}
                          className="border-b border-border/50 last:border-0"
                        >
                          <td className="py-2 pr-4 text-muted-foreground">
                            {i + 1}
                          </td>
                          <td className="py-2 pr-4">
                            <span
                              className={`font-semibold ${
                                iter.pass
                                  ? 'text-green-600 dark:text-green-400'
                                  : 'text-red-600 dark:text-red-400'
                              }`}
                            >
                              {iter.pass ? '✓ pass' : '✗ fail'}
                            </span>
                          </td>
                          <td className="py-2 pr-4 text-muted-foreground">
                            {iter.durationMs.toFixed(0)}ms
                          </td>
                          <td className="py-2 text-xs text-muted-foreground font-mono">
                            {iter.error ? stripAnsiCodes(iter.error) : '—'}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </CollapsibleSection>
            )}

            {/* Response — collapsible, collapsed by default when large */}
            <CollapsibleSection
              title="Raw Response"
              defaultOpen={!isLargeResponse}
              badge={
                isLargeResponse ? (
                  <span className="text-xs text-muted-foreground ml-2">
                    {(responseText.length / 1024).toFixed(1)}KB
                  </span>
                ) : undefined
              }
            >
              <div className="max-h-64 overflow-y-auto rounded-md bg-muted">
                <pre className="p-4 text-xs font-mono overflow-x-auto">
                  {responseText}
                </pre>
              </div>
            </CollapsibleSection>
          </div>
        </div>
      </div>
    </>
  );
}
