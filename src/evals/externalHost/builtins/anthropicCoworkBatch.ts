import { randomUUID } from 'node:crypto';
import {
  getClaudeDataDir,
  normalizeClaudeTraceForRun,
  snapshotClaudeSessions,
  waitForClaudeTrace,
} from './anthropicClaude.js';
import {
  runAnthropicComputerUseHitl,
  runAnthropicComputerUseSubmission,
} from './anthropicComputerUse.js';
import { formatSubmittedScenario, normalizeCorrelation } from '../runtime.js';
import { loadExternalHostConfig } from '../capabilityRuntime.js';
import type {
  ExternalHostConfig,
  ExternalHostRunResult,
  HostRunContext,
} from '../types.js';

export async function runAnthropicCoworkBatch(
  queries: string[],
  config: ExternalHostConfig
): Promise<ExternalHostRunResult[]> {
  const loaded = await loadExternalHostConfig(config);
  const dataDir = getClaudeDataDir(loaded.config);
  const snapshot = await snapshotClaudeSessions(dataDir);
  const timeoutMs = loaded.config.timeoutMs ?? 120_000;
  const runs: Array<{
    context: HostRunContext;
    submittedScenario: string;
  }> = [];

  process.stderr.write(
    `[mst:run] batch phase 1/3: submitting ${queries.length} query(s)\n`
  );
  for (const [index, scenario] of queries.entries()) {
    const runId = `config-run-${index + 1}-${randomUUID()}`;
    const marker = `MCP_SERVER_TESTER_${runId}`;
    const correlation = normalizeCorrelation(loaded.config.correlation, marker);
    const startedAtMs = Date.now();
    const context: HostRunContext = {
      runId,
      caseId: `config-run-${index + 1}`,
      scenario,
      submittedScenario: formatSubmittedScenario(
        scenario,
        marker,
        loaded.config.correlation
      ),
      marker,
      correlation,
      timeoutMs,
      startedAtMs,
    };
    await runAnthropicComputerUseSubmission(context.submittedScenario, {
      deadlineAt: startedAtMs + timeoutMs,
    });
    runs.push({ context, submittedScenario: context.submittedScenario });
    process.stderr.write(
      `[mst:run] submitted query ${index + 1}/${queries.length}\n`
    );
  }

  process.stderr.write(
    `[mst:run] batch phase 2/3: checking HITL for ${runs.length} submitted query(s)\n`
  );
  for (const [index, run] of runs.entries()) {
    await runAnthropicComputerUseHitl({
      deadlineAt: run.context.startedAtMs + run.context.timeoutMs,
    });
    process.stderr.write(
      `[mst:run] HITL checked for query ${index + 1}/${runs.length}\n`
    );
  }

  process.stderr.write(
    `[mst:run] batch phase 3/3: collecting native Claude telemetry\n`
  );
  const results: ExternalHostRunResult[] = [];
  for (const [index, run] of runs.entries()) {
    const trace = await waitForClaudeTrace({
      dataDir,
      marker: run.context.marker,
      correlation: run.context.correlation,
      snapshot,
      timeoutMs: Math.max(
        1,
        Math.min(
          run.context.timeoutMs,
          run.context.startedAtMs + run.context.timeoutMs - Date.now()
        )
      ),
      startedAtMs: run.context.startedAtMs,
    });
    const result = await normalizeClaudeTraceForRun({
      config: loaded.config,
      context: run.context,
      driver: loaded.driver,
      displayName: loaded.displayName,
      capabilitiesUsed: loaded.capabilitiesUsed,
      trace,
    });
    results.push(result);
    process.stderr.write(
      `[mst:run] native telemetry collected for query ${index + 1}/${runs.length}\n`
    );
  }
  return results;
}
