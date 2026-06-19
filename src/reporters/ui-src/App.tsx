import React, { useState, useMemo } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { createRoot } from 'react-dom/client';
import type { MCPEvalData, EvalCaseResult } from './types';
import { Layout } from './components/Layout';
import { ErrorBoundary } from './components/ErrorBoundary';
import {
  MetricsCards,
  SourceBreakdown,
} from './components/Dashboard/MetricsCards';
import { ByToolTable } from './components/Dashboard/ByToolTable';
import { FailureBreakdown } from './components/Dashboard/FailureBreakdown';
import { TrendChart } from './components/Dashboard/TrendChart';
import { ResultsTable } from './components/Results/ResultsTable';
import { DetailModal } from './components/Results/DetailModal';
import { ConformancePanel } from './components/Conformance/ConformancePanel';
import { ServerCapabilities } from './components/ServerInfo/ServerCapabilities';

type Tab = 'overview' | 'evals' | 'tests';

function App() {
  const data: MCPEvalData = window.MCP_EVAL_DATA || {
    runData: {
      timestamp: new Date().toISOString(),
      durationMs: 0,
      environment: { ci: false, node: '', platform: '' },
      metrics: {
        total: 0,
        passed: 0,
        failed: 0,
        passRate: 0,
        datasetBreakdown: {},
        expectationBreakdown: {
          exact: 0,
          schema: 0,
          textContains: 0,
          regex: 0,
          snapshot: 0,
          judge: 0,
          error: 0,
          size: 0,
          toolsTriggered: 0,
          toolCallCount: 0,
        },
      },
      results: [],
    },
    historical: [],
  };

  const evalResults = useMemo(
    () => data.runData.results.filter((r) => r.source === 'eval'),
    [data.runData.results]
  );

  const testResults = useMemo(
    () => data.runData.results.filter((r) => r.source === 'test'),
    [data.runData.results]
  );

  // Default to Tests if present (simpler → complex), then Evals, then Overview
  const defaultTab: Tab =
    testResults.length > 0
      ? 'tests'
      : evalResults.length > 0
        ? 'evals'
        : 'overview';

  const [activeTab, setActiveTab] = useState<Tab>(defaultTab);
  const [selectedResult, setSelectedResult] = useState<EvalCaseResult | null>(
    null
  );
  // Shared expand/collapse state for each tab's detail panels
  const [evalDetailsExpanded, setEvalDetailsExpanded] = useState(true);
  const [testDetailsExpanded, setTestDetailsExpanded] = useState(false);

  const hasEvals = evalResults.length > 0;
  const hasTests = testResults.length > 0;
  const hasConformanceChecks =
    data.runData.conformanceChecks && data.runData.conformanceChecks.length > 0;
  const hasServerCapabilities =
    data.runData.serverCapabilities &&
    data.runData.serverCapabilities.length > 0;

  const tabs: { id: Tab; label: string; count?: number }[] = [
    { id: 'overview', label: 'Overview' },
    ...(hasTests
      ? [{ id: 'tests' as Tab, label: 'Tests', count: testResults.length }]
      : []),
    ...(hasEvals
      ? [{ id: 'evals' as Tab, label: 'Evals', count: evalResults.length }]
      : []),
  ];

  return (
    <>
      <Layout
        timestamp={data.runData.timestamp}
        platform={data.runData.environment.platform}
        durationMs={data.runData.durationMs}
        ci={data.runData.environment.ci}
      >
        {/* Tab navigation — underline style, familiar from VS Code / Chrome DevTools */}
        {/* Full-bleed border, but tabs align to the same max width as the content below. */}
        <div className="border-b border-border">
          <div className="mx-auto w-full max-w-[1600px] px-6">
            <nav
              role="tablist"
              aria-label="Report sections"
              className="-mb-px flex gap-1"
            >
              {tabs.map((tab) => (
                <button
                  key={tab.id}
                  role="tab"
                  id={`tab-${tab.id}`}
                  aria-selected={activeTab === tab.id}
                  aria-controls={`${tab.id}-panel`}
                  onClick={() => setActiveTab(tab.id)}
                  className={`flex items-center gap-2 px-4 py-3 text-sm font-medium border-b-2 transition-colors ${
                    activeTab === tab.id
                      ? 'border-primary text-foreground'
                      : 'border-transparent text-muted-foreground hover:text-foreground hover:border-border'
                  }`}
                >
                  {tab.label}
                  {tab.count !== undefined && (
                    <span
                      className={`inline-flex items-center justify-center rounded-full px-2 py-0.5 text-xs font-medium ${
                        activeTab === tab.id
                          ? 'bg-primary/10 text-primary'
                          : 'bg-muted text-muted-foreground'
                      }`}
                    >
                      {tab.count}
                    </span>
                  )}
                </button>
              ))}
            </nav>
          </div>
        </div>

        <div className="max-w-[1600px] mx-auto p-6 h-full flex flex-col gap-6">
          {activeTab === 'overview' && (
            <div
              role="tabpanel"
              id="overview-panel"
              aria-labelledby="tab-overview"
              tabIndex={0}
              className="contents"
            >
              <ErrorBoundary label="Overview tab">
                <>
                  {/* Tests and Evals side by side — separate figures, not a misleading combined total */}
                  <SourceBreakdown results={data.runData.results} />

                  {/* Historical trend — the most important overview signal */}
                  <TrendChart historical={data.historical} />
                </>
              </ErrorBoundary>
            </div>
          )}

          {activeTab === 'evals' && (
            <div
              role="tabpanel"
              id="evals-panel"
              aria-labelledby="tab-evals"
              tabIndex={0}
              className="contents"
            >
              <ErrorBoundary label="Evals tab">
                <>
                  {/* Eval-specific metrics: accuracy, tool discovery, regressions */}
                  <MetricsCards results={evalResults} mode="eval" />

                  {/* Diagnostic panels with shared toggle above */}
                  <div className="space-y-2">
                    <button
                      onClick={() => setEvalDetailsExpanded((v) => !v)}
                      aria-expanded={evalDetailsExpanded}
                      aria-controls="eval-details-grid"
                      className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors"
                    >
                      {evalDetailsExpanded ? (
                        <ChevronDown className="w-3.5 h-3.5" />
                      ) : (
                        <ChevronRight className="w-3.5 h-3.5" />
                      )}
                      {evalDetailsExpanded ? 'Hide details' : 'Show details'}
                    </button>
                    <div
                      id="eval-details-grid"
                      className="grid grid-cols-1 lg:grid-cols-2 gap-4 items-start"
                    >
                      <FailureBreakdown
                        results={evalResults}
                        isExpanded={evalDetailsExpanded}
                      />
                      <ByToolTable
                        results={evalResults}
                        isExpanded={evalDetailsExpanded}
                      />
                    </div>
                  </div>

                  {/* Eval results table */}
                  <div className="rounded-lg border bg-card shadow-sm overflow-hidden flex-1 min-h-0">
                    <ResultsTable
                      results={evalResults}
                      onSelectResult={setSelectedResult}
                      defaultSource="eval"
                    />
                  </div>
                </>
              </ErrorBoundary>
            </div>
          )}

          {activeTab === 'tests' && (
            <div
              role="tabpanel"
              id="tests-panel"
              aria-labelledby="tab-tests"
              tabIndex={0}
              className="contents"
            >
              <ErrorBoundary label="Tests tab">
                <>
                  {/* Test suite pass/fail summary */}
                  <MetricsCards results={testResults} mode="test" />

                  {/* Conformance + server capabilities with shared toggle above */}
                  {(hasConformanceChecks || hasServerCapabilities) && (
                    <div className="space-y-2">
                      <button
                        onClick={() => setTestDetailsExpanded((v) => !v)}
                        aria-expanded={testDetailsExpanded}
                        aria-controls="test-details-grid"
                        className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors"
                      >
                        {testDetailsExpanded ? (
                          <ChevronDown className="w-3.5 h-3.5" />
                        ) : (
                          <ChevronRight className="w-3.5 h-3.5" />
                        )}
                        {testDetailsExpanded ? 'Hide details' : 'Show details'}
                      </button>
                      <div
                        id="test-details-grid"
                        className="grid grid-cols-1 lg:grid-cols-2 gap-4 items-start"
                      >
                        {hasConformanceChecks && (
                          <ConformancePanel
                            conformanceChecks={data.runData.conformanceChecks!}
                            isExpanded={testDetailsExpanded}
                          />
                        )}
                        {hasServerCapabilities && (
                          <ServerCapabilities
                            serverCapabilities={
                              data.runData.serverCapabilities!
                            }
                            isExpanded={testDetailsExpanded}
                          />
                        )}
                      </div>
                    </div>
                  )}

                  {/* Test results table */}
                  <div className="rounded-lg border bg-card shadow-sm overflow-hidden flex-1 min-h-0">
                    <ResultsTable
                      results={testResults}
                      onSelectResult={setSelectedResult}
                      defaultSource="test"
                    />
                  </div>
                </>
              </ErrorBoundary>
            </div>
          )}
        </div>
      </Layout>

      <DetailModal
        result={selectedResult}
        onClose={() => setSelectedResult(null)}
      />
    </>
  );
}

const root = document.getElementById('root');
if (root) {
  createRoot(root).render(<App />);
}
