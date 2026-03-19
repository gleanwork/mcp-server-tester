import React, { useEffect, useRef } from 'react';
import { X } from 'lucide-react';
import type { EvalCaseResult } from '../../types';
import { CollapsibleSection } from '../CollapsibleSection';

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

interface DetailModalProps {
  result: EvalCaseResult | null;
  onClose: () => void;
}

export function DetailModal({ result, onClose }: DetailModalProps) {
  const modalRef = useRef<HTMLDivElement>(null);
  const previousFocusRef = useRef<Element | null>(null);

  useEffect(() => {
    if (!result) return;

    previousFocusRef.current = document.activeElement;
    modalRef.current?.focus();

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        onClose();
        return;
      }

      if (event.key === 'Tab') {
        const modal = modalRef.current;
        if (!modal) return;

        const focusable = modal.querySelectorAll<HTMLElement>(
          'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
        );
        const focusableArray = Array.from(focusable);
        if (focusableArray.length === 0) return;

        const first = focusableArray[0];
        const last = focusableArray[focusableArray.length - 1];

        if (event.shiftKey) {
          if (document.activeElement === first) {
            event.preventDefault();
            last.focus();
          }
        } else {
          if (document.activeElement === last) {
            event.preventDefault();
            first.focus();
          }
        }
      }
    }

    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('keydown', handleKeyDown);
      const prev = previousFocusRef.current;
      if (prev instanceof HTMLElement) {
        prev.focus();
      }
    };
  }, [result, onClose]);

  if (!result) return null;

  const responseText = formatResponsePreview(result.response);
  const isLargeResponse = responseText.length > 500;
  const hasAssertions = Object.keys(result.expectations ?? {}).length > 0;
  const hasIterations =
    result.iterationResults && result.iterationResults.length > 0;
  const iterations = result.iterationResults!;
  const displayRate = result.assertionPassRate;
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
          ref={modalRef}
          role="dialog"
          aria-modal="true"
          aria-labelledby="detail-modal-title"
          tabIndex={-1}
          className="bg-card rounded-lg border shadow-xl max-w-4xl w-full max-h-[90vh] overflow-hidden flex flex-col outline-none"
          onClick={(e) => e.stopPropagation()}
        >
          {/* Header */}
          <div className="flex items-center justify-between p-6 border-b bg-muted/50">
            <div className="flex items-center gap-3 flex-wrap min-w-0">
              <h2
                id="detail-modal-title"
                className="text-xl font-semibold truncate"
              >
                {result.id}
              </h2>
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
              {/* Baseline comparison note */}
              {result.baselinePass === true && !result.pass && (
                <span className="inline-flex items-center gap-1 px-3 py-1 rounded-full text-sm font-semibold shrink-0 bg-red-500/20 text-red-700 dark:text-red-400">
                  ▼ Regressed since baseline
                </span>
              )}
              {result.baselinePass === false && result.pass && (
                <span className="inline-flex items-center gap-1 px-3 py-1 rounded-full text-sm font-semibold shrink-0 bg-green-500/20 text-green-700 dark:text-green-400">
                  ▲ Fixed since baseline
                </span>
              )}
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
                  title={
                    result.assertionPassRateCI
                      ? `95% confidence interval: the true pass rate is likely between ${(result.assertionPassRateCI.lower * 100).toFixed(0)}% and ${(result.assertionPassRateCI.upper * 100).toFixed(0)}%. Run more iterations to narrow this range.`
                      : undefined
                  }
                >
                  {(displayRate * 100).toFixed(0)}% pass rate
                  {result.assertionPassRateCI && (
                    <span className="text-xs opacity-70 font-normal">
                      {` ±${Math.round(((result.assertionPassRateCI.upper - result.assertionPassRateCI.lower) / 2) * 100)}%`}
                    </span>
                  )}
                  {hasIterations && (
                    <span className="text-xs opacity-70">
                      ({iterations.filter((r) => r.pass).length}/
                      {
                        iterations.filter((r) => !r.isInfrastructureError)
                          .length
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
                      {iterations.filter((r) => r.isInfrastructureError).length}
                      /{iterations.length})
                    </span>
                  )}
                </span>
              )}
            </div>
            <button
              onClick={onClose}
              aria-label="Close"
              className="p-2 rounded-md hover:bg-accent transition-colors shrink-0"
            >
              <X aria-hidden="true" className="w-4 h-4" />
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
              {result.toolPrecision !== undefined && (
                <span className="px-2 py-1 rounded text-xs font-medium bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400">
                  Precision: {(result.toolPrecision * 100).toFixed(0)}%
                </span>
              )}
              {result.toolRecall !== undefined && (
                <span className="px-2 py-1 rounded text-xs font-medium bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400">
                  Recall: {(result.toolRecall * 100).toFixed(0)}%
                </span>
              )}
            </div>

            {/* Request — show what was sent */}
            {result.request &&
              (result.request.args ||
                result.request.scenario ||
                result.request.description) && (
                <CollapsibleSection title="Request" defaultOpen={true}>
                  <div className="space-y-3">
                    {result.request.description && (
                      <p className="text-sm text-muted-foreground">
                        {result.request.description}
                      </p>
                    )}
                    {result.request.scenario && (
                      <div>
                        <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-1">
                          Scenario
                        </h4>
                        <p className="text-sm bg-muted p-3 rounded-md">
                          {result.request.scenario}
                        </p>
                      </div>
                    )}
                    {result.request.mcpHostConfig && (
                      <div className="flex gap-2">
                        <span className="px-2 py-1 rounded text-xs font-medium bg-violet-100 text-violet-700 dark:bg-violet-900/30 dark:text-violet-300">
                          {result.request.mcpHostConfig.provider}
                        </span>
                        {result.request.mcpHostConfig.model && (
                          <span className="px-2 py-1 rounded text-xs font-medium bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400">
                            {result.request.mcpHostConfig.model}
                          </span>
                        )}
                      </div>
                    )}
                    {result.request.args && (
                      <div>
                        <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-1">
                          Arguments
                        </h4>
                        <pre className="text-xs font-mono bg-muted p-3 rounded-md overflow-x-auto">
                          {JSON.stringify(result.request.args, null, 2)}
                        </pre>
                      </div>
                    )}
                  </div>
                </CollapsibleSection>
              )}

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

            {/* Tool Calls — for llm_host eval cases with tool call expectations */}
            {result.source === 'eval' && result.toolPrecision !== undefined && (
              <CollapsibleSection title="Tool Calls" defaultOpen={true}>
                {result.mcpHostTrace ? (
                  <div className="space-y-1">
                    {result.mcpHostTrace.calls.map((call, i) => (
                      <div
                        key={i}
                        className={`flex items-start gap-2 text-xs p-2 rounded ${
                          call.status === 'expected'
                            ? 'bg-green-50 dark:bg-green-950'
                            : 'bg-red-50 dark:bg-red-950'
                        }`}
                      >
                        <span
                          className={
                            call.status === 'expected'
                              ? 'text-green-600'
                              : 'text-red-600'
                          }
                        >
                          {call.status === 'expected' ? '✓' : '✗'}
                        </span>
                        <span className="font-mono font-medium">
                          {call.name}
                        </span>
                        <span className="text-muted-foreground truncate">
                          {JSON.stringify(call.arguments).substring(0, 80)}
                        </span>
                      </div>
                    ))}
                    {result.mcpHostTrace.missed.map((missed, i) => (
                      <div
                        key={`missed-${i}`}
                        className="flex items-center gap-2 text-xs p-2 rounded bg-yellow-50 dark:bg-yellow-950"
                      >
                        <span className="text-yellow-600">○</span>
                        <span className="font-mono font-medium text-muted-foreground line-through">
                          {missed.name}
                        </span>
                        <span className="text-muted-foreground">
                          not called
                        </span>
                      </div>
                    ))}
                  </div>
                ) : (
                  <p className="text-xs text-muted-foreground">
                    Precision: {(result.toolPrecision * 100).toFixed(0)}% ·
                    Recall:{' '}
                    {result.toolRecall !== undefined
                      ? `${(result.toolRecall * 100).toFixed(0)}%`
                      : 'N/A'}
                  </p>
                )}
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
                        {iterations.some((r) => r.mcpHostTrace) && (
                          <th className="text-left py-2 pr-4 font-medium">
                            Tools called
                          </th>
                        )}
                        <th className="text-left py-2 font-medium">Error</th>
                      </tr>
                    </thead>
                    <tbody>
                      {iterations.map((iter, i) => (
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
                                iter.isInfrastructureError
                                  ? 'text-orange-600 dark:text-orange-400'
                                  : iter.pass
                                    ? 'text-green-600 dark:text-green-400'
                                    : 'text-red-600 dark:text-red-400'
                              }`}
                            >
                              {iter.isInfrastructureError
                                ? '⚠ infra'
                                : iter.pass
                                  ? '✓ pass'
                                  : '✗ fail'}
                            </span>
                          </td>
                          <td className="py-2 pr-4 text-muted-foreground">
                            {iter.durationMs.toFixed(0)}ms
                          </td>
                          {iterations.some((r) => r.mcpHostTrace) && (
                            <td className="py-2 pr-4">
                              {iter.mcpHostTrace ? (
                                <span className="flex flex-wrap gap-1 items-center">
                                  {iter.mcpHostTrace.calls.map((c, j) => (
                                    <code
                                      key={j}
                                      className={`text-xs px-1.5 py-0.5 rounded ${
                                        c.status === 'expected'
                                          ? 'bg-green-500/15 text-green-700 dark:text-green-400'
                                          : 'bg-red-500/15 text-red-700 dark:text-red-400'
                                      }`}
                                      title={
                                        c.status === 'unexpected'
                                          ? 'Unexpected tool call'
                                          : 'Expected tool call'
                                      }
                                    >
                                      {c.name}
                                    </code>
                                  ))}
                                  {iter.mcpHostTrace.missed.map((m, j) => (
                                    <code
                                      key={`missed-${j}`}
                                      className="text-xs px-1.5 py-0.5 rounded bg-muted text-muted-foreground line-through"
                                      title="Required tool was never called"
                                    >
                                      {m.name}
                                    </code>
                                  ))}
                                  {iter.mcpHostTrace.calls.length === 0 &&
                                    iter.mcpHostTrace.missed.length === 0 && (
                                      <span className="text-xs text-muted-foreground">
                                        no tools called
                                      </span>
                                    )}
                                </span>
                              ) : (
                                <span className="text-xs text-muted-foreground">
                                  —
                                </span>
                              )}
                            </td>
                          )}
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
            {result.response === null ? (
              <CollapsibleSection
                title="Raw Response"
                defaultOpen={!isLargeResponse}
              >
                <p className="text-xs text-muted-foreground p-4">
                  No response — tool call failed
                </p>
              </CollapsibleSection>
            ) : (
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
            )}
          </div>
        </div>
      </div>
    </>
  );
}
