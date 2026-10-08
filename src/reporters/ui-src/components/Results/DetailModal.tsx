import React, { useEffect, useRef } from 'react';
import { X } from 'lucide-react';
import type { EvalCaseResult, SkillLoad } from '../../types';
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

function getExternalClientEvidenceRows(
  clientMetadata: NonNullable<EvalCaseResult['clientMetadata']>
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
      const evidence = clientMetadata.evidence?.[key];
      const source = evidence?.source ?? clientMetadata.sources?.[key];
      const confidence = evidence?.confidence;

      if (!source && !confidence) {
        return undefined;
      }

      return {
        key,
        label: labels[key],
        source: source ?? 'unknown',
        confidence: confidence ?? clientMetadata.traceConfidence,
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

/**
 * Skill loads recorded by the simulated client (skills enabled): from the
 * response, or the last trial when responses were omitted.
 */
function resultSkillLoads(result: EvalCaseResult): SkillLoad[] {
  const fromResponse = responseRecord(result).skillLoads;
  const loads = Array.isArray(fromResponse)
    ? fromResponse
    : (result.trialResults?.at(-1)?.skillLoads ?? []);
  return loads.filter(
    (load): load is SkillLoad =>
      isRecord(load) &&
      typeof load.name === 'string' &&
      typeof load.uri === 'string'
  );
}

function skillVerificationStyle(verified: boolean | null): string {
  if (verified === null) return 'text-muted-foreground';
  return verified
    ? 'text-green-600 dark:text-green-400'
    : 'text-red-600 dark:text-red-400';
}

function skillVerificationLabel(verified: boolean | null): string {
  if (verified === null) return 'unverified';
  return verified ? 'verified' : 'verification failed';
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
    (result.clientUsage as unknown as Record<string, unknown> | undefined) ??
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

function scoreEntries(result: EvalCaseResult) {
  return Object.entries(result.scores ?? {}).filter(
    (entry): entry is [string, NonNullable<(typeof entry)[1]>] =>
      entry[1] !== undefined
  );
}

function failedScoreEntries(result: EvalCaseResult) {
  return scoreEntries(result).filter(([, score]) => {
    return !score.pass;
  });
}

function getOutcomeSummary(result: EvalCaseResult): {
  category: string;
  reason: string;
} {
  const failedGraders = failedScoreEntries(result).map(([type]) => type);

  if (result.pass) {
    return {
      category: 'Pass',
      reason: 'All configured graders passed.',
    };
  }

  if (result.clientMetadata?.failureKind) {
    return {
      category: 'Client or automation failure',
      reason: `The driver failed before producing trustworthy eval evidence: ${result.clientMetadata.failureKind}.`,
    };
  }

  if (result.error) {
    const firstLine = stripAnsiCodes(result.error).split('\n')[0] ?? '';
    return {
      category: 'Execution failure',
      reason: firstLine,
    };
  }

  if (failedGraders.length > 0) {
    return {
      category: 'Assertion failure',
      reason: `${failedGraders.length} configured grader${failedGraders.length === 1 ? '' : 's'} failed: ${failedGraders.join(', ')}.`,
    };
  }

  return {
    category: 'Failure',
    reason:
      'The run failed without a specific assertion or client error in the report.',
  };
}

function evidenceSummary(
  clientMetadata: NonNullable<EvalCaseResult['clientMetadata']> | undefined,
  key: 'finalAnswer' | 'toolCalls' | 'usage' | 'cost'
): string {
  if (!clientMetadata) {
    return 'not reported';
  }
  const evidence = clientMetadata.evidence?.[key];
  const source = evidence?.source ?? clientMetadata.sources?.[key];
  const confidence = evidence?.confidence ?? clientMetadata.traceConfidence;

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
            last?.focus();
          }
        } else {
          if (document.activeElement === last) {
            event.preventDefault();
            first?.focus();
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
  const scoreRows = scoreEntries(result);
  const failedScoreRows = failedScoreEntries(result);
  const hasAssertions = scoreRows.length > 0;
  const hasTrials = result.trialResults && result.trialResults.length > 0;
  const trials = result.trialResults!;
  const displayRate = result.passRate;
  const infraErrorRate = result.infrastructureErrorRate;
  const externalClientEvidenceRows = result.clientMetadata
    ? getExternalClientEvidenceRows(result.clientMetadata)
    : [];
  const clientToolCalls = resultToolCalls(result);
  const skillLoads = resultSkillLoads(result);
  const clientUsage = usageForResult(result);
  const answer = finalAnswer(result);
  const llmDurationMs = numberField(responseRecord(result), 'llmDurationMs');
  const mcpDurationMs = numberField(responseRecord(result), 'mcpDurationMs');
  const outcome = getOutcomeSummary(result);

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
              {/* Assertion pass rate badge — only for multi-trial cases */}
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
                    result.passRateCI
                      ? `95% confidence interval: the true pass rate is likely between ${(result.passRateCI.lower * 100).toFixed(0)}% and ${(result.passRateCI.upper * 100).toFixed(0)}%. Run more trials to narrow this range.`
                      : undefined
                  }
                >
                  {(displayRate * 100).toFixed(0)}% pass rate
                  {result.passRateCI && (
                    <span className="text-xs opacity-70 font-normal">
                      {` ±${Math.round(((result.passRateCI.upper - result.passRateCI.lower) / 2) * 100)}%`}
                    </span>
                  )}
                  {hasTrials && (
                    <span className="text-xs opacity-70">
                      ({trials.filter((r) => r.pass).length}/
                      {trials.filter((r) => !r.isInfrastructureError).length})
                    </span>
                  )}
                </span>
              )}
              {/* Infrastructure error rate badge — only when non-zero */}
              {infraErrorRate !== undefined && infraErrorRate > 0 && (
                <span className="inline-flex items-center gap-1 px-3 py-1 rounded-full text-sm font-semibold shrink-0 bg-orange-500/20 text-orange-700 dark:text-orange-400">
                  {(infraErrorRate * 100).toFixed(0)}% infra errors
                  {hasTrials && (
                    <span className="text-xs opacity-70">
                      ({trials.filter((r) => r.isInfrastructureError).length}/
                      {trials.length})
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
              {result.clientMetadata && (
                <>
                  <span className="px-2 py-1 rounded text-xs font-medium bg-teal-100 text-teal-700 dark:bg-teal-900/30 dark:text-teal-300">
                    {result.clientMetadata.clientName}
                  </span>
                  <span
                    className={`px-2 py-1 rounded text-xs font-medium ${
                      result.clientMetadata.traceConfidence === 'high'
                        ? 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-300'
                        : result.clientMetadata.traceConfidence === 'medium'
                          ? 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300'
                          : 'bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300'
                    }`}
                  >
                    {result.clientMetadata.traceConfidence} trace
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

            <CollapsibleSection title="Outcome" defaultOpen={true}>
              <div className="space-y-4">
                <div
                  className={`rounded-md border p-4 ${
                    result.pass
                      ? 'border-green-500/30 bg-green-500/10'
                      : result.clientMetadata?.failureKind || result.error
                        ? 'border-orange-500/30 bg-orange-500/10'
                        : 'border-red-500/30 bg-red-500/10'
                  }`}
                >
                  <div className="flex flex-wrap items-center gap-2 mb-2">
                    <span className="text-sm font-semibold">
                      {outcome.category}
                    </span>
                    {failedScoreRows.length > 0 && (
                      <span className="text-xs text-muted-foreground">
                        {failedScoreRows.length} failed grader
                        {failedScoreRows.length === 1 ? '' : 's'}
                      </span>
                    )}
                  </div>
                  <p className="text-sm text-muted-foreground">
                    {outcome.reason}
                  </p>
                </div>

                {result.clientMetadata && (
                  <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 text-sm">
                    <InfoField
                      label="Driver"
                      value={
                        <>
                          <span className="font-medium">
                            {result.clientMetadata.displayName}
                          </span>
                          <p className="font-mono text-xs text-muted-foreground break-all mt-1">
                            {result.clientMetadata.driverSlug}
                          </p>
                        </>
                      }
                    />
                    <InfoField
                      label="Trace"
                      value={`${result.clientMetadata.traceSource} · ${result.clientMetadata.traceConfidence}`}
                    />
                    <InfoField
                      label="Correlation"
                      value={
                        result.clientMetadata.correlation.includedInPrompt
                          ? `${result.clientMetadata.correlation.strategy} in prompt`
                          : result.clientMetadata.correlation.strategy
                      }
                    />
                    <InfoField
                      label="Final Answer Source"
                      value={evidenceSummary(
                        result.clientMetadata,
                        'finalAnswer'
                      )}
                    />
                    <InfoField
                      label="Tool Evidence"
                      value={evidenceSummary(
                        result.clientMetadata,
                        'toolCalls'
                      )}
                    />
                    <InfoField
                      label="Usage Evidence"
                      value={evidenceSummary(result.clientMetadata, 'usage')}
                    />
                  </div>
                )}
              </div>
            </CollapsibleSection>

            {/* Setup and configuration — show what the eval was configured to run */}
            {result.request &&
              (result.request.args ||
                result.request.input ||
                result.request.description ||
                result.request.assertions ||
                result.request.judges) && (
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
                        label="Dataset"
                        value={
                          <span className="font-medium">
                            {result.datasetName}
                          </span>
                        }
                      />
                      <InfoField
                        label="Trials"
                        value={
                          result.request.trials ??
                          result.trialResults?.length ??
                          1
                        }
                      />
                      {result.request.passThreshold !== undefined && (
                        <InfoField
                          label="Pass Threshold"
                          value={`${(result.request.passThreshold * 100).toFixed(0)}%`}
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

                    {result.request.input && (
                      <div>
                        <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-1">
                          Scenario
                        </h4>
                        <p className="text-sm bg-muted p-3 rounded-md">
                          {result.request.input}
                        </p>
                      </div>
                    )}

                    {(result.request.client || result.request.model) && (
                      <div className="flex gap-2">
                        {result.request.client && (
                          <span className="px-2 py-1 rounded text-xs font-medium bg-violet-100 text-violet-700 dark:bg-violet-900/30 dark:text-violet-300">
                            {result.request.client}
                          </span>
                        )}
                        {result.request.model && (
                          <span className="px-2 py-1 rounded text-xs font-medium bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400">
                            {result.request.model}
                          </span>
                        )}
                      </div>
                    )}

                    {result.request.assertions && (
                      <div>
                        <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-1">
                          Configured Assertions
                        </h4>
                        <JsonBlock value={result.request.assertions} />
                      </div>
                    )}

                    {result.request.judges && (
                      <div>
                        <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-1">
                          Configured Judges
                        </h4>
                        <JsonBlock value={result.request.judges} />
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
                    {scoreRows.filter(([, e]) => e.pass).length}/
                    {scoreRows.length} passed
                  </span>
                }
              >
                <div className="space-y-2">
                  {scoreRows.map(([type, exp]) => (
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

            {result.clientMetadata && (
              <CollapsibleSection
                title="Client Outcomes & Evidence"
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
                        {clientToolCalls.length}
                      </div>
                    </div>
                    <div className="rounded-md bg-muted p-3">
                      <div className="text-xs text-muted-foreground">
                        Input Tokens
                      </div>
                      <div className="text-lg font-semibold">
                        {formatNumber(numberField(clientUsage, 'inputTokens'))}
                      </div>
                    </div>
                    <div className="rounded-md bg-muted p-3">
                      <div className="text-xs text-muted-foreground">
                        Output Tokens
                      </div>
                      <div className="text-lg font-semibold">
                        {formatNumber(numberField(clientUsage, 'outputTokens'))}
                      </div>
                    </div>
                    <div className="rounded-md bg-muted p-3">
                      <div className="text-xs text-muted-foreground">Cost</div>
                      <div className="text-lg font-semibold">
                        {formatCost(numberField(clientUsage, 'totalCostUsd'))}
                      </div>
                    </div>
                  </div>

                  {clientToolCalls.length > 0 && (
                    <div>
                      <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-2">
                        Observed Tool Calls
                      </h4>
                      <div className="space-y-2">
                        {clientToolCalls.map((call, i) => (
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

                  {skillLoads.length > 0 && (
                    <div>
                      <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-2">
                        Skill Loads
                      </h4>
                      <div className="space-y-2">
                        {skillLoads.map((load, i) => (
                          <div
                            key={`${load.uri}-${i}`}
                            className="rounded-md border bg-muted/50 p-3 text-xs"
                          >
                            <div className="flex flex-wrap items-center gap-2">
                              <code className="font-semibold">{load.name}</code>
                              <span className="text-muted-foreground">
                                {load.kind === 'file' ? 'file' : 'skill'} via{' '}
                                {load.via} · after {load.afterToolCalls} tool
                                call{load.afterToolCalls === 1 ? '' : 's'}
                              </span>
                              <span
                                className={skillVerificationStyle(
                                  load.verified
                                )}
                              >
                                {skillVerificationLabel(load.verified)}
                              </span>
                            </div>
                            <div className="font-mono text-muted-foreground mt-1 break-all">
                              {load.uri}
                            </div>
                            {load.problems && load.problems.length > 0 && (
                              <div className="mt-1 text-red-700 dark:text-red-300">
                                {load.problems.join('; ')}
                              </div>
                            )}
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  {clientUsage && (
                    <div>
                      <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-2">
                        Usage & Durations
                      </h4>
                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 text-sm">
                        <InfoField
                          label="Total Cost"
                          value={formatCost(
                            numberField(clientUsage, 'totalCostUsd')
                          )}
                        />
                        <InfoField
                          label="Client Duration"
                          value={formatMs(
                            numberField(clientUsage, 'durationMs')
                          )}
                        />
                        <InfoField
                          label="API Duration"
                          value={formatMs(
                            numberField(clientUsage, 'durationApiMs')
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
                        {numberField(clientUsage, 'cacheReadInputTokens') !==
                          undefined && (
                          <InfoField
                            label="Cache Read Tokens"
                            value={formatNumber(
                              numberField(clientUsage, 'cacheReadInputTokens')
                            )}
                          />
                        )}
                        {numberField(
                          clientUsage,
                          'cacheCreationInputTokens'
                        ) !== undefined && (
                          <InfoField
                            label="Cache Write Tokens"
                            value={formatNumber(
                              numberField(
                                clientUsage,
                                'cacheCreationInputTokens'
                              )
                            )}
                          />
                        )}
                      </div>
                    </div>
                  )}

                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-sm">
                    <InfoField
                      label="Client"
                      value={
                        <>
                          <p className="font-medium">
                            {result.clientMetadata.displayName}
                            {result.clientMetadata.clientVariant
                              ? ` / ${result.clientMetadata.clientVariant}`
                              : ''}
                          </p>
                          <p className="font-mono text-xs text-muted-foreground break-all mt-1">
                            {result.clientMetadata.driverSlug}
                          </p>
                        </>
                      }
                    />
                    <InfoField
                      label="Evidence"
                      value={`${result.clientMetadata.traceSource} · ${result.clientMetadata.traceConfidence}`}
                    />
                    <InfoField
                      label="Session"
                      value={
                        <code className="text-xs break-all">
                          {result.clientMetadata.session.id ?? 'unknown'}
                        </code>
                      }
                    />
                    <InfoField
                      label="Request"
                      value={
                        <code className="text-xs break-all">
                          {result.clientMetadata.session.requestId ?? 'unknown'}
                        </code>
                      }
                    />
                    <InfoField
                      label="Run Marker"
                      value={
                        <code className="text-xs break-all">
                          {result.clientMetadata.session.runMarker}
                        </code>
                      }
                    />
                    <InfoField
                      label="Correlation Strategy"
                      value={
                        <>
                          <code className="text-xs">
                            {result.clientMetadata.correlation.strategy}
                          </code>
                          <p className="text-xs text-muted-foreground mt-1">
                            prompt marker{' '}
                            {result.clientMetadata.correlation.includedInPrompt
                              ? 'included'
                              : 'not included'}
                          </p>
                        </>
                      }
                    />
                    {result.clientMetadata.session.cliSessionId && (
                      <InfoField
                        label="CLI Session"
                        value={
                          <code className="text-xs break-all">
                            {result.clientMetadata.session.cliSessionId}
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
                      {result.clientMetadata.capabilitiesUsed.map(
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

                  {externalClientEvidenceRows.length > 0 && (
                    <div>
                      <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-2">
                        Evidence Sources
                      </h4>
                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 text-xs">
                        {externalClientEvidenceRows.map((row) => (
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

                  {result.clientMetadata.failureKind && (
                    <div className="rounded-md bg-orange-500/10 text-orange-700 dark:text-orange-300 p-3 text-sm">
                      Client failure: {result.clientMetadata.failureKind}
                    </div>
                  )}

                  {result.clientMetadata.traceLimitations &&
                    result.clientMetadata.traceLimitations.length > 0 && (
                      <div>
                        <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-2">
                          Limitations
                        </h4>
                        <ul className="space-y-1 text-sm text-muted-foreground">
                          {result.clientMetadata.traceLimitations.map(
                            (limitation, i) => (
                              <li key={i}>{limitation}</li>
                            )
                          )}
                        </ul>
                      </div>
                    )}

                  {result.clientMetadata.artifacts.length > 0 && (
                    <div>
                      <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-2">
                        Artifacts
                      </h4>
                      <div className="space-y-2">
                        {result.clientMetadata.artifacts.map((artifact, i) => (
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

            {/* Tool calls, for client cases with tool-call assertions */}
            {result.source === 'eval' && result.toolPrecision !== undefined && (
              <CollapsibleSection title="Tool Calls" defaultOpen={true}>
                {result.toolCallTrace ? (
                  <div className="space-y-1">
                    {result.toolCallTrace.calls.map((call, i) => (
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
                    {result.toolCallTrace.missed.map((missed, i) => (
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

            {/* Trials breakdown — for multi-trial cases */}
            {hasTrials && (
              <CollapsibleSection
                title="Trials"
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
                        {trials.some((r) => r.toolCallTrace) && (
                          <th className="text-left py-2 pr-4 font-medium">
                            Tools called
                          </th>
                        )}
                        {trials.some((r) => r.clientMetadata) && (
                          <th className="text-left py-2 pr-4 font-medium">
                            Client trace
                          </th>
                        )}
                        <th className="text-left py-2 font-medium">Error</th>
                      </tr>
                    </thead>
                    <tbody>
                      {trials.map((trial, i) => (
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
                                trial.isInfrastructureError
                                  ? 'text-orange-600 dark:text-orange-400'
                                  : trial.pass
                                    ? 'text-green-600 dark:text-green-400'
                                    : 'text-red-600 dark:text-red-400'
                              }`}
                            >
                              {trial.isInfrastructureError
                                ? '⚠ infra'
                                : trial.pass
                                  ? '✓ pass'
                                  : '✗ fail'}
                            </span>
                          </td>
                          <td className="py-2 pr-4 text-muted-foreground">
                            {trial.durationMs.toFixed(0)}ms
                          </td>
                          {trials.some((r) => r.toolCallTrace) && (
                            <td className="py-2 pr-4">
                              {trial.toolCallTrace ? (
                                <span className="flex flex-wrap gap-1 items-center">
                                  {trial.toolCallTrace.calls.map((c, j) => (
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
                                  {trial.toolCallTrace.missed.map((m, j) => (
                                    <code
                                      key={`missed-${j}`}
                                      className="text-xs px-1.5 py-0.5 rounded bg-muted text-muted-foreground line-through"
                                      title="Required tool was never called"
                                    >
                                      {m.name}
                                    </code>
                                  ))}
                                  {trial.toolCallTrace.calls.length === 0 &&
                                    trial.toolCallTrace.missed.length === 0 && (
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
                          {trials.some((r) => r.clientMetadata) && (
                            <td className="py-2 pr-4">
                              {trial.clientMetadata ? (
                                <span
                                  className="text-xs text-muted-foreground"
                                  title={trial.clientMetadata.traceSource}
                                >
                                  {trial.clientMetadata.driverSlug ??
                                    trial.clientMetadata.clientName}{' '}
                                  · {trial.clientMetadata.traceConfidence}
                                </span>
                              ) : (
                                <span className="text-xs text-muted-foreground">
                                  —
                                </span>
                              )}
                            </td>
                          )}
                          <td className="py-2 text-xs text-muted-foreground font-mono">
                            {trial.error ? stripAnsiCodes(trial.error) : '—'}
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
