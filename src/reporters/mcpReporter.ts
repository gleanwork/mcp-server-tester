import type {
  Reporter,
  FullConfig,
  Suite,
  TestCase,
  TestResult,
  FullResult,
} from '@playwright/test/reporter';
import { mkdir, writeFile, readdir, readFile, unlink, cp } from 'fs/promises';
import { join, resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { stripVTControlCharacters } from 'node:util';
import type { MCPEvalReporterConfig } from '../types/reporter.js';
import type {
  MCPEvalRunData,
  MCPEvalHistoricalSummary,
  MCPConformanceResultData,
  MCPServerCapabilitiesData,
  MCPVariantExperimentData,
  EvalCaseResult,
} from '../types/reporter.js';
import type { UsageMetrics } from '../types/index.js';
import { sumUsage } from '../utils/usageUtils.js';
import {
  parseReporterAttachment,
  reporterAttachmentKind,
  type ReporterAttachment,
  type ToolCallPayload,
} from './channel.js';
import {
  createStoredEvalArtifact,
  resolveEvalResultStore,
} from '../evals/resultStore.js';

type ResolvedReporterConfig = Required<
  Omit<
    MCPEvalReporterConfig,
    'resultStore' | 'runId' | 'runMetadata' | 'redactStoredResponses'
  >
> &
  Pick<
    MCPEvalReporterConfig,
    'resultStore' | 'runId' | 'runMetadata' | 'redactStoredResponses'
  >;

/**
 * Custom Playwright reporter for MCP eval results
 *
 * Generates HTML reports with historical tracking
 *
 * @example
 * ```typescript
 * // playwright.config.ts
 * export default defineConfig({
 *   reporter: [
 *     ['@gleanwork/mcp-server-tester/reporters/mcpReporter', {
 *       outputDir: '.mcp-test-results',
 *       historyLimit: 10
 *     }]
 *   ]
 * });
 * ```
 */
export default class MCPReporter implements Reporter {
  private config: ResolvedReporterConfig;
  private startTime: number = 0;
  private allResults: Array<EvalCaseResult> = [];
  private conformanceChecks: Array<MCPConformanceResultData> = [];
  private serverCapabilities: Array<MCPServerCapabilitiesData> = [];
  private variantExperiment: MCPVariantExperimentData | undefined;

  constructor(options: MCPEvalReporterConfig = {}) {
    this.config = {
      outputDir: options.outputDir ?? '.mcp-test-results',
      autoOpen: options.autoOpen ?? false,
      historyLimit: options.historyLimit ?? 10,
      quiet: options.quiet ?? false,
      includeAutoTracking: options.includeAutoTracking ?? true,
      resultStore: options.resultStore,
      runId: options.runId,
      runMetadata: options.runMetadata,
      // Default true to match the eval-runner store path. Stored artifacts
      // omit response bodies by default; opt in by passing
      // `redactStoredResponses: false` if you need full responses for
      // debugging or history comparison. Keeping this consistent across
      // both write paths prevents users from getting a mix of
      // redacted/non-redacted artifacts depending on which code path wrote
      // them.
      redactStoredResponses: options.redactStoredResponses ?? true,
    };
  }

  private log(message: string): void {
    if (!this.config.quiet) {
      console.log(message);
    }
  }

  private logError(message: string, error?: unknown): void {
    if (!this.config.quiet) {
      console.error(message, error ?? '');
    }
  }

  /**
   * Reads attachment content from either in-memory body (Playwright < 1.43)
   * or from the file path on disk (Playwright ≥ 1.43, which writes large
   * attachments to disk and exposes path instead of body).
   */
  private async getAttachmentContent(attachment: {
    body?: Buffer;
    path?: string;
  }): Promise<string | null> {
    if (attachment.body) return attachment.body.toString('utf-8');
    if (attachment.path) {
      try {
        return await readFile(attachment.path, 'utf-8');
      } catch {
        return null;
      }
    }
    return null;
  }

  async onBegin(_config: FullConfig, _suite: Suite): Promise<void> {
    this.startTime = Date.now();
    this.allResults = [];
    this.conformanceChecks = [];
    this.serverCapabilities = [];

    // Ensure output directory exists
    await mkdir(this.config.outputDir, { recursive: true });
  }

  async onTestEnd(test: TestCase, result: TestResult): Promise<void> {
    const received: ReporterAttachment[] = [];
    for (const attachment of result.attachments) {
      const kind = reporterAttachmentKind(attachment);
      if (kind === undefined) continue;
      const content = await this.getAttachmentContent(attachment);
      if (!content) continue;
      try {
        received.push(parseReporterAttachment(kind, content));
      } catch (error) {
        this.logError(
          `[MCP Reporter] Failed to read attachment "${attachment.name}" from test "${test.title}":`,
          error
        );
      }
    }

    // Auto-tracked calls would duplicate a test's eval results.
    const hasEvalResults = received.some(
      (attachment) => attachment.kind === 'evalResults'
    );
    let sawExperiment = false;
    let sawToolList = false;

    for (const attachment of received) {
      switch (attachment.kind) {
        case 'evalResults':
          // evalRunner includes authType and project from the mcp fixture
          // (Playwright is the source of truth).
          this.allResults.push(...attachment.data.caseResults);
          break;
        case 'variantExperiment':
          if (!sawExperiment) this.variantExperiment = attachment.data;
          sawExperiment = true;
          break;
        case 'conformance': {
          const { data } = attachment;
          this.conformanceChecks.push({
            testTitle: test.title,
            pass: data.pass,
            checks: data.checks,
            serverInfo: data.serverInfo,
            toolCount: data.toolCount,
            ...(data.protocol ? { protocol: data.protocol } : {}),
            ...(data.scope ? { scope: data.scope } : {}),
            authType: data.authType,
            project: data.project,
          });
          break;
        }
        case 'listTools':
          if (!sawToolList)
            this.serverCapabilities.push({
              testTitle: test.title,
              tools: attachment.data.tools,
              toolCount: attachment.data.toolCount,
            });
          sawToolList = true;
          break;
        case 'toolCall':
          if (!hasEvalResults && this.config.includeAutoTracking)
            this.allResults.push(
              autoTrackedResult(test, result, attachment.data)
            );
          break;
      }
    }
  }

  async onEnd(_result: FullResult): Promise<void> {
    const endTime = Date.now();
    const durationMs = endTime - this.startTime;

    // Skip if no eval results collected
    if (this.allResults.length === 0) {
      this.log('[MCP Reporter] No MCP eval results found in test run');
      return;
    }

    // Build run data
    const runData = this.buildRunData(durationMs);

    // Load historical data
    const historical = await this.loadHistoricalData();

    // Add current run to historical
    historical.push({
      timestamp: runData.timestamp,
      total: runData.metrics.total,
      passed: runData.metrics.passed,
      failed: runData.metrics.failed,
      passRate: runData.metrics.passRate,
      durationMs: runData.durationMs,
    });

    // Save current run data
    await this.saveRunData(runData);

    // Clean up old runs
    await this.cleanupOldRuns();

    // Save current run to external storage, if configured. This is additive:
    // local report generation should still work if remote storage is down.
    await this.saveRunDataToStore(runData);

    // Generate report using copy + inject pattern
    const reportDir = join(this.config.outputDir, 'latest');
    await this.generateReport(runData, historical, reportDir);

    const reportPath = join(reportDir, 'index.html');
    this.log(`\n[MCP Reporter] Report generated: ${reportPath}`);
    this.log(
      `[MCP Reporter] Results: ${runData.metrics.passed}/${runData.metrics.total} passed (${(runData.metrics.passRate * 100).toFixed(1)}%)`
    );

    // Auto-open browser if configured and not in CI
    if (this.config.autoOpen && !process.env.CI) {
      await this.openReport(reportPath);
    }
  }

  private async generateReport(
    runData: MCPEvalRunData,
    historical: Array<MCPEvalHistoricalSummary>,
    outputDir: string
  ): Promise<void> {
    // Get the UI dist path (relative to this file)
    // In ESM, we need to use import.meta.url
    const __filename = fileURLToPath(import.meta.url);
    const __dirname = dirname(__filename);
    const uiDistPath = join(__dirname, 'ui-dist');

    // Step 1: Copy pre-built UI template
    await mkdir(outputDir, { recursive: true });
    await cp(uiDistPath, outputDir, { recursive: true, force: true });

    // Step 2: Inject test data as JavaScript
    const dataScript = `window.MCP_EVAL_DATA = ${JSON.stringify(
      {
        runData,
        historical,
      },
      null,
      2
    )};`;

    await writeFile(join(outputDir, 'data.js'), dataScript, 'utf-8');
  }

  private buildRunData(durationMs: number): MCPEvalRunData {
    const total = this.allResults.length;
    const datasetBreakdown: Record<string, number> = {};
    const expectationBreakdown = {
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
    };

    let passed = 0;
    for (const r of this.allResults) {
      if (r.pass) passed++;

      const datasetName = r.datasetName || 'Unknown Dataset';
      datasetBreakdown[datasetName] = (datasetBreakdown[datasetName] || 0) + 1;

      if (r.expectations.exact) expectationBreakdown.exact++;
      if (r.expectations.schema) expectationBreakdown.schema++;
      if (r.expectations.textContains) expectationBreakdown.textContains++;
      if (r.expectations.regex) expectationBreakdown.regex++;
      if (r.expectations.snapshot) expectationBreakdown.snapshot++;
      if (r.expectations.judge) expectationBreakdown.judge++;
      if (r.expectations.error) expectationBreakdown.error++;
      if (r.expectations.size) expectationBreakdown.size++;
      if (r.expectations.toolsTriggered) expectationBreakdown.toolsTriggered++;
      if (r.expectations.toolCallCount) expectationBreakdown.toolCallCount++;
    }

    const failed = total - passed;

    const totalHostUsage = this.allResults.reduce(
      (acc, r) => sumUsage(acc, r.hostUsage),
      undefined as UsageMetrics | undefined
    );

    return {
      timestamp: new Date().toISOString(),
      durationMs,
      environment: {
        ci: !!process.env.CI,
        node: process.version,
        platform: process.platform,
      },
      metrics: {
        total,
        passed,
        failed,
        passRate: passed / total,
        datasetBreakdown,
        expectationBreakdown,
        totalHostUsage,
      },
      results: this.allResults,
      conformanceChecks:
        this.conformanceChecks.length > 0 ? this.conformanceChecks : undefined,
      serverCapabilities:
        this.serverCapabilities.length > 0
          ? this.serverCapabilities
          : undefined,
      variantExperiment: this.variantExperiment,
    };
  }

  private async loadHistoricalData(): Promise<Array<MCPEvalHistoricalSummary>> {
    const storeHistorical = await this.loadHistoricalDataFromStore();
    if (storeHistorical) {
      return storeHistorical;
    }

    try {
      const files = await readdir(this.config.outputDir);
      const runFiles = files
        .filter((f) => f.startsWith('run-') && f.endsWith('.json'))
        .sort()
        .slice(-(this.config.historyLimit - 1)); // Keep most recent, leave room for current run

      const historical: Array<MCPEvalHistoricalSummary> = [];

      for (const file of runFiles) {
        try {
          const content = await readFile(
            join(this.config.outputDir, file),
            'utf-8'
          );
          const runData = JSON.parse(content) as MCPEvalRunData;

          historical.push({
            timestamp: runData.timestamp,
            total: runData.metrics.total,
            passed: runData.metrics.passed,
            failed: runData.metrics.failed,
            passRate: runData.metrics.passRate,
            durationMs: runData.durationMs,
          });
        } catch (error) {
          this.logError(`[MCP Reporter] Failed to load ${file}:`, error);
        }
      }

      return historical;
    } catch {
      return [];
    }
  }

  private async saveRunData(runData: MCPEvalRunData): Promise<void> {
    const filename = `run-${runData.timestamp.replace(/:/g, '-')}.json`;
    const filepath = join(this.config.outputDir, filename);

    await writeFile(filepath, JSON.stringify(runData, null, 2), 'utf-8');
  }

  private async saveRunDataToStore(runData: MCPEvalRunData): Promise<void> {
    if (!this.config.resultStore) {
      return;
    }

    try {
      const store = resolveEvalResultStore(this.config.resultStore);
      await store.saveArtifact(
        createStoredEvalArtifact({
          kind: 'reporter-run',
          id: this.config.runId,
          data: this.config.redactStoredResponses
            ? redactResponses(runData)
            : runData,
          metadata: {
            ...(this.config.runMetadata ?? {}),
          },
        })
      );
    } catch (error) {
      this.logError(
        '[MCP Reporter] Failed to save run to result store:',
        error
      );
    }
  }

  private async loadHistoricalDataFromStore(): Promise<Array<MCPEvalHistoricalSummary> | null> {
    if (!this.config.resultStore) {
      return null;
    }

    try {
      const store = resolveEvalResultStore(this.config.resultStore);
      const summaries = await store.listArtifacts('reporter-run', {
        limit: this.config.historyLimit - 1,
      });

      const historical: Array<MCPEvalHistoricalSummary> = [];
      for (const summary of summaries.reverse()) {
        const artifact = await store.loadArtifact<MCPEvalRunData>(
          'reporter-run',
          summary.id
        );
        historical.push(toHistoricalSummary(artifact.data));
      }
      return historical;
    } catch (error) {
      this.logError(
        '[MCP Reporter] Failed to load history from result store:',
        error
      );
      return null;
    }
  }

  private async cleanupOldRuns(): Promise<void> {
    try {
      const files = await readdir(this.config.outputDir);
      const runFiles = files
        .filter((f) => f.startsWith('run-') && f.endsWith('.json'))
        .sort()
        .reverse();

      // Keep only historyLimit most recent runs
      const toDelete = runFiles.slice(this.config.historyLimit);

      for (const file of toDelete) {
        await unlink(join(this.config.outputDir, file));
      }
    } catch (error) {
      this.logError('[MCP Reporter] Failed to cleanup old runs:', error);
    }
  }

  private async openReport(reportPath: string): Promise<void> {
    try {
      // Dynamic import to avoid bundling issues
      const { default: open } = await import('open');
      const absolutePath = resolve(reportPath);

      await open(absolutePath);
      this.log('[MCP Reporter] Opened report in browser');
    } catch (error) {
      this.logError('[MCP Reporter] Failed to open report:', error);
      this.log(`[MCP Reporter] Open manually: file://${resolve(reportPath)}`);
    }
  }
}

/** Why a test didn't pass, from Playwright's error, without terminal colours. */
function testFailure(result: TestResult): string {
  const message = result.error?.message ?? result.errors[0]?.message;
  return message ? stripVTControlCharacters(message) : `Test ${result.status}`;
}

/** An auto-tracked fixture call, reported as a test result. */
function autoTrackedResult(
  test: TestCase,
  result: TestResult,
  call: ToolCallPayload
): EvalCaseResult {
  const passed = result.status === 'passed';
  return {
    id: test.title,
    datasetName: test.parent?.title || 'Uncategorized Tests',
    toolName: call.toolName,
    source: 'test',
    pass: passed,
    request: { args: call.args },
    response: call.result,
    error: passed ? undefined : testFailure(result),
    expectations: {},
    authType: call.authType,
    project: call.project,
    durationMs: call.durationMs,
  };
}

function toHistoricalSummary(
  runData: MCPEvalRunData
): MCPEvalHistoricalSummary {
  return {
    timestamp: runData.timestamp,
    total: runData.metrics.total,
    passed: runData.metrics.passed,
    failed: runData.metrics.failed,
    passRate: runData.metrics.passRate,
    durationMs: runData.durationMs,
  };
}

function redactResponses<T>(value: T): T {
  return JSON.parse(
    JSON.stringify(value, (key, currentValue: unknown) =>
      key === 'response' ? undefined : currentValue
    )
  ) as T;
}
