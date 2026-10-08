import type {
  Reporter,
  FullConfig,
  Suite,
  TestCase,
  TestResult,
  FullResult,
} from '@playwright/test/reporter';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import type {
  EvalCaseResult,
  MCPEvalReporterConfig,
  MCPToolOptimizationData,
} from '../types/reporter.js';
import type { UsageMetrics } from '../types/index.js';
import { sumUsage } from '../utils/usageUtils.js';
import {
  parseReporterAttachment,
  reporterAttachmentKind,
  type ReporterAttachment,
} from './channel.js';
import {
  createStoredEvalArtifact,
  resolveEvalResultStore,
  REDACT_STORED_RESPONSES_BY_DEFAULT,
  redactStoredResponses,
} from '../evals/resultStore.js';
import type {
  EvaluationSummary,
  EvaluationVariantResult,
} from '../evals/evalFrameworkTypes.js';
import { RUN_FORMAT } from '../evals/resultFormat.js';
import {
  assertUniqueVariantNames,
  newRunId,
  runsDirectory,
  writeLatest,
  writeRun,
} from '../evals/runFormat.js';
import { buildVariantDeltas } from '../evals/variantDeltas.js';
import { writeRunReport } from '../evals/runReport.js';
import { CORE_METRICS, computeMetrics } from '../evals/metrics.js';
import { compareWithPrevious, findPreviousRun } from '../evals/runBaseline.js';
import packageJson from '../../package.json' with { type: 'json' };

/** Options the reporter no longer takes, and what to do instead. */
const REMOVED_OPTIONS: Record<string, string> = {
  historyLimit:
    'Runs are kept as run directories under `<outputDir>/<name>/runs/`; delete old ones yourself.',
  includeAutoTracking:
    "The MCP reporter reports evals only. Direct tool calls in tests are in Playwright's own report.",
  runId: 'Run IDs are generated (`20261007T182504Z-7f3c2a`).',
};

function assertNoRemovedOptions(options: object): void {
  for (const [key, guidance] of Object.entries(REMOVED_OPTIONS))
    if (key in options)
      throw new Error(
        `MCP reporter option \`${key}\` was removed. ${guidance}`
      );
}

interface ServerRecord {
  label?: string;
  transport?: string;
  command?: string;
  serverUrl?: string;
}

/** A project's MCP server, with nothing that can hold a credential. */
function serverRecord(mcpConfig: unknown): ServerRecord | undefined {
  if (!mcpConfig || typeof mcpConfig !== 'object') return undefined;
  const config = mcpConfig as Record<string, unknown>;
  const record: ServerRecord = {};
  if (typeof config.label === 'string') record.label = config.label;
  if (typeof config.transport === 'string') record.transport = config.transport;
  if (typeof config.command === 'string') record.command = config.command;
  if (typeof config.serverUrl === 'string') {
    try {
      const url = new URL(config.serverUrl);
      record.serverUrl = `${url.origin}${url.pathname}`;
    } catch {
      // Not a URL: leave it out.
    }
  }
  return record;
}

/**
 * Playwright reporter for MCP evals. Each test run's eval results are one
 * run in the `mst.run/v1` format, with a variant per Playwright project,
 * and the same report `mst run` writes: `mst open` opens it.
 *
 * Only evals are reported. Tests, auto-tracked tool calls and conformance
 * checks are Playwright tests: their results and attachments are in
 * Playwright's own reporter.
 *
 * @example
 * ```typescript
 * // playwright.config.ts
 * export default defineConfig({
 *   reporter: [
 *     ['list'],
 *     ['@gleanwork/mcp-server-tester/reporters/mcpReporter', { name: 'my-server' }],
 *   ],
 * });
 * ```
 */
export default class MCPReporter implements Reporter {
  private readonly outputDir: string;
  private readonly name: string;
  private readonly options: MCPEvalReporterConfig;
  private startTime = 0;
  /** Each project's server, in config order: the first is the baseline. */
  private projects = new Map<string, ServerRecord | undefined>();
  /** Each test's eval results, by test ID: a retry replaces the earlier attempt. */
  private results = new Map<
    string,
    { project: string; caseResults: EvalCaseResult[] }
  >();
  /** Each test's tool optimization, by test ID. */
  private optimizations = new Map<string, MCPToolOptimizationData>();
  /** `1/3` when Playwright runs this shard of the tests. */
  private shard: string | undefined;

  constructor(options: MCPEvalReporterConfig = {}) {
    assertNoRemovedOptions(options);
    this.options = options;
    this.outputDir = path.resolve(options.outputDir ?? '.mcp-test-results');
    this.name = options.name ?? 'playwright';
  }

  private log(message: string): void {
    if (!this.options.quiet) console.log(message);
  }

