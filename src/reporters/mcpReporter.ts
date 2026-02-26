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
import type { MCPEvalReporterConfig } from './types.js';
import type { AuthType } from '../types/index.js';
import type {
  MCPEvalRunData,
  MCPEvalHistoricalSummary,
  MCPConformanceResultData,
  MCPServerCapabilitiesData,
  EvalCaseResult,
} from '../types/reporter.js';
import type { MCPConformanceCheck } from '../spec/conformanceChecks.js';

/**
 * Custom Playwright reporter for MCP eval results
 *
 * Generates HTML reports with historical tracking and auto-opens in browser
 *
 * @example
 * ```typescript
 * // playwright.config.ts
 * export default defineConfig({
 *   reporter: [
 *     ['@gleanwork/mcp-server-tester/reporters/mcpReporter', {
 *       outputDir: '.mcp-test-results',
 *       autoOpen: true,
 *       historyLimit: 10
 *     }]
 *   ]
 * });
 * ```
 */
export default class MCPReporter implements Reporter {
  private config: Required<MCPEvalReporterConfig>;
  private startTime: number = 0;
  private allResults: Array<EvalCaseResult> = [];
  private conformanceChecks: Array<MCPConformanceResultData> = [];
  private serverCapabilities: Array<MCPServerCapabilitiesData> = [];

  constructor(options: MCPEvalReporterConfig = {}) {
    this.config = {
      outputDir: options.outputDir ?? '.mcp-test-results',
      autoOpen: options.autoOpen ?? true,
      historyLimit: options.historyLimit ?? 10,
      quiet: options.quiet ?? false,
      includeAutoTracking: options.includeAutoTracking ?? true,
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
    // Strategy 1: Extract MCP eval results from runEvalDataset() attachments
    const evalAttachment = result.attachments.find(
      (a) =>
        a.name === 'mcp-test-results' && a.contentType === 'application/json'
    );

    let hasEvalDataset = false;

    const evalContent = evalAttachment
      ? await this.getAttachmentContent(evalAttachment)
      : null;
    if (evalContent) {
      try {
        const evalResults = JSON.parse(evalContent) as {
          caseResults: Array<EvalCaseResult>;
        };

        // Trust the data from the attachment - evalRunner now includes
        // authType and project from the mcp fixture (Playwright is source of truth)
        this.allResults.push(...evalResults.caseResults);
        hasEvalDataset = true;
      } catch (error) {
        this.logError(
          `[MCP Reporter] Failed to parse eval results from test "${test.title}":`,
          error
        );
      }
    }

    // Strategy 2: Extract conformance check results
    // These are created by runConformanceChecks() when testInfo is passed
    const conformanceAttachment = result.attachments.find(
      (a) =>
        a.name === 'mcp-conformance-checks' &&
        a.contentType === 'application/json'
    );

    const conformanceContent = conformanceAttachment
      ? await this.getAttachmentContent(conformanceAttachment)
      : null;
    if (conformanceContent) {
      try {
        const conformanceData = JSON.parse(conformanceContent) as {
          operation: string;
          pass: boolean;
          checks: MCPConformanceCheck[];
          serverInfo?: { name?: string; version?: string };
          toolCount: number;
          authType?: AuthType;
          project?: string;
        };

        // Only push if checks array is valid
        if (Array.isArray(conformanceData.checks)) {
          this.conformanceChecks.push({
            testTitle: test.title,
            pass: conformanceData.pass,
            checks: conformanceData.checks,
            serverInfo: conformanceData.serverInfo,
            toolCount: conformanceData.toolCount,
            authType: conformanceData.authType,
            project: conformanceData.project,
          });
        }
      } catch (error) {
        this.logError(
          `[MCP Reporter] Failed to parse conformance check attachment for "${test.title}":`,
          error
        );
      }
    }

    // Strategy 2b: Extract server capabilities from mcp-list-tools attachments
    // These are created by createMCPFixture().listTools()
    const listToolsAttachment = result.attachments.find(
      (a) => a.name === 'mcp-list-tools' && a.contentType === 'application/json'
    );

    const listToolsContent = listToolsAttachment
      ? await this.getAttachmentContent(listToolsAttachment)
      : null;
    if (listToolsContent) {
      try {
        const listToolsData = JSON.parse(listToolsContent) as {
          operation: string;
          toolCount: number;
          tools: Array<{ name: string; description?: string }>;
        };

        // Only push if tools array is valid
        if (Array.isArray(listToolsData.tools)) {
          this.serverCapabilities.push({
            testTitle: test.title,
            tools: listToolsData.tools,
            toolCount: listToolsData.toolCount,
            // Note: authType and project are available from the mcp fixture
            // but not currently included in the listTools attachment
          });
        }
      } catch (error) {
        this.logError(
          `[MCP Reporter] Failed to parse mcp-list-tools attachment for "${test.title}":`,
          error
        );
      }
    }

    // Strategy 3: Extract MCP tool calls from auto-tracking attachments
    // These are created by createMCPFixture()
    // Skip if:
    // - This test already has eval dataset results (to avoid duplicates)
    // - Auto-tracking is disabled in config
    if (hasEvalDataset || !this.config.includeAutoTracking) {
      return;
    }

    const mcpCallAttachments = result.attachments.filter(
      (a) =>
        a.name &&
        a.name.startsWith('mcp-call-') &&
        a.contentType === 'application/json'
    );

    for (const attachment of mcpCallAttachments) {
      const callContent = await this.getAttachmentContent(attachment);
      if (!callContent) continue;

      try {
        // Attachment now includes authType and project from the mcp fixture
        const callData = JSON.parse(callContent) as {
          operation: string;
          toolName: string;
          args: Record<string, unknown>;
          result: unknown;
          durationMs: number;
          isError: boolean;
          authType?: AuthType;
          project?: string;
        };

        const suiteName = test.parent?.title || 'Uncategorized Tests';
        const testPassed = result.status === 'passed';

        const syntheticResult: EvalCaseResult = {
          id: test.title,
          datasetName: suiteName,
          toolName: callData.toolName,
          source: 'test',
          pass: testPassed,
          response: callData.result,
          error: !testPassed ? 'Test failed' : undefined,
          expectations: {},
          authType: callData.authType,
          project: callData.project,
          durationMs: callData.durationMs,
        };

        this.allResults.push(syntheticResult);
      } catch (error) {
        this.logError(
          `[MCP Reporter] Failed to parse MCP call attachment "${attachment.name}":`,
          error
        );
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
      },
      results: this.allResults,
      conformanceChecks:
        this.conformanceChecks.length > 0 ? this.conformanceChecks : undefined,
      serverCapabilities:
        this.serverCapabilities.length > 0
          ? this.serverCapabilities
          : undefined,
    };
  }

  private async loadHistoricalData(): Promise<Array<MCPEvalHistoricalSummary>> {
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
