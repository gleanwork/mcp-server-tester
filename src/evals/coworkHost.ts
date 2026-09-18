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
import {
  CoworkDriverError,
  type CoworkDriverTelemetry,
} from './cowork/driver.js';

const OptionsSchema = z
  .object({
    computerUseProvider: z
      .enum(['anthropic-computer-use', 'linux-desktop'])
      .default(() =>
        process.platform === 'linux'
          ? 'linux-desktop'
          : 'anthropic-computer-use'
      ),
    submissionMode: z.enum(['sequential', 'deferred']).default('sequential'),
    collectionTimeoutMs: z
      .number()
      .int()
      .positive()
      .max(Number.MAX_SAFE_INTEGER)
      .default(3_600_000),
    computerUseMaxActions: z.number().int().min(1).max(64).default(24),
    hitlMaxActions: z.number().int().min(1).max(24).default(12),
    computerUseModel: z
      .string()
      .regex(/^[A-Za-z0-9._:-]+$/)
      .optional(),
    dataDir: z.string().min(1).optional(),
  })
  .strict()
  .superRefine((options, context) => {
    if (
      options.computerUseProvider === 'linux-desktop' &&
      options.computerUseModel !== undefined
    )
      context.addIssue({
        code: 'custom',
        path: ['computerUseModel'],
        message: 'linux-desktop does not use a planner model.',
      });
  });
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
  const configs = requests.map((r) => CoworkSchema.parse(r.config));
  if (requests.some((r) => !r.input.scenario.trim()))
    throw new Error('Cowork cases require a non-empty scenario.');
  if (configs.some((c) => JSON.stringify(c) !== JSON.stringify(configs[0])))
    throw new Error(
      'Cowork batch requires identical host settings for all cases.'
    );
  const config = configs[0]!;
  const env = { ...process.env, ...context.env, ...config.env };
  if (
    config.options.computerUseProvider === 'anthropic-computer-use' &&
    !env.ANTHROPIC_API_KEY
  )
    throw new Error('ANTHROPIC_API_KEY is required for Cowork Computer Use.');
  const platform =
    selectedPlatform ??
    (await getCoworkPlatform(config.options.computerUseProvider));
  const dataDir = platform.dataDirectory(config.options);
  const servers = requests[0]!.input.servers;
  // Pass only the selected arm. Setup intentionally rejects multi-arm manifests.
  const { arms: _arms, ...manifest } = context.manifest;
  const managedManifest = { ...manifest, servers };
  let session: Awaited<ReturnType<CoworkPlatform['prepare']>> | undefined;
  const results = requests.map(() =>
    failure('Cowork submission was not attempted.')
  );
  const usedSessions = new Set<string>();
  const deferred = config.options.submissionMode === 'deferred';
  const collectors: Array<(deadlineAt: number) => Promise<void>> = [];
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
    if (
      config.options.computerUseProvider === 'linux-desktop' ||
      servers.length ||
      config.model
    )
      session = await platform.prepare({
        manifest: managedManifest,
        env,
        model: config.model,
      });
    for (const [index, request] of requests.entries()) {
      const caseStartedAt = Date.now();
      const computerUse: Record<
        'submission' | 'hitl',
        { status: string; reason?: string; telemetry?: CoworkDriverTelemetry }
      > = {
        submission: { status: 'not-attempted' },
        hitl: { status: 'not-attempted' },
      };
      const finishCase = () => {
        results[index] = {
          ...results[index]!,
          durationMs: Date.now() - caseStartedAt,
          telemetry: { ...results[index]!.telemetry, computerUse },
        };
      };
      // Bind each fresh task before another submission can create an identical prompt.
      const startedAtMs = Date.now();
      const deadlineAt = startedAtMs + config.timeout;
      let hitlError: string | undefined;
      let hitlWarning: string | undefined;
      let sessionPath: string;
      let nativeSessionId: string;
      let match: Omit<Parameters<typeof waitForClaudeSession>[0], 'timeoutMs'>;
      process.stderr.write(
        `[mst:cowork] case ${index + 1}/${requests.length}: submitting unchanged prompt\n`
      );
      try {
        match = {
          dataDir,
          exactPrompt: request.input.scenario,
          snapshot: await snapshotClaudeSessions(dataDir),
          startedAtMs,
        };
        const submission = await platform.submit(request.input.scenario, {
          deadlineAt,
          maxActions: config.options.computerUseMaxActions,
          model: config.options.computerUseModel,
          env,
        });
        computerUse.submission = {
          status: 'completed',
          ...(submission.telemetry ? { telemetry: submission.telemetry } : {}),
        };
        const bound = await waitForClaudeSession({
          ...match,
          timeoutMs: Math.max(0, Math.min(30_000, deadlineAt - Date.now())),
        });
        sessionPath = bound.candidate.metadataPath;
        nativeSessionId = bound.candidate.id;
        if (usedSessions.has(sessionPath))
          throw new Error(
            'Native session matched more than one case; refusing duplicate attribution.'
          );
        usedSessions.add(sessionPath);
      } catch (error) {
        if (computerUse.submission.status !== 'completed') {
          computerUse.submission = {
            status: 'failed',
            ...(error instanceof CoworkDriverError && error.telemetry
              ? { telemetry: error.telemetry }
              : {}),
          };
        }
        results[index] = failure(safeError(error));
        finishCase();
        for (let n = index + 1; n < requests.length; n++)
          results[n] = failure(
            'Not submitted because a previous UI submission failed or was ambiguous. No retries were attempted.'
          );
        break;
      }
      if (deferred) {
        computerUse.hitl = {
          status: 'not-attempted',
          reason:
            'Deferred collection requires preapproved/unattended tasks. Current-task-only HITL cannot safely act on background sessions.',
        };
      } else {
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
            computerUse.hitl = { status: 'skipped-native-complete' };
            process.stderr.write(
              `[mst:cowork] case ${index + 1} already completed; skipping HITL\n`
            );
          } else {
            const hitl = await platform.handleHitl({
              deadlineAt: deadlineAt,
              maxActions: config.options.hitlMaxActions,
              model: config.options.computerUseModel,
              env,
              approveWriteTools:
                context.manifest.coworkSetup?.approveWriteTools === true,
              isComplete: async () => {
                const current = await findMatchingClaudeSessions({
                  ...match,
                  sessionPath,
                });
                if (current.length !== 1)
                  throw new Error(
                    'Bound native session is missing or ambiguous.'
                  );
                return current[0]!.isComplete;
              },
              task: `Handle only the currently open Cowork task just submitted with this exact query: ${request.input.scenario}. Do not switch tasks. Never create, type, or resubmit a task. If the current task cannot be identified uniquely, stop without an action.`,
            });
            computerUse.hitl = {
              status: 'completed',
              ...(hitl.telemetry ? { telemetry: hitl.telemetry } : {}),
            };
          }
        } catch (error) {
          computerUse.hitl = {
            status:
              error instanceof CoworkDriverError &&
              error.kind === 'hitl-budget-exhausted'
                ? 'budget-exhausted'
                : 'failed',
            ...(error instanceof CoworkDriverError && error.telemetry
              ? { telemetry: error.telemetry }
              : {}),
          };
          const message = safeError(error);
          if (
            error instanceof CoworkDriverError &&
            error.kind === 'hitl-budget-exhausted'
          ) {
            hitlWarning = message;
          } else {
            hitlError = message;
          }
        }
      }
      const collect = async (collectionDeadlineAt: number) => {
        try {
          const remaining = collectionDeadlineAt - Date.now();
          if (!deferred && remaining <= 0)
            throw new Error(
              'Native Claude trace deadline exceeded. No resubmission attempted.'
            );
          process.stderr.write(
            `[mst:cowork] collecting case ${index + 1}/${requests.length}\n`
          );
          const trace = await waitForClaudeTrace({
            ...match,
            sessionPath,
            timeoutMs: Math.max(0, remaining),
            ...(deferred ? { deadlineAt: collectionDeadlineAt } : {}),
          });
          if (trace.candidate.metadataPath !== sessionPath)
            throw new Error(
              'Native session identity changed; refusing attribution.'
            );
          process.stderr.write(
            `[mst:cowork] case ${index + 1}: native completion found (${trace.toolCalls.length} tool calls)\n`
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
          results[index] = {
            ...result,
            error: result.error ?? hitlError,
            telemetry: {
              source: 'claude-native',
              costScope: 'native-inference-only',
              ...trace.telemetry,
              nativeSessionId: trace.candidate.id,
              correlation: 'exact-initial-prompt',
              ...(hitlWarning ? { hitlWarning } : {}),
            },
            llmDurationMs: trace.llmDurationMs,
          };
        } catch (error) {
          results[index] = failure(
            safeError(error) +
              (deferred
                ? ' Deferred collection did not produce a usable bound trace. Inspect the bound native session for pending approvals or incomplete work; preapprove only authorized tools and use unattended tasks, or use sequential mode for current-task HITL. No resubmission or background approval was attempted.'
                : '')
          );
        }
        if (deferred) {
          results[index].telemetry = {
            ...results[index].telemetry,
            nativeSessionId,
            correlation: 'exact-initial-prompt',
          };
        }
        finishCase();
      };
      if (deferred) collectors.push(collect);
      else await collect(deadlineAt);
    }
    // Start one batch-wide budget only after all safe submissions, including an
    // early abort. Drain every bound session before releasing the managed desktop.
    const collectionDeadlineAt =
      Date.now() + config.options.collectionTimeoutMs;
    // Bound native-file polling independently of task submission. An arbitrarily
    // large dataset must not start one filesystem polling loop per case at once.
    let nextCollector = 0;
    await Promise.all(
      Array.from({ length: Math.min(4, collectors.length) }, async () => {
        while (nextCollector < collectors.length) {
          const collect = collectors[nextCollector++]!;
          await collect(collectionDeadlineAt);
        }
      })
    );
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
