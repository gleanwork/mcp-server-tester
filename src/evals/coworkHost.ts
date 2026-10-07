import { hasLLMCredential } from '../llm/endpoint.js';
import { z } from 'zod';
import type {
  ClientDefinition,
  ClientBatchRequest,
  ClientRunContext,
  ClientRunResult,
} from './evalFrameworkTypes.js';
import { getCoworkPlatform, type CoworkPlatform } from './cowork/platform.js';
import { verifyCoworkMcpServers } from './cowork/mcpReadiness.js';
import { hostSecretValues, redactHostError } from './hostSecrets.js';
import {
  requireIdenticalHostSettings,
  runDesktopBatch,
  type DesktopCaseOutcome,
  type DesktopContinuation,
} from './desktopBatch.js';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { validateMacLocalServers } from './coworkSetup/macLocalMcp.js';
import {
  findMatchingClaudeSessions,
  snapshotClaudeSessions,
  waitForClaudeTrace,
  waitForClaudeSession,
} from './externalHost/builtins/claudeSessions.js';
import { awaitingUserAnswer } from './externalHost/builtins/claudeTrace.js';
import { simulationToHostRun } from './hostTrace.js';
import {
  MarketplacePluginError,
  MarketplacePluginsSchema,
  assertCoworkHostPlugins,
  hostStdioServers,
} from './hostPlugins.js';
import { coworkManagedPluginSettings } from './cowork/managedSettings.js';
import { resolveCoworkSetupConfig } from './coworkSetup/options.js';
import {
  CoworkDriverError,
  type CoworkDriverTelemetry,
} from './cowork/driver.js';
import { mcpServerLabel } from '../config/mcpConfig.js';

const CoworkSchema = z
  .object({
    type: z.string(),
    computerUseProvider: z
      .enum(['anthropic-computer-use', 'linux-desktop'])
      .default(() =>
        process.platform === 'linux'
          ? 'linux-desktop'
          : 'anthropic-computer-use'
      ),
    computerUseMaxActions: z.number().int().min(1).max(64).default(24),
    hitlMaxActions: z.number().int().min(1).max(24).default(12),
    computerUseModel: z
      .string()
      .regex(/^[A-Za-z0-9._:-]+$/)
      .optional(),
    dataDir: z.string().min(1).optional(),
    /**
     * macOS: download and run exactly this Claude Desktop version (`x.y.z`).
     * Omit it to run the installed app. Either way, the version is recorded.
     */
    appVersion: z
      .string()
      .regex(/^\d+\.\d+\.\d+$/)
      .optional(),
    /**
     * Linux: absolute root of each staged plugin, for `${pluginRoot:<plugin>}`
     * in stdio eval servers. The caller stages it from the pinned ref.
     */
    pluginRoots: z
      .record(
        z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/),
        z.string().min(2).max(4096)
      )
      .optional(),
    /** Linux: absolute private (0700) root; a server's `${dataDir}` is `<root>/<label>`. */
    mcpDataRoot: z.string().min(2).max(4096).optional(),
    timeout: z.number().int().positive().default(900_000),
    model: z
      .string()
      .regex(/^[A-Za-z0-9._:-]+$/)
      .optional(),
    provider: z.literal('anthropic').optional(),
    env: z.record(z.string(), z.string()).optional(),
    /** Host-owned: installed through managed allowedPluginMarketplaces. */
    plugins: MarketplacePluginsSchema.optional(),
    options: z
      .never({
        message:
          '`clientOptions.options` is gone: set its keys in `clientOptions` directly (`clientOptions.appVersion`, not `clientOptions.options.appVersion`).',
      })
      .optional(),
  })
  .strict()
  .superRefine((options, context) => {
    if (
      options.computerUseProvider !== 'linux-desktop' &&
      (options.pluginRoots !== undefined || options.mcpDataRoot !== undefined)
    )
      context.addIssue({
        code: 'custom',
        path: ['pluginRoots'],
        message: 'pluginRoots and mcpDataRoot require linux-desktop.',
      });
    if (
      options.computerUseProvider === 'linux-desktop' &&
      options.computerUseModel !== undefined
    )
      context.addIssue({
        code: 'custom',
        path: ['computerUseModel'],
        message: 'linux-desktop does not use a planner model.',
      });
    if (
      options.computerUseProvider === 'linux-desktop' &&
      options.appVersion !== undefined
    )
      context.addIssue({
        code: 'custom',
        path: ['appVersion'],
        message:
          'appVersion requires anthropic-computer-use; linux-desktop runs the prepared desktop.',
      });
  });
