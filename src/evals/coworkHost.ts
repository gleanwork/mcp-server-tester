import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type {
  HostDefinition,
  HostBatchRequest,
  HostRunContext,
  HostRunResult,
} from './evalFrameworkTypes.js';
import type { ExternalHostConfig } from './externalHost/types.js';
import { CLAUDE_COWORK_DESKTOP_MACOS_DRIVER } from './externalHost/driverIdentity.js';
import {
  getClaudeDataDir,
  snapshotClaudeSessions,
  waitForClaudeTrace,
} from './externalHost/builtins/anthropicClaude.js';
import {
  runAnthropicComputerUseSubmission,
  runAnthropicComputerUseHitl,
} from './externalHost/builtins/anthropicComputerUse.js';
import { prepareMacCoworkSession } from './coworkSetup/macSession.js';
import { recoverMacCoworkSession } from './coworkSetup/recoverSession.js';
import { normalizeCorrelation } from './externalHost/runtime.js';
import { simulationToHostTrace } from './hostTrace.js';

const OptionsSchema = z
  .object({
    computerUseProvider: z
      .literal('anthropic-computer-use')
      .default('anthropic-computer-use'),
    computerUseMaxActions: z.number().int().min(1).max(64).default(24),
    hitlMaxActions: z.number().int().min(1).max(24).default(12),
    dataDir: z.string().min(1).optional(),
  })
  .strict();
const CoworkSchema = z
  .object({
    type: z.string(),
    options: OptionsSchema.default(() => OptionsSchema.parse({})),
    timeout: z.number().int().positive().default(900_000),
    model: z.string().optional(),
    provider: z.string().optional(),
    env: z.record(z.string(), z.string()).optional(),
  })
  .strict();
let active = false;
const failure = (error: string): HostRunResult => ({
  finalText: '',
  events: [],
  error,
});

