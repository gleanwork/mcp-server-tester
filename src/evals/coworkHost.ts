import { z } from 'zod';
import type {
  HostDefinition,
  HostBatchRequest,
  HostRunContext,
  HostRunResult,
} from './evalFrameworkTypes.js';
import { getCoworkPlatform, type CoworkPlatform } from './cowork/platform.js';
import {
  findMatchingClaudeSessions,
  snapshotClaudeSessions,
  waitForClaudeTrace,
  waitForClaudeSession,
} from './externalHost/builtins/anthropicClaude.js';
import { simulationToHostTrace } from './hostTrace.js';
import { ComputerUseHitlBudgetError } from './externalHost/builtins/anthropicComputerUse.js';

const OptionsSchema = z
  .object({
    computerUseProvider: z
      .literal('anthropic-computer-use')
      .default('anthropic-computer-use'),
    computerUseMaxActions: z.number().int().min(1).max(64).default(24),
    hitlMaxActions: z.number().int().min(1).max(24).default(12),
    computerUseModel: z
      .string()
      .regex(/^[A-Za-z0-9._:-]+$/)
      .optional(),
    dataDir: z.string().min(1).optional(),
  })
  .strict();
const CoworkSchema = z
  .object({
    type: z.string(),
    options: OptionsSchema.default(() => OptionsSchema.parse({})),
    timeout: z.number().int().positive().default(900_000),
    model: z
      .string()
      .regex(/^[A-Za-z0-9._:-]+$/)
      .optional(),
    provider: z.literal('anthropic').optional(),
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
  context: HostRunContext,
  selectedPlatform?: CoworkPlatform
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
  const platform = selectedPlatform ?? (await getCoworkPlatform());
  const dataDir = platform.dataDirectory(config.options);
  const servers = requests[0]!.input.servers;
  // Pass only the selected arm. Setup intentionally rejects multi-arm manifests.
  const { arms: _arms, ...manifest } = context.manifest;
  const managedManifest = { ...manifest, servers };
  let session: Awaited<ReturnType<CoworkPlatform['prepare']>> | undefined;
  const results = requests.map(() =>
    failure('Cowork submission was not attempted.')
  );
  const hitlErrors = new Map<number, string>();
  const hitlWarnings = new Map<number, string>();
  const usedSessions = new Set<string>();
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
  // Platform loading above is asynchronous. Claim the desktop atomically after it.
  if (active)
    throw new Error(
      'Cowork desktop is already in use by another batch. Run with --workers 1.'
    );
  active = true;
  try {
    if (env.MST_COWORK_RECOVER === '1') await platform.recover();
    if (servers.length || config.model)
      session = await platform.prepare({
        manifest: managedManifest,
        env,
        model: config.model,
      });
    for (const [index, request] of requests.entries()) {
      // Bind each fresh task before another submission can create an identical prompt.
      const snapshot = await snapshotClaudeSessions(dataDir);
      const startedAtMs = Date.now();
      const deadlineAt = startedAtMs + config.timeout;
      const run = { index, startedAtMs, deadlineAt };
      let sessionPath: string;
      const match = {
        dataDir,
        exactPrompt: request.input.scenario,
        snapshot,
        startedAtMs,
      };
      process.stderr.write(
        `[mst:cowork] case ${index + 1}/${requests.length}: submitting unchanged prompt\n`
      );
      try {
        await platform.submit(request.input.scenario, {
          deadlineAt,
          maxActions: config.options.computerUseMaxActions,
          model: config.options.computerUseModel,
          env,
        });
        const bound = await waitForClaudeSession({
          ...match,
          timeoutMs: Math.max(0, Math.min(30_000, deadlineAt - Date.now())),
        });
        sessionPath = bound.candidate.metadataPath;
        if (usedSessions.has(sessionPath))
          throw new Error(
            'Native session matched more than one case; refusing duplicate attribution.'
          );
        usedSessions.add(sessionPath);
      } catch (error) {
        results[index] = failure(safeError(error));
        for (let n = index + 1; n < requests.length; n++)
          results[n] = failure(
            'Not submitted because a previous UI submission failed or was ambiguous. No retries were attempted.'
          );
        break;
      }
      process.stderr.write(
        '[mst:cowork] bounded HITL check for the bound native session\n'
      );
      try {
        const native = await findMatchingClaudeSessions({
          ...match,
          sessionPath,
        });
        if (native.length > 1)
          throw new Error(
            'Ambiguous native sessions; no HITL action attempted.'
          );
        if (!native.length)
          throw new Error(
            'Bound native session is missing; no HITL action attempted.'
          );
        if (native[0]?.isComplete) {
          process.stderr.write(
            `[mst:cowork] case ${run.index + 1} already completed; skipping HITL\n`
          );
        } else
          await platform.handleHitl({
            deadlineAt: run.deadlineAt,
            maxActions: config.options.hitlMaxActions,
            model: config.options.computerUseModel,
            env,
            task: `Handle only the currently open Cowork task just submitted with this exact query: ${request.input.scenario}. Do not switch tasks. Never create, type, or resubmit a task. If the current task cannot be identified uniquely, stop without an action.`,
          });
      } catch (error) {
        const message = safeError(error);
        if (error instanceof ComputerUseHitlBudgetError) {
          hitlWarnings.set(run.index, message);
        } else {
          hitlErrors.set(run.index, message);
          results[run.index] = failure(message);
        }
      }
      process.stderr.write(
        '[mst:cowork] collecting bound native Claude telemetry\n'
      );
      try {
        const remaining = run.deadlineAt - Date.now();
        if (remaining <= 0)
          throw new Error(
            'Native Claude trace deadline exceeded. No resubmission attempted.'
          );
        process.stderr.write(
          `[mst:cowork] collecting case ${run.index + 1}/${requests.length}\n`
        );
        const trace = await waitForClaudeTrace({
          ...match,
          sessionPath,
          timeoutMs: remaining,
        });
        if (trace.candidate.metadataPath !== sessionPath)
          throw new Error(
            'Native session identity changed; refusing attribution.'
          );
        process.stderr.write(
          `[mst:cowork] case ${run.index + 1}: native completion found (${trace.toolCalls.length} tool calls)\n`
        );
        if (config.model && !trace.telemetry.models.includes(config.model)) {
          throw new Error(
            `Cowork model mismatch: requested ${config.model}, observed ${trace.telemetry.models.join(', ') || 'unavailable'}.`
          );
        }
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
          error: result.error ?? hitlErrors.get(run.index),
          telemetry: {
            source: 'claude-native',
            ...trace.telemetry,
            nativeSessionId: trace.candidate.id,
            correlation: 'exact-initial-prompt',
            ...(hitlWarnings.has(run.index)
              ? { hitlWarning: hitlWarnings.get(run.index) }
              : {}),
          },
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

export function createCoworkHost(platform?: CoworkPlatform): HostDefinition {
  return {
    name: 'cowork_cu',
    schema: CoworkSchema,
    evidence: 'structured',
    runBatch: (requests, context) => runBatch(requests, context, platform),
    run: async (input, config, context) =>
      (
        await runBatch(
          [{ caseId: 'single', iteration: 0, input, config }],
          context,
          platform
        )
      )[0]!,
  };
}
export const COWORK_HOST = createCoworkHost();
