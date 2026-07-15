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
  return JSON.stringify(response, null, 2) ?? '';
}

function getExternalHostEvidenceRows(
  externalHost: NonNullable<EvalCaseResult['externalHost']>
) {
  const labels = {
    finalAnswer: 'Final answer',
    toolCalls: 'Tool calls',
    usage: 'Usage',
    cost: 'Cost',
  } as const;
  const keys = Object.keys(labels) as Array<keyof typeof labels>;

  return keys
    .map((key) => {
      const evidence = externalHost.evidence?.[key];
      const source = evidence?.source ?? externalHost.sources?.[key];
      const confidence = evidence?.confidence;

      if (!source && !confidence) {
        return undefined;
      }

      return {
        key,
        label: labels[key],
        source: source ?? 'unknown',
        confidence: confidence ?? externalHost.traceConfidence,
      };
    })
    .filter((row): row is NonNullable<typeof row> => row !== undefined);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function responseRecord(result: EvalCaseResult): Record<string, unknown> {
  return isRecord(result.response) ? result.response : {};
}

function resultToolCalls(
  result: EvalCaseResult
): Array<{ id?: string; name: string; arguments: Record<string, unknown> }> {
  const toolCalls = responseRecord(result).toolCalls;
  if (!Array.isArray(toolCalls)) {
    return [];
  }

  return toolCalls.filter(
    (
      call
    ): call is {
      id?: string;
      name: string;
      arguments: Record<string, unknown>;
    } =>
      isRecord(call) &&
      typeof call.name === 'string' &&
      isRecord(call.arguments)
  );
}

function finalAnswer(result: EvalCaseResult): string | undefined {
  const response = responseRecord(result).response;
  return typeof response === 'string' ? response : undefined;
}

function usageForResult(
  result: EvalCaseResult
): Record<string, unknown> | undefined {
  const responseUsage = responseRecord(result).usage;
  return (
    (result.hostUsage as unknown as Record<string, unknown> | undefined) ??
    (isRecord(responseUsage) ? responseUsage : undefined)
  );
}

function numberField(
  value: Record<string, unknown> | undefined,
  key: string
): number | undefined {
  const nested = value?.[key];
  return typeof nested === 'number' ? nested : undefined;
}

function formatNumber(value: number | undefined): string {
  return value === undefined ? 'unknown' : value.toLocaleString();
}

function formatCost(value: number | undefined): string {
  if (value === undefined) {
    return 'unknown';
  }
  return `$${value.toFixed(value === 0 ? 2 : 4)}`;
}

function formatMs(value: number | undefined): string {
  if (value === undefined) {
    return 'unknown';
  }
  return value >= 1000
    ? `${(value / 1000).toFixed(1)}s`
    : `${value.toFixed(0)}ms`;
}

function jsonPreview(value: unknown): string {
  return JSON.stringify(value, null, 2) ?? '';
}

function InfoField({
  label,
  value,
}: {
  label: string;
  value: React.ReactNode;
}) {
  return (
    <div>
      <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-1">
        {label}
      </h4>
      <div className="text-sm break-words">{value}</div>
    </div>
  );
}

function JsonBlock({ value }: { value: unknown }) {
  return (
    <pre className="text-xs font-mono bg-muted p-3 rounded-md overflow-x-auto whitespace-pre-wrap">
      {jsonPreview(value)}
    </pre>
  );
}

function expectationEntries(result: EvalCaseResult) {
  return Object.entries(result.expectations ?? {}).filter(
    (entry): entry is [string, NonNullable<(typeof entry)[1]>] =>
      entry[1] !== undefined
  );
}

function failedExpectationEntries(result: EvalCaseResult) {
  return expectationEntries(result).filter(([, expectation]) => {
    return !expectation.pass;
  });
}

function getVerdictSummary(result: EvalCaseResult): {
  category: string;
  reason: string;
} {
  const failedAssertions = failedExpectationEntries(result).map(
    ([type]) => type
  );

  if (result.pass) {
    return {
      category: 'Pass',
      reason: 'All configured assertions passed.',
    };
  }

  if (result.externalHost?.failureKind) {
    return {
      category: 'Host or automation failure',
      reason: `The driver failed before producing trustworthy eval evidence: ${result.externalHost.failureKind}.`,
    };
  }

  if (result.error) {
    const firstLine = stripAnsiCodes(result.error).split('\n')[0];
    return {
      category: 'Execution failure',
      reason: firstLine,
    };
  }

  if (failedAssertions.length > 0) {
    return {
      category: 'Assertion failure',
      reason: `${failedAssertions.length} configured assertion${failedAssertions.length === 1 ? '' : 's'} failed: ${failedAssertions.join(', ')}.`,
    };
  }

  return {
    category: 'Failure',
    reason:
      'The run failed without a specific assertion or host-driver error in the report.',
  };
}

function evidenceSummary(
  externalHost: NonNullable<EvalCaseResult['externalHost']> | undefined,
  key: 'finalAnswer' | 'toolCalls' | 'usage' | 'cost'
): string {
  if (!externalHost) {
    return 'not reported';
  }
  const evidence = externalHost.evidence?.[key];
  const source = evidence?.source ?? externalHost.sources?.[key];
  const confidence = evidence?.confidence ?? externalHost.traceConfidence;

  if (!source) {
    return 'not reported';
  }
  return `${source} · ${confidence}`;
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
  const expectationRows = expectationEntries(result);
  const failedExpectationRows = failedExpectationEntries(result);
  const hasAssertions = expectationRows.length > 0;
  const hasIterations =
    result.iterationResults && result.iterationResults.length > 0;
  const iterations = result.iterationResults!;
  const displayRate = result.assertionPassRate;
  const infraErrorRate = result.infrastructureErrorRate;
  const externalHostEvidenceRows = result.externalHost
    ? getExternalHostEvidenceRows(result.externalHost)
    : [];
  const hostToolCalls = resultToolCalls(result);
  const hostUsage = usageForResult(result);
  const answer = finalAnswer(result);
  const llmDurationMs = numberField(responseRecord(result), 'llmDurationMs');
  const mcpDurationMs = numberField(responseRecord(result), 'mcpDurationMs');
  const externalHostConfig = result.request?.externalHost;
  const verdict = getVerdictSummary(result);

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
              {result.externalHost && (
                <>
                  <span className="px-2 py-1 rounded text-xs font-medium bg-teal-100 text-teal-700 dark:bg-teal-900/30 dark:text-teal-300">
                    {result.externalHost.hostName}
                  </span>
                  <span
                    className={`px-2 py-1 rounded text-xs font-medium ${
                      result.externalHost.traceConfidence === 'high'
                        ? 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-300'
                        : result.externalHost.traceConfidence === 'medium'
                          ? 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300'
                          : 'bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300'
                    }`}
                  >
                    {result.externalHost.traceConfidence} trace
                  </span>
                </>
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

            <CollapsibleSection title="Verdict" defaultOpen={true}>
              <div className="space-y-4">
                <div
                  className={`rounded-md border p-4 ${
                    result.pass
                      ? 'border-green-500/30 bg-green-500/10'
                      : result.externalHost?.failureKind || result.error
                        ? 'border-orange-500/30 bg-orange-500/10'
                        : 'border-red-500/30 bg-red-500/10'
                  }`}
                >
                  <div className="flex flex-wrap items-center gap-2 mb-2">
                    <span className="text-sm font-semibold">
                      {verdict.category}
                    </span>
                    {failedExpectationRows.length > 0 && (
                      <span className="text-xs text-muted-foreground">
                        {failedExpectationRows.length} failed assertion
                        {failedExpectationRows.length === 1 ? '' : 's'}
                      </span>
                    )}
                  </div>
                  <p className="text-sm text-muted-foreground">
                    {verdict.reason}
                  </p>
                </div>

                {result.externalHost && (
                  <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 text-sm">
                    <InfoField
                      label="Driver"
                      value={
                        <>
                          <span className="font-medium">
                            {result.externalHost.displayName}
                          </span>
                          <p className="font-mono text-xs text-muted-foreground break-all mt-1">
                            {result.externalHost.driverSlug}
                          </p>
                        </>
                      }
                    />
                    <InfoField
                      label="Trace"
                      value={`${result.externalHost.traceSource} · ${result.externalHost.traceConfidence}`}
                    />
                    <InfoField
                      label="Correlation"
                      value={
                        result.externalHost.correlation.includedInPrompt
                          ? `${result.externalHost.correlation.strategy} in prompt`
                          : result.externalHost.correlation.strategy
                      }
                    />
                    <InfoField
                      label="Final Answer Source"
                      value={evidenceSummary(
                        result.externalHost,
                        'finalAnswer'
                      )}
                    />
                    <InfoField
                      label="Tool Evidence"
                      value={evidenceSummary(result.externalHost, 'toolCalls')}
                    />
                    <InfoField
                      label="Usage Evidence"
                      value={evidenceSummary(result.externalHost, 'usage')}
                    />
                  </div>
                )}
              </div>
            </CollapsibleSection>

            {/* Setup and configuration — show what the eval was configured to run */}
            {result.request &&
              (result.request.args ||
                result.request.scenario ||
                result.request.externalHost ||
                result.request.description ||
                result.request.expect) && (
                <CollapsibleSection
                  title="Setup & Configuration"
                  defaultOpen={false}
                >
                  <div className="space-y-4">
                    {result.request.description && (
                      <p className="text-sm text-muted-foreground">
                        {result.request.description}
                      </p>
                    )}

                    <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                      <InfoField
                        label="Mode"
                        value={
                          <code className="text-xs bg-muted px-2 py-1 rounded">
                            {result.request.mode ?? result.toolName}
                          </code>
                        }
                      />
                      <InfoField
                        label="Dataset"
                        value={
                          <span className="font-medium">
                            {result.datasetName}
                          </span>
                        }
                      />
                      <InfoField
                        label="Iterations"
                        value={
                          result.request.iterations ??
                          result.iterationResults?.length ??
                          1
                        }
                      />
                      {result.request.accuracyThreshold !== undefined && (
                        <InfoField
                          label="Accuracy Threshold"
                          value={`${(result.request.accuracyThreshold * 100).toFixed(0)}%`}
                        />
                      )}
                      {result.request.judgeReps !== undefined && (
                        <InfoField
                          label="Judge Reps"
                          value={result.request.judgeReps}
                        />
                      )}
                      {result.request.tags &&
                        result.request.tags.length > 0 && (
                          <InfoField
                            label="Tags"
                            value={
                              <div className="flex flex-wrap gap-1">
                                {result.request.tags.map((tag) => (
                                  <span
                                    key={tag}
                                    className="px-2 py-1 rounded text-xs bg-muted text-muted-foreground"
                                  >
                                    {tag}
                                  </span>
                                ))}
                              </div>
                            }
                          />
                        )}
                    </div>

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

                    {externalHostConfig && (
                      <div className="space-y-3">
                        <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                          External Host Driver
                        </h4>
                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                          <InfoField
                            label="Driver Slug"
                            value={
                              <code className="text-xs break-all">
                                {externalHostConfig.driverSlug ??
                                  (typeof externalHostConfig.driver === 'string'
                                    ? externalHostConfig.driver
                                    : 'external host')}
                              </code>
                            }
                          />
                          <InfoField
                            label="Display Name"
                            value={
                              externalHostConfig.name ??
                              result.externalHost?.displayName ??
                              'external host'
                            }
                          />
                          {typeof externalHostConfig.driver === 'object' && (
                            <>
                              <InfoField
                                label="Provider / Product"
                                value={`${externalHostConfig.driver.provider} / ${externalHostConfig.driver.product}`}
                              />
                              <InfoField
                                label="Surface / Runtime"
                                value={`${externalHostConfig.driver.surface} / ${externalHostConfig.driver.runtime}`}
                              />
                              {externalHostConfig.driver.platform && (
                                <InfoField
                                  label="Platform"
                                  value={externalHostConfig.driver.platform}
                                />
                              )}
                              {externalHostConfig.driver.channel && (
                                <InfoField
                                  label="Channel"
                                  value={externalHostConfig.driver.channel}
                                />
                              )}
                            </>
                          )}
                          {externalHostConfig.hostType && (
                            <InfoField
                              label="Host Type"
                              value={externalHostConfig.hostType}
                            />
                          )}
                          {externalHostConfig.variant && (
                            <InfoField
                              label="Variant"
                              value={externalHostConfig.variant}
                            />
                          )}
                          {externalHostConfig.timeoutMs !== undefined && (
                            <InfoField
                              label="Timeout"
                              value={formatMs(externalHostConfig.timeoutMs)}
                            />
                          )}
                          {externalHostConfig.usesBuiltInDefaults !==
                            undefined && (
                            <InfoField
                              label="Built-in Defaults"
                              value={
                                externalHostConfig.usesBuiltInDefaults
                                  ? 'applied'
                                  : 'not applied'
                              }
                            />
                          )}
                          {externalHostConfig.correlation && (
                            <InfoField
                              label="Correlation"
                              value={
                                <div className="space-y-1">
                                  <code className="text-xs">
                                    {externalHostConfig.correlation.strategy ??
                                      'none'}
                                  </code>
                                  {externalHostConfig.correlation
                                    .includeInPrompt !== undefined && (
                                    <p className="text-xs text-muted-foreground">
                                      prompt marker:{' '}
                                      {externalHostConfig.correlation
                                        .includeInPrompt
                                        ? 'included'
                                        : 'not included'}
                                    </p>
                                  )}
                                  {externalHostConfig.correlation
                                    .promptTemplate && (
                                    <p className="text-xs text-muted-foreground break-all">
                                      template:{' '}
                                      {
                                        externalHostConfig.correlation
                                          .promptTemplate
                                      }
                                    </p>
                                  )}
                                </div>
                              }
                            />
                          )}
                        </div>

                        {externalHostConfig.capabilities &&
                          Object.keys(externalHostConfig.capabilities).length >
                            0 && (
                            <div>
                              <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-2">
                                Capability Bindings
                              </h4>
                              <div className="overflow-x-auto rounded-md border">
                                <table className="w-full text-xs">
                                  <thead className="bg-muted text-muted-foreground">
                                    <tr>
                                      <th className="text-left p-2 font-medium">
                                        Capability
                                      </th>
                                      <th className="text-left p-2 font-medium">
                                        Implementation
                                      </th>
                                      <th className="text-left p-2 font-medium">
                                        Provides
                                      </th>
                                      <th className="text-left p-2 font-medium">
                                        Options
                                      </th>
                                    </tr>
                                  </thead>
                                  <tbody>
                                    {Object.entries(
                                      externalHostConfig.capabilities
                                    ).flatMap(([capability, bindings]) =>
                                      bindings.map((binding, index) => (
                                        <tr
                                          key={`${capability}-${index}`}
                                          className="border-t"
                                        >
                                          <td className="p-2 font-mono">
                                            {capability}
                                          </td>
                                          <td className="p-2 font-mono break-all">
                                            {binding.uses}
                                          </td>
                                          <td className="p-2">
                                            {binding.provides?.join(', ') ??
                                              '-'}
                                          </td>
                                          <td className="p-2">
                                            {binding.with ? (
                                              <pre className="font-mono whitespace-pre-wrap">
                                                {jsonPreview(binding.with)}
                                              </pre>
                                            ) : (
                                              '-'
                                            )}
                                          </td>
                                        </tr>
                                      ))
                                    )}
                                  </tbody>
                                </table>
                              </div>
                            </div>
                          )}

                        {externalHostConfig.options &&
                          Object.keys(externalHostConfig.options).length >
                            0 && (
                            <div>
                              <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-1">
                                Driver Options
                              </h4>
                              <JsonBlock value={externalHostConfig.options} />
                            </div>
                          )}
                      </div>
                    )}

                    {result.request.expect && (
                      <div>
                        <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-1">
                          Configured Expectations
                        </h4>
                        <JsonBlock value={result.request.expect} />
                      </div>
                    )}

                    {result.request.args && (
                      <div>
                        <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-1">
                          Arguments
                        </h4>
                        <JsonBlock value={result.request.args} />
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
                    {expectationRows.filter(([, e]) => e.pass).length}/
                    {expectationRows.length} passed
                  </span>
                }
              >
                <div className="space-y-2">
                  {expectationRows.map(([type, exp]) => (
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

            {result.externalHost && (
              <CollapsibleSection
                title="Host Outcomes & Evidence"
                defaultOpen={true}
              >
                <div className="space-y-4">
                  {answer && (
                    <div>
                      <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-1">
                        Final Answer
                      </h4>
                      <p className="text-sm bg-muted p-3 rounded-md whitespace-pre-wrap">
                        {answer}
                      </p>
                    </div>
                  )}

                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                    <div className="rounded-md bg-muted p-3">
                      <div className="text-xs text-muted-foreground">
                        Tool Calls
                      </div>
                      <div className="text-lg font-semibold">
                        {hostToolCalls.length}
                      </div>
                    </div>
                    <div className="rounded-md bg-muted p-3">
                      <div className="text-xs text-muted-foreground">
                        Input Tokens
                      </div>
                      <div className="text-lg font-semibold">
                        {formatNumber(numberField(hostUsage, 'inputTokens'))}
                      </div>
                    </div>
                    <div className="rounded-md bg-muted p-3">
                      <div className="text-xs text-muted-foreground">
                        Output Tokens
                      </div>
                      <div className="text-lg font-semibold">
                        {formatNumber(numberField(hostUsage, 'outputTokens'))}
                      </div>
                    </div>
                    <div className="rounded-md bg-muted p-3">
                      <div className="text-xs text-muted-foreground">Cost</div>
                      <div className="text-lg font-semibold">
                        {formatCost(numberField(hostUsage, 'totalCostUsd'))}
                      </div>
                    </div>
                  </div>

                  {hostToolCalls.length > 0 && (
                    <div>
                      <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-2">
                        Observed Tool Calls
                      </h4>
                      <div className="space-y-2">
                        {hostToolCalls.map((call, i) => (
                          <div
                            key={`${call.name}-${i}`}
                            className="rounded-md border bg-muted/50 p-3 text-xs"
                          >
                            <div className="flex items-center gap-2 mb-2">
                              <code className="font-semibold">{call.name}</code>
                              {call.id && (
                                <span className="text-muted-foreground font-mono">
                                  {call.id}
                                </span>
                              )}
                            </div>
                            <JsonBlock value={call.arguments} />
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  {hostUsage && (
                    <div>
                      <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-2">
                        Usage & Durations
                      </h4>
                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 text-sm">
                        <InfoField
                          label="Total Cost"
                          value={formatCost(
                            numberField(hostUsage, 'totalCostUsd')
                          )}
                        />
                        <InfoField
                          label="Host Duration"
                          value={formatMs(numberField(hostUsage, 'durationMs'))}
                        />
                        <InfoField
                          label="API Duration"
                          value={formatMs(
                            numberField(hostUsage, 'durationApiMs')
                          )}
                        />
                        <InfoField
                          label="LLM Duration"
                          value={formatMs(llmDurationMs)}
                        />
                        <InfoField
                          label="MCP Duration"
                          value={formatMs(mcpDurationMs)}
                        />
                        <InfoField
                          label="Reporter Duration"
                          value={formatMs(result.durationMs)}
                        />
                        {numberField(hostUsage, 'cacheReadInputTokens') !==
                          undefined && (
                          <InfoField
                            label="Cache Read Tokens"
                            value={formatNumber(
                              numberField(hostUsage, 'cacheReadInputTokens')
                            )}
                          />
                        )}
                        {numberField(hostUsage, 'cacheCreationInputTokens') !==
                          undefined && (
                          <InfoField
                            label="Cache Write Tokens"
                            value={formatNumber(
                              numberField(hostUsage, 'cacheCreationInputTokens')
                            )}
                          />
                        )}
                      </div>
                    </div>
                  )}

                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-sm">
                    <InfoField
                      label="Host"
                      value={
                        <>
                          <p className="font-medium">
                            {result.externalHost.displayName}
                            {result.externalHost.hostVariant
                              ? ` / ${result.externalHost.hostVariant}`
                              : ''}
                          </p>
                          <p className="font-mono text-xs text-muted-foreground break-all mt-1">
                            {result.externalHost.driverSlug}
                          </p>
                        </>
                      }
                    />
                    <InfoField
                      label="Evidence"
                      value={`${result.externalHost.traceSource} · ${result.externalHost.traceConfidence}`}
                    />
                    <InfoField
                      label="Session"
                      value={
                        <code className="text-xs break-all">
                          {result.externalHost.session.id ?? 'unknown'}
                        </code>
                      }
                    />
                    <InfoField
                      label="Request"
                      value={
                        <code className="text-xs break-all">
                          {result.externalHost.session.requestId ?? 'unknown'}
                        </code>
                      }
                    />
                    <InfoField
                      label="Run Marker"
                      value={
                        <code className="text-xs break-all">
                          {result.externalHost.session.runMarker}
                        </code>
                      }
                    />
                    <InfoField
                      label="Correlation Strategy"
                      value={
                        <>
                          <code className="text-xs">
                            {result.externalHost.correlation.strategy}
                          </code>
                          <p className="text-xs text-muted-foreground mt-1">
                            prompt marker{' '}
                            {result.externalHost.correlation.includedInPrompt
                              ? 'included'
                              : 'not included'}
                          </p>
                        </>
                      }
                    />
                    {result.externalHost.session.cliSessionId && (
                      <InfoField
                        label="CLI Session"
                        value={
                          <code className="text-xs break-all">
                            {result.externalHost.session.cliSessionId}
                          </code>
                        }
                      />
                    )}
                  </div>

                  <div>
                    <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-2">
                      Capabilities
                    </h4>
                    <div className="flex flex-wrap gap-2">
                      {result.externalHost.capabilitiesUsed.map(
                        (capability) => (
                          <span
                            key={capability}
                            className="px-2 py-1 rounded text-xs bg-muted text-muted-foreground"
                          >
                            {capability}
                          </span>
                        )
                      )}
                    </div>
                  </div>

                  {externalHostEvidenceRows.length > 0 && (
                    <div>
                      <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-2">
                        Evidence Sources
                      </h4>
                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 text-xs">
                        {externalHostEvidenceRows.map((row) => (
                          <div key={row.key} className="rounded bg-muted p-2">
                            <div className="font-medium">{row.label}</div>
                            <div className="text-muted-foreground">
                              {row.source} · {row.confidence}
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  {result.externalHost.failureKind && (
                    <div className="rounded-md bg-orange-500/10 text-orange-700 dark:text-orange-300 p-3 text-sm">
                      Host failure: {result.externalHost.failureKind}
                    </div>
                  )}

                  {result.externalHost.traceLimitations &&
                    result.externalHost.traceLimitations.length > 0 && (
                      <div>
                        <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-2">
                          Limitations
                        </h4>
                        <ul className="space-y-1 text-sm text-muted-foreground">
                          {result.externalHost.traceLimitations.map(
                            (limitation, i) => (
                              <li key={i}>{limitation}</li>
                            )
                          )}
                        </ul>
                      </div>
                    )}

                  {result.externalHost.artifacts.length > 0 && (
                    <div>
                      <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-2">
                        Artifacts
                      </h4>
                      <div className="space-y-2">
                        {result.externalHost.artifacts.map((artifact, i) => (
                          <div
                            key={i}
                            className="rounded-md bg-muted p-3 text-xs"
                          >
                            <div className="font-medium">{artifact.name}</div>
                            <div className="text-muted-foreground">
                              {artifact.kind}
                              {artifact.contentType
                                ? ` · ${artifact.contentType}`
                                : ''}
                            </div>
                            {artifact.path && (
                              <pre className="mt-1 font-mono whitespace-pre-wrap break-all">
                                {artifact.path}
                              </pre>
                            )}
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
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
                        {iterations.some((r) => r.externalHost) && (
                          <th className="text-left py-2 pr-4 font-medium">
                            Host trace
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
                          {iterations.some((r) => r.externalHost) && (
                            <td className="py-2 pr-4">
                              {iter.externalHost ? (
                                <span
                                  className="text-xs text-muted-foreground"
                                  title={iter.externalHost.traceSource}
                                >
                                  {iter.externalHost.driverSlug ??
                                    iter.externalHost.hostName}{' '}
                                  · {iter.externalHost.traceConfidence}
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
            {result.response === null || result.response === undefined ? (
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