/** Shared desktop, one managed transaction, then ordinary V2 trace evaluation. */
async function runBatch(
  requests: HostBatchRequest[],
  context: HostRunContext
): Promise<HostRunResult[]> {
  if (!requests.length) return [];
  if (active)
    throw new Error(
      'Cowork desktop is already in use by another batch. Run with --workers 1.'
    );
  const configs = requests.map((r) => CoworkSchema.parse(r.config));
  if (requests.some((r) => !r.input.scenario.trim()))
    throw new Error('Cowork cases require a non-empty scenario.');
  if (configs.some((c) => JSON.stringify(c) !== JSON.stringify(configs[0])))
    throw new Error(
      'Cowork batch requires identical host settings for all cases.'
    );
  const config = configs[0]!;
  const env = { ...process.env, ...context.env, ...config.env };
  if (!env.ANTHROPIC_API_KEY)
    throw new Error('ANTHROPIC_API_KEY is required for Cowork Computer Use.');
  const external: ExternalHostConfig = {
    driver: CLAUDE_COWORK_DESKTOP_MACOS_DRIVER,
    options: config.options,
  };
  const dataDir = getClaudeDataDir(external);
  const servers = requests[0]!.input.servers;
  // Pass only the selected arm. Setup intentionally rejects multi-arm manifests.
  const { arms: _arms, ...manifest } = context.manifest;
  const managedManifest = { ...manifest, servers };
  let session: Awaited<ReturnType<typeof prepareMacCoworkSession>> | undefined;
  const results = requests.map(() =>
    failure('Cowork submission was not attempted.')
  );
  const submitted: Array<{
    index: number;
    marker: string;
    startedAtMs: number;
    deadlineAt: number;
  }> = [];
  const safeError = (error: unknown): string => {
    let text =
      error instanceof Error ? error.message : 'Cowork operation failed.';
    const secrets = Object.entries(env)
      .filter(
        ([k, v]) => /token|key|secret|password|authorization/i.test(k) && v
      )
      .map(([, v]) => v!);
    for (const server of servers)
      if (server.transport !== 'stdio') {
        if (server.auth?.accessToken) secrets.push(server.auth.accessToken);
        for (const value of Object.values(server.headers ?? {}))
          secrets.push(value);
      }
    for (const secret of secrets) text = text.split(secret).join('[REDACTED]');
    return text;
  };
  active = true;
  try {
    if (env.MST_COWORK_RECOVER === '1') await recoverMacCoworkSession();
    if (servers.length)
      session = await prepareMacCoworkSession({
        manifest: managedManifest,
        env,
      });
    const snapshot = await snapshotClaudeSessions(dataDir);
    process.stderr.write(
      `[mst:cowork] batch phase 1/3: submitting ${requests.length} case iteration(s)\n`
    );
    for (const [index, request] of requests.entries()) {
      const marker = `MCP_SERVER_TESTER_${randomUUID()}`;
      const startedAtMs = Date.now();
      const deadlineAt = startedAtMs + config.timeout;
      try {
        await runAnthropicComputerUseSubmission(
          `${request.input.scenario}\n\n[${marker}]`,
          { deadlineAt, maxActions: config.options.computerUseMaxActions, env }
        );
        submitted.push({ index, marker, startedAtMs, deadlineAt });
      } catch (error) {
        results[index] = failure(safeError(error));
        for (let n = index + 1; n < requests.length; n++)
          results[n] = failure(
            'Not submitted because a previous UI submission failed or was ambiguous. No retries were attempted.'
          );
        break;
      }
    }
    process.stderr.write('[mst:cowork] batch phase 2/3: bounded HITL checks\n');
    for (const run of submitted) {
      try {
        await runAnthropicComputerUseHitl({
          deadlineAt: run.deadlineAt,
          maxActions: config.options.hitlMaxActions,
          env,
          task: `Find the already submitted Cowork task containing marker ${run.marker}. Its query was: ${requests[run.index]!.input.scenario}. Never create or resubmit a task.`,
        });
      } catch (error) {
        results[run.index] = failure(safeError(error));
      }
    }
    process.stderr.write(
      '[mst:cowork] batch phase 3/3: collecting native Claude telemetry\n'
    );
    const usedSessions = new Set<string>();
    for (const run of submitted) {
      try {
        const remaining = run.deadlineAt - Date.now();
        if (remaining <= 0)
          throw new Error(
            'Native Claude trace deadline exceeded. No resubmission attempted.'
          );
        const trace = await waitForClaudeTrace({
          dataDir,
          marker: run.marker,
          correlation: normalizeCorrelation(
            { strategy: 'prompt_marker', includeInPrompt: true },
            run.marker
          ),
          snapshot,
          timeoutMs: remaining,
          startedAtMs: run.startedAtMs,
        });
        if (usedSessions.has(trace.candidate.metadataPath))
          throw new Error(
            'Native session matched more than one case; refusing duplicate attribution.'
          );
        usedSessions.add(trace.candidate.metadataPath);
        const result = simulationToHostTrace(
          {
            success: !trace.isError && trace.finalAnswer !== undefined,
            response: trace.finalAnswer,
            toolCalls: trace.toolCalls,
            usage: trace.usage,
            error: trace.isError
              ? 'Native Claude task failed.'
              : trace.finalAnswer === undefined
                ? 'Native trace has no final answer.'
                : undefined,
          },
          servers
        );
        results[run.index] = {
          ...result,
          telemetry: { source: 'claude-native', ...trace.telemetry },
          llmDurationMs: trace.llmDurationMs,
        };
      } catch (error) {
        results[run.index] = failure(safeError(error));
      }
    }
    return results;
  } finally {
    try {
      await session?.dispose();
    } finally {
      active = false;
    }
  }
}

export const COWORK_HOST: HostDefinition = {
  name: 'cowork_cu',
  schema: CoworkSchema,
  evidence: 'structured',
  runBatch,
  run: async (input, config, context) =>
    (
      await runBatch(
        [{ caseId: 'single', iteration: 0, input, config }],
        context
      )
    )[0]!,
};