  /** Errors are logged even when quiet: a run that wasn't written must say so. */
  private logError(message: string, error?: unknown): void {
    console.error(message, error ?? '');
  }

  /**
   * Reads attachment content from either the in-memory body or the file
   * Playwright wrote it to.
   */
  private async content(attachment: {
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

  onBegin(config: FullConfig, _suite: Suite): void {
    this.startTime = Date.now();
    for (const project of config.projects)
      this.projects.set(
        projectName(project.name),
        serverRecord((project.use as { mcpConfig?: unknown }).mcpConfig)
      );
    if (config.shard)
      this.shard = `${config.shard.current}/${config.shard.total}`;
  }

  async onTestEnd(test: TestCase, result: TestResult): Promise<void> {
    const received: ReporterAttachment[] = [];
    for (const attachment of result.attachments) {
      const kind = reporterAttachmentKind(attachment);
      if (kind !== 'evalResults' && kind !== 'toolOptimization') continue;
      const content = await this.content(attachment);
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
    const project = projectName(test.parent.project()?.name);
    const caseResults: EvalCaseResult[] = [];
    for (const attachment of received) {
      if (attachment.kind === 'evalResults')
        caseResults.push(
          ...attachment.data.caseResults.map((caseResult) => ({
            ...caseResult,
            variant: project,
          }))
        );
      else if (attachment.kind === 'toolOptimization')
        this.optimizations.set(test.id, attachment.data);
    }
    // The last attempt is the result: a retry replaces the one before.
    if (caseResults.length) this.results.set(test.id, { project, caseResults });
    else this.results.delete(test.id);
  }

  /** Case results by project, projects in config order. */
  private byProject(): Map<string, EvalCaseResult[]> {
    const grouped = new Map<string, EvalCaseResult[]>();
    for (const name of this.projects.keys()) grouped.set(name, []);
    for (const { project, caseResults } of this.results.values())
      grouped.set(project, [...(grouped.get(project) ?? []), ...caseResults]);
    for (const [name, list] of grouped)
      if (list.length === 0) grouped.delete(name);
    return grouped;
  }

  async onEnd(_result: FullResult): Promise<void> {
    if (this.results.size === 0 && this.optimizations.size === 0) {
      this.log(
        "[MCP Reporter] No eval results in this run. Tests and conformance checks are in Playwright's own report."
      );
      return;
    }
    try {
      await this.writeRun();
    } catch (error) {
      this.logError("[MCP Reporter] The run's report wasn't written:", error);
    }
  }

  private summarize(runId: string, timestamp: string): EvaluationSummary {
    const projects = this.byProject();
    assertUniqueVariantNames([...projects.keys()]);
    for (const [name, list] of projects) assertUniqueCases(name, list);
    const toolOptimization = [...this.optimizations.values()].at(-1);
    const variants: EvaluationVariantResult[] = [...projects].map(
      ([name, caseResults]) => {
        const totalClientUsage = caseResults.reduce(
          (sum, result) => sumUsage(sum, result.clientUsage),
          undefined as UsageMetrics | undefined
        );
        const server = this.projects.get(name);
        return {
          name,
          servers: server ? [server as never] : [],
          result: {
            caseResults,
            total: caseResults.length,
            passed: caseResults.filter((result) => result.pass).length,
            failed: caseResults.filter((result) => !result.pass).length,
            durationMs: caseResults.reduce(
              (sum, result) => sum + (result.durationMs ?? 0),
              0
            ),
            ...(totalClientUsage ? { totalClientUsage } : {}),
          },
          metrics: computeMetrics([...CORE_METRICS], caseResults).aggregated,
        };
      }
    );
    const cases = variants.flatMap((variant) => variant.result!.caseResults);
    // A Playwright eval is identified by the reporter's name and its cases.
    const configId = `playwright:${this.name}`;
    const contentHash = createHash('sha256')
      .update(
        JSON.stringify(
          [
            ...new Set(cases.map((c) => `${c.datasetName ?? ''}/${c.id}`)),
          ].sort()
        )
      )
      .digest('hex');
    const selection = this.shard ? { shard: this.shard } : undefined;
    return {
      format: RUN_FORMAT,
      runId,
      // A shard is part of a run: compared only with the same shard, and
      // never the eval's latest.
      partial: selection !== undefined,
      ...(selection
        ? {
            selection,
            selectionHash: createHash('sha256')
              .update(JSON.stringify(selection))
              .digest('hex'),
          }
        : {}),
      configId,
      contentHash,
      timestamp,
      durationMs: Date.now() - this.startTime,
      configName: this.name,
      variants,
      // Like runEval: every case's totals, then the baseline's metrics.
      metrics: {
        total: cases.length,
        passed: cases.filter((c) => c.pass).length,
        failed: cases.filter((c) => !c.pass).length,
        passRate: cases.length
          ? cases.filter((c) => c.pass).length / cases.length
          : 0,
        ...(variants[0]?.metrics ?? {}),
      },
      variantDeltas: buildVariantDeltas(variants),
      results: cases,
      ...(toolOptimization ? { toolOptimization } : {}),
    } as EvaluationSummary;
  }

  private async writeRun(): Promise<void> {
    const started = new Date(this.startTime);
    const runId = newRunId(started);
    const evalDirectory = path.join(this.outputDir, this.name);
    const runDirectory = path.join(runsDirectory(evalDirectory), runId);
    const timestamp = new Date().toISOString();
    const summary = this.summarize(runId, timestamp);
    const store = this.options.resultStore
      ? resolveEvalResultStore(this.options.resultStore)
      : undefined;
    try {
      const previous = await findPreviousRun({
        configId: summary.configId,
        runId,
        variants: summary.variants.map((variant) => variant.name),
        partial: summary.partial,
        selectionHash: summary.selectionHash,
        store,
        outputRoot: runsDirectory(evalDirectory),
      });
      if (previous)
        summary.previousRun = compareWithPrevious(previous, summary);
    } catch (error) {
      this.logError(
        "[MCP Reporter] Couldn't compare with the previous run:",
        error
      );
    }
    const redact =
      this.options.redactStoredResponses ?? REDACT_STORED_RESPONSES_BY_DEFAULT;
    const stored = redact
      ? redactStoredResponses(summary)
      : structuredClone(summary);

    await writeRun(
      runDirectory,
      runId,
      {
        evalName: this.name,
        createdAt: started.toISOString(),
        finishedAt: timestamp,
        mstVersion: packageJson.version,
        baseline: summary.variants[0]?.name ?? 'default',
        variants: summary.variants.map((variant) => ({
          name: variant.name,
          servers: variant.servers,
        })),
        datasets: [
          ...new Set(summary.results.map((c) => c.datasetName ?? 'default')),
        ].map((name) => {
          const ids = summary.results
            .filter((c) => (c.datasetName ?? 'default') === name)
            .map((c) => c.id);
          return {
            name,
            caseCount: new Set(ids).size,
            contentHash: createHash('sha256')
              .update(JSON.stringify([...new Set(ids)].sort()))
              .digest('hex'),
          };
        }),
        redactStoredResponses: redact,
      },
      stored
    );
    const report = await writeRunReport(runDirectory);
    if (!summary.partial) await writeLatest(evalDirectory, runId, timestamp);
    // After the local run, so a store never has a run the directory lacks.
    if (store) {
      try {
        await store.saveArtifact(
          createStoredEvalArtifact({
            kind: 'eval-run-summary',
            id: runId,
            data: stored,
            metadata: {
              ...(this.options.runMetadata ?? {}),
              datasetName: this.name,
              packageVersion: packageJson.version,
              labels: {
                configId: summary.configId,
                contentHash: summary.contentHash,
                ...(summary.partial
                  ? { partial: 'true', selectionHash: summary.selectionHash! }
                  : {}),
              },
            },
            createdAt: timestamp,
          })
        );
      } catch (error) {
        this.logError(
          '[MCP Reporter] Failed to save run to result store:',
          error
        );
      }
    }

    const passed = summary.results.filter((c) => c.pass).length;
    this.log(`\n[MCP Reporter] Report: ${report}`);
    if (summary.results.length)
      this.log(
        `[MCP Reporter] ${passed}/${summary.results.length} eval cases passed across ${summary.variants.length} ${summary.variants.length === 1 ? 'project' : 'projects'}. Open it with \`mst open${summary.partial ? ` ${runDirectory}` : ''}\`.`
      );
    if (this.options.autoOpen && !process.env.CI) {
      try {
        const { default: open } = await import('open');
        await open(report);
      } catch (error) {
        this.logError('[MCP Reporter] Failed to open report:', error);
      }
    }
  }
}

/** Playwright's unnamed default project is the `default` variant. */
function projectName(name: string | undefined): string {
  return name || 'default';
}

/**
 * A project's case IDs name its trace and score paths, so they must differ,
 * and in more than case: two tests running the same dataset, or one ID in
 * two datasets, would overwrite each other's results.
 */
function assertUniqueCases(project: string, results: EvalCaseResult[]): void {
  const seen = new Map<string, EvalCaseResult>();
  for (const result of results) {
    const key = result.id.toLowerCase();
    const other = seen.get(key);
    if (other)
      throw new Error(
        `Project "${project}" has case "${result.id}" twice (datasets "${other.datasetName ?? 'default'}" and "${result.datasetName ?? 'default'}"). Give each case a unique ID, or run each dataset in one test.`
      );
    seen.set(key, result);
  }
}
