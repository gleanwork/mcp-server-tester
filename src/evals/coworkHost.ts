import { z } from 'zod';
import type {
  HostDefinition,
  HostBatchRequest,
  HostRunContext,
  HostRunResult,
} from './evalFrameworkTypes.js';
import { getCoworkPlatform, type CoworkPlatform } from './cowork/platform.js';
import { verifyCoworkMcpServers } from './cowork/mcpReadiness.js';
import {
  findMatchingClaudeSessions,
  snapshotClaudeSessions,
  waitForClaudeTrace,
  waitForClaudeSession,
} from './externalHost/builtins/anthropicClaude.js';
import { simulationToHostTrace } from './hostTrace.js';
import {
  HostPluginError,
  HostPluginsSchema,
  assertCoworkHostPlugins,
  hostStdioServers,
} from './hostPlugins.js';
import { coworkManagedPluginSettings } from './cowork/managedSettings.js';
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
    computerUseMaxActions: z.number().int().min(1).max(64).default(24),
    hitlMaxActions: z.number().int().min(1).max(24).default(12),
    computerUseModel: z
      .string()
      .regex(/^[A-Za-z0-9._:-]+$/)
      .optional(),
    dataDir: z.string().min(1).optional(),
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
    /** Host-owned: installed through managed allowedPluginMarketplaces. */
    plugins: HostPluginsSchema.optional(),
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
  const plugins = config.plugins ?? [];
  // Fail before any desktop action if Cowork cannot apply a plugin as declared.
  assertCoworkHostPlugins(plugins);
  const servers = requests[0]!.input.servers;
  // Stdio servers are host-resolved eval servers: validate and resolve them
  // (labels, placeholders, plugin roots, data root) before any desktop action.
  const stdioServers = hostStdioServers(servers, plugins);
  const stdioPaths = {
    ...(config.options.pluginRoots
      ? { pluginRoots: config.options.pluginRoots }
      : {}),
    ...(config.options.mcpDataRoot
      ? { dataRoot: config.options.mcpDataRoot }
      : {}),
  };
  if (stdioServers.length) {
    // MST writes macOS settings but cannot stage a plugin root there.
    if (config.options.computerUseProvider !== 'linux-desktop')
      throw new HostPluginError(
        'mcp_server_unsupported',
        stdioServers[0]!.label
      );
  }
  const referenced = new Set(stdioServers.flatMap((s) => s.pluginRoots));
  const unknownRoot = Object.keys(config.options.pluginRoots ?? {}).find(
    (name) => !referenced.has(name)
  );
  if (
    unknownRoot ||
    (config.options.mcpDataRoot && !stdioServers.some((s) => s.usesDataDir))
  )
    throw new HostPluginError('mcp_server_invalid', unknownRoot ?? 'dataRoot');
  coworkManagedPluginSettings({ servers, plugins, paths: stdioPaths });
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
  // Pass only the selected arm. Setup intentionally rejects multi-arm manifests.
  const { arms: _arms, ...manifest } = context.manifest;
  const managedManifest = { ...manifest, servers };
  let session: Awaited<ReturnType<CoworkPlatform['prepare']>> | undefined;
  const results = requests.map(() =>
    failure('Cowork submission was not attempted.')
  );
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
      } else if (server.auth?.accessTokenEnv) {
        const token = env[server.auth.accessTokenEnv];
        if (token) secrets.push(token);
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
      plugins.length ||
      config.model
    )
      session = await platform.prepare({
        manifest: managedManifest,
        env,
        model: config.model,
        ...(plugins.length ? { plugins } : {}),
        ...(stdioServers.length ? { stdioPaths } : {}),
      });
    if (servers.length) {
      const readiness = await verifyCoworkMcpServers(servers, env, {
        plugins,
        paths: stdioPaths,
      });
      process.stderr.write(
        `[mst:cowork] MCP preflight ready: ${readiness
          .map(
            (server) =>
              `${server.label}(${server.toolCount ?? 0} tools, ${server.elapsedMs}ms)`
          )
          .join(', ')}\\n`
      );
    }
    for (const [index, request] of requests.entries()) {
      const caseStartedAt = Date.now();
      const computerUse: Record<
        'submission' | 'hitl',
        { status: string; telemetry?: CoworkDriverTelemetry }
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
      const snapshot = await snapshotClaudeSessions(dataDir);
      const startedAtMs = Date.now();
      const deadlineAt = startedAtMs + config.timeout;
      let hitlError: string | undefined;
      let hitlWarning: string | undefined;
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
      try {
        const remaining = deadlineAt - Date.now();
        if (remaining <= 0)
          throw new Error(
            'Native Claude trace deadline exceeded. No resubmission attempted.'
          );
        process.stderr.write(
          `[mst:cowork] collecting case ${index + 1}/${requests.length}\n`
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
        results[index] = failure(safeError(error));
      }
      finishCase();
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