/** Platforms with managed stdio setup, readiness, and cleanup support. */
export const COWORK_STDIO_PLATFORMS = ['darwin', 'linux'] as const;

const failure = (error: string): ClientRunResult => ({
  finalText: '',
  events: [],
  error,
});

/** Shared desktop, one managed transaction, then ordinary V2 trace evaluation. */
async function runBatch(
  requests: ClientBatchRequest[],
  context: ClientRunContext,
  selectedPlatform?: CoworkPlatform
): Promise<ClientRunResult[]> {
  if (!requests.length) return [];
  const configs = requests.map((r) => CoworkSchema.parse(r.config));
  if (requests.some((r) => !r.input.prompt.trim()))
    throw new Error('Cowork cases require a non-empty input.');
  requireIdenticalHostSettings('Cowork', configs);
  const config = configs[0]!;
  const coworkSetup = resolveCoworkSetupConfig(context.evalConfig.coworkSetup);
  const approvalTask = `Approve ${coworkSetup.approveWriteTools ? 'read and write' : 'read-only'} calls only using one-time or current-task approval. Never select persistent or always-allow approval, or change settings.`;
  const plugins = config.plugins ?? [];
  // Fail before any desktop action if Cowork cannot apply a plugin as declared.
  assertCoworkHostPlugins(plugins);
  const servers = requests[0]!.input.servers;
  // MST's readiness probe uses its own endpoint when the servers are proxied.
  const checkServers = requests[0]!.input.checkServers ?? servers;
  // Validate declarations before desktop actions. macOS resolves host-resolved
  // paths inside its leased setup transaction; Linux uses prepared runtime paths.
  const mac = config.computerUseProvider === 'anthropic-computer-use';
  const stdioServers = hostStdioServers(servers, plugins);
  let stdioPaths = {
    ...(config.pluginRoots ? { pluginRoots: config.pluginRoots } : {}),
    ...(config.mcpDataRoot ? { dataRoot: config.mcpDataRoot } : {}),
  };
  if (
    config.computerUseProvider !== 'linux-desktop' &&
    stdioServers.some((server) => server.pluginRoots.length)
  )
    throw new MarketplacePluginError(
      'mcp_server_unsupported',
      stdioServers.find((server) => server.pluginRoots.length)!.label
    );
  const referenced = new Set(stdioServers.flatMap((s) => s.pluginRoots));
  const unknownRoot = Object.keys(config.pluginRoots ?? {}).find(
    (name) => !referenced.has(name)
  );
  if (
    unknownRoot ||
    (config.mcpDataRoot && !stdioServers.some((s) => s.usesDataDir))
  )
    throw new MarketplacePluginError(
      'mcp_server_invalid',
      unknownRoot ?? 'dataRoot'
    );
  const httpServers = servers
    .map((server, index) => ({
      ...server,
      label: mcpServerLabel(server, index),
    }))
    .filter((server) => server.transport === 'http');
  if (mac) validateMacLocalServers(httpServers);
  coworkManagedPluginSettings({
    servers: mac ? httpServers : servers,
    declaredServers: servers,
    plugins,
    paths: stdioPaths,
  });
  const env = { ...process.env, ...context.env, ...config.env };
  if (
    config.computerUseProvider === 'anthropic-computer-use' &&
    !hasLLMCredential('anthropic', { env })
  )
    throw new Error(
      'Cowork Computer Use needs ANTHROPIC_API_KEY, or ANTHROPIC_BASE_URL with MST_LLM_AUTH_COMMAND or ANTHROPIC_AUTH_TOKEN for an LLM gateway.'
    );
  const platform =
    selectedPlatform ?? (await getCoworkPlatform(config.computerUseProvider));
  const dataDir = platform.dataDirectory(config);
  // Pass only the selected variant. Setup intentionally rejects multi-variant eval configs.
  const { variants: _variants, ...evalConfig } = context.evalConfig;
  const managedConfig = { ...evalConfig, coworkSetup, servers };
  type Session = Awaited<ReturnType<CoworkPlatform['prepare']>> | undefined;
  const secrets = hostSecretValues(env, servers);
  const safeError = (error: unknown): string =>
    redactHostError(error, secrets, 'Cowork operation failed.');
  return runDesktopBatch<Session>(
    {
      name: 'Cowork',
      // One desktop per run, across processes.
      // One run per desktop, across processes. The desktop is identified by
      // the native data directory it runs from, so separate desktops (e.g.
      // several Linux displays) don't block each other.
      lease: {
        directory: join(homedir(), '.mcp-server-tester'),
        file: `cowork-desktop-${createHash('sha256').update(dataDir).digest('hex').slice(0, 12)}.lock`,
      },
      secrets,
      resetVerb: 'reset',
      async prepare() {
        if (env.MST_COWORK_RECOVER === '1') await platform.recover();
        const session = await platform.prepare({
          evalConfig: managedConfig,
          env,
          model: config.model,
          ...(config.appVersion ? { appVersion: config.appVersion } : {}),
          ...(plugins.length ? { plugins } : {}),
          ...(stdioServers.length &&
          config.computerUseProvider === 'linux-desktop'
            ? { stdioPaths }
            : {}),
        });
        if (session?.stdioPaths) stdioPaths = session.stdioPaths;
        return session;
      },
      // The readiness gate runs once setup has resolved the stdio paths.
      async ready() {
        if (!servers.length) return;
        const readiness = await verifyCoworkMcpServers(checkServers, env, {
          plugins,
          paths: stdioPaths,
        });
        process.stderr.write(
          `[mst:cowork] MCP preflight ready: ${readiness
            .map(
              (server) =>
                `${server.label}(${server.toolCount ?? 0} tools, ${server.elapsedMs}ms)`
            )
            .join(', ')}\n`
        );
      },
      ...(platform.reset
        ? {
            async reset(session: Session, index: number) {
              process.stderr.write(
                `[mst:cowork] resetting the app before case ${index + 1}\n`
              );
              // Each platform bounds its own reset (one action within 10
              // seconds on Linux, eight Computer Use actions on macOS); this
              // deadline only stops a stuck driver.
              await platform.reset!({
                deadlineAt: Date.now() + 180_000,
                model: config.computerUseModel,
                env,
                ...(session?.appPath ? { appPath: session.appPath } : {}),
              });
            },
          }
        : {}),
      async dispose(session) {
        await session?.dispose();
      },
      async runCase(session, request, index, ledger) {
        const caseStartedAt = Date.now();
        const computerUse: Record<
          'submission' | 'hitl',
          { status: string; telemetry?: CoworkDriverTelemetry }
        > = {
          submission: { status: 'not-attempted' },
          hitl: { status: 'not-attempted' },
        };
        let hitlActions = 0;
        const hitlFollowups: Array<{
          status: string;
          telemetry?: CoworkDriverTelemetry;
        }> = [];
        let result: ClientRunResult = failure(
          'Cowork submission was not attempted.'
        );
        let continuation: DesktopContinuation = 'allowed';
        const finishCase = (): DesktopCaseOutcome => {
          result = {
            ...result,
            durationMs: Date.now() - caseStartedAt,
            telemetry: {
              ...result.telemetry,
              // What actually ran, pinned or not, so results show app drift.
              ...(session?.app ? { hostApp: session.app } : {}),
              computerUse: {
                ...computerUse,
                ...(hitlFollowups.length ? { hitlFollowups } : {}),
              },
            },
          };
          return { result, continuation };
        };
        // Bind each fresh task before another submission can create an identical prompt.
        const snapshot = await snapshotClaudeSessions(dataDir);
        const startedAtMs = Date.now();
        const deadlineAt = startedAtMs + config.timeout;
        let hitlError: string | undefined;
        let hitlWarning: string | undefined;
        let awaitingUser = false;
        let sessionPath: string;
        const match = {
          dataDir,
          exactPrompt: request.input.prompt,
          snapshot,
          startedAtMs,
        };
        process.stderr.write(
          `[mst:cowork] case ${index + 1}/${requests.length}: submitting unchanged prompt\n`
        );
        try {
          const submission = await platform.submit(request.input.prompt, {
            deadlineAt,
            maxActions: config.computerUseMaxActions,
            model: config.computerUseModel,
            ...(mac && config.model ? { targetModel: config.model } : {}),
            env,
            ...(session?.appPath ? { appPath: session.appPath } : {}),
          });
          computerUse.submission = {
            status: 'completed',
            ...(submission.telemetry
              ? { telemetry: submission.telemetry }
              : {}),
          };
          const bound = await waitForClaudeSession({
            ...match,
            timeoutMs: Math.max(0, Math.min(30_000, deadlineAt - Date.now())),
          });
          sessionPath = bound.candidate.metadataPath;
          if (!ledger.claim(sessionPath))
            throw new Error(
              'Native session matched more than one case; refusing duplicate attribution.'
            );
        } catch (error) {
          if (computerUse.submission.status !== 'completed') {
            computerUse.submission = {
              status: 'failed',
              ...(error instanceof CoworkDriverError && error.telemetry
                ? { telemetry: error.telemetry }
                : {}),
            };
          }
          result = failure(safeError(error));
          continuation = 'reset';
          return finishCase();
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
            computerUse.hitl = { status: 'skipped-native-complete' };
            process.stderr.write(
              `[mst:cowork] case ${index + 1} already completed; skipping HITL\n`
            );
          } else if (mac && coworkSetup.approveWriteTools) {
            // Staged connector defaults must work without a click-through fallback.
            computerUse.hitl = { status: 'not-attempted' };
          } else {
            const hitl = await platform.handleHitl({
              deadlineAt: deadlineAt,
              maxActions: config.hitlMaxActions,
              model: config.computerUseModel,
              env,
              ...(session?.appPath ? { appPath: session.appPath } : {}),
              approveWriteTools: coworkSetup.approveWriteTools,
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
              awaitingUser: async () => {
                const current = await findMatchingClaudeSessions({
                  ...match,
                  sessionPath,
                });
                return current.length === 1 && awaitingUserAnswer(current[0]!);
              },
              task: `Handle only the currently open Cowork task just submitted with this exact query: ${request.input.prompt}. ${approvalTask} Do not switch tasks. Never create, type, or resubmit a task. If the current task cannot be identified uniquely, stop without an action.`,
            });
            hitlActions += hitl.action_count;
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
          if (
            error instanceof CoworkDriverError &&
            error.kind === 'awaiting-user'
          )
            awaitingUser = true;
        }
        if (awaitingUser) {
          // Waiting on a question nobody can answer: fail now, not at the deadline.
          // Keep the bound session so the auditor can verify the unanswered
          // AskUserQuestion from the native transcript (a model outcome, not a
          // missing-evidence failure).
          const [pending] = await findMatchingClaudeSessions({
            ...match,
            sessionPath,
          }).catch(() => []);
          result = {
            ...failure(hitlError ?? 'Cowork is waiting for an answer.'),
            ...(pending
              ? {
                  toolCalls: pending.toolCalls,
                  telemetry: {
                    source: 'claude-native',
                    costScope: 'native-inference-only',
                    ...pending.telemetry,
                    nativeSessionId: pending.candidate.id,
                    correlation: 'exact-initial-prompt',
                    awaitingUser: 'AskUserQuestion',
                  },
                }
              : {}),
          };
          if (platform.reset) continuation = 'reset';
          return finishCase();
        }
        try {
          const remaining = deadlineAt - Date.now();
          if (remaining <= 0)
            throw new Error(
              'Native Claude trace deadline exceeded. No resubmission attempted.'
            );
          process.stderr.write(
            `[mst:cowork] collecting case ${index + 1}/${requests.length}\n`
          );
          let inspections = 0;
          let nextInspection = 0;
          const trace = await waitForClaudeTrace({
            ...match,
            sessionPath,
            timeoutMs: remaining,
            ...(mac && !coworkSetup.approveWriteTools
              ? {
                  onPending: async (pending) => {
                    // A tool request can arrive after the initial visual check. Revisit
                    // only a bound trace with an outstanding native tool call, within
                    // the same per-case action budget. Never resubmit the prompt.
                    if (
                      hitlError ||
                      inspections >= 3 ||
                      hitlActions >= config.hitlMaxActions ||
                      Date.now() < nextInspection ||
                      !pending.toolCalls.some(
                        (call) => call.output === undefined
                      )
                    )
                      return;
                    if (pending.candidate.metadataPath !== sessionPath)
                      throw new Error(
                        'Native session identity changed before HITL.'
                      );
                    inspections++;
                    nextInspection = Date.now() + 5_000;
                    try {
                      const followup = await platform.handleHitl({
                        deadlineAt: Math.min(deadlineAt, Date.now() + 60_000),
                        maxActions: config.hitlMaxActions - hitlActions,
                        model: config.computerUseModel,
                        env,
                        ...(session?.appPath
                          ? { appPath: session.appPath }
                          : {}),
                        approveWriteTools: coworkSetup.approveWriteTools,
                        task: `Handle only the pending tool approval in the current Cowork task for this exact query: ${request.input.prompt}. ${approvalTask} Do not switch tasks, type, or resubmit a query. If the current task cannot be identified uniquely, stop without an action.`,
                      });
                      hitlActions += followup.action_count;
                      hitlFollowups.push({
                        status: 'completed',
                        ...(followup.telemetry
                          ? { telemetry: followup.telemetry }
                          : {}),
                      });
                    } catch (error) {
                      hitlFollowups.push({
                        status: 'failed',
                        ...(error instanceof CoworkDriverError &&
                        error.telemetry
                          ? { telemetry: error.telemetry }
                          : {}),
                      });
                      throw error;
                    }
                  },
                }
              : {}),
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
          const nativeResult = simulationToHostRun(
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
          result = {
            ...nativeResult,
            error: nativeResult.error ?? hitlError,
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
          // Trace collection or attribution failed: the app state is unknown.
          result = failure(safeError(error));
          if (platform.reset) continuation = 'reset';
        }
        // A HITL failure may leave a prompt open; reset before the next task.
        if (hitlError && platform.reset) continuation = 'reset';
        return finishCase();
      },
    },
    requests
  );
}

export function createCoworkHost(platform?: CoworkPlatform): ClientDefinition {
  return {
    schema: CoworkSchema,
    evidence: 'structured',
    // Cowork sets up its MCP servers once per batch, so a tool variant goes
    // through one proxy endpoint for the whole batch.
    serversPerBatch: true,
    runBatch: (requests, context) => runBatch(requests, context, platform),
    run: async (input, config, context) =>
      (
        await runBatch(
          [{ caseId: 'single', trial: 0, input, config }],
          context,
          platform
        )
      )[0]!,
  };
}
export const COWORK_HOST = createCoworkHost();
