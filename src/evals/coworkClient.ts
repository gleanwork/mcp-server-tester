import { hasLLMCredential } from '../llm/endpoint.js';
import { z } from 'zod';
import type {
  ClientDefinition,
  ClientRunContext,
  ClientRunResult,
  ClientSessionOptions,
} from './evalFrameworkTypes.js';
import type { CoworkDesktop } from './cowork/desktop.js';
import { coworkReadinessServer } from './cowork/readinessServer.js';
import { checksServersAfterPrepare } from './readinessCheck.js';
import { clientSecretValues, redactClientError } from './clientSecrets.js';
import {
  RESET_RETRY_DELAYS_MS,
  collectClientBatch,
  openDesktopSession,
  requireIdenticalClientSettings,
  type DesktopCaseOutcome,
  type DesktopClientAdapter,
  type DesktopContinuation,
} from './desktopBatch.js';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { validateMacLocalServers } from './coworkSetup/macLocalMcp.js';
import {
  findMatchingClaudeSessions,
  snapshotClaudeSessions,
  waitForClaudeTranscript,
  waitForClaudeSession,
} from './cowork/sessions.js';
import {
  awaitingUserAnswer,
  pendingUserQuestion,
  type ClaudeTranscript,
} from './cowork/transcript.js';
import { infrastructureEnding } from './trialEnding.js';
import { computerUseEnding } from './cowork/anthropicComputerUse.js';
import { DEFAULT_COMPUTER_USE_MODEL } from './cowork/computerUseLoop.js';
import { NativeTranscriptError } from './nativeTranscriptError.js';
import { toolCallEvents } from './clientTranscript.js';
import {
  claudeDesktopOtlpSettings,
  hostTelemetryReceiver,
  withHostRequestIds,
} from './telemetry/hostReceiver.js';
import {
  MarketplacePluginError,
  MarketplacePluginsSchema,
  assertCoworkClientPlugins,
  clientStdioServers,
} from './clientPlugins.js';
import { coworkManagedPluginSettings } from './cowork/managedSettings.js';
import { resolveCoworkSetupConfig } from './coworkSetup/options.js';
import {
  CoworkDriverError,
  CoworkHitlError,
  type CoworkDriverTelemetry,
} from './cowork/interaction.js';
import { mcpServerLabel, type MCPConfig } from '../config/mcpConfig.js';
import type { LLMToolCall } from './mstClient/types.js';
import {
  COMPUTER_USE_PROVIDER_GONE,
  fixedProviderGone,
  maxActionsRenamed,
  osName,
} from './desktopOS.js';
import { removedClientOptions } from './renamedKeys.js';
import { CloudConnectorsSchema } from './cowork/claudeAiConnectors.js';
import { assertFirstPartyServers } from './cowork/firstParty.js';

const CoworkSchema = z
  .object({
    type: z.string(),
    /** Gone: the trial's OS decides (ADR 0011). */
    computerUseProvider: z
      .never({ message: COMPUTER_USE_PROVIDER_GONE })
      .optional(),
    /**
     * The most actions the desktop automation may take to send a case's
     * prompt (1 to 64, default 24), on macOS and on Linux.
     */
    maxActions: z.number().int().min(1).max(64).default(24),
    /** Gone: the action budget is `maxActions`. */
    computerUseMaxActions: z
      .never({ message: maxActionsRenamed('computerUseMaxActions') })
      .optional(),
    /**
     * The most actions, over all of a case's human-in-the-loop inspections
     * after its prompt is sent (approving its tool calls, checking that its
     * task finished), 1 to 24, default 12. A separate budget from
     * `maxActions`, which covers sending the prompt.
     */
    hitlMaxActions: z.number().int().min(1).max(24).default(12),
    computerUseModel: z
      .string()
      .regex(/^[A-Za-z0-9._:-]+$/)
      .optional()
      .meta({
        'x-defaultDescription': `macOS: MST_COWORK_CUA_MODEL or ${DEFAULT_COMPUTER_USE_MODEL}; Linux: no planner`,
      }),
    dataDir: z.string().min(1).optional().meta({
      'x-defaultDescription':
        'Claude Desktop session directory on the trial machine (OS-specific)',
    }),
    /**
     * macOS: download and run exactly this Claude Desktop version (`x.y.z`).
     * Omit it to run the installed app. Either way, the version is recorded.
     */
    appVersion: z
      .string()
      .regex(/^\d+\.\d+\.\d+$/)
      .optional()
      .meta({ 'x-defaultDescription': 'installed app version (macOS only)' }),
    /**
     * Linux: absolute root of each staged plugin, for `${pluginRoot:<plugin>}`
     * in stdio eval servers. The caller stages it from the pinned ref.
     */
    pluginRoots: z
      .record(
        z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/),
        z.string().min(2).max(4096)
      )
      .optional()
      .meta({
        'x-defaultDescription': 'not set (caller stages plugin roots on Linux)',
      }),
    /** Linux: absolute private (0700) root; a server's `${dataDir}` is `<root>/<label>`. */
    mcpDataRoot: z.string().min(2).max(4096).optional().meta({
      'x-defaultDescription':
        'not set (caller provides a private root on Linux)',
    }),
    /** Select existing account connectors by the normal HTTP server labels. */
    mode: z.enum(['third-party', 'first-party']).optional().meta({
      'x-defaultDescription': 'third-party (MST-managed profile)',
    }),
    /** Account-wide 1P remote connector policies, restored when the session closes. */
    connectors: CloudConnectorsSchema.optional().meta({
      'x-defaultDescription': 'first-party: selected servers read-only',
    }),
    /** The trial's time limit in ms (default 900000). */
    timeout: z.number().int().positive().default(900_000),
    model: z
      .string()
      .regex(/^[A-Za-z0-9._:-]+$/)
      .optional()
      .meta({ 'x-defaultDescription': 'Cowork default' }),
    /** Gone: the client fixes its provider. */
    ...removedClientOptions({
      provider: fixedProviderGone('cowork', 'anthropic'),
    }),
    env: z.record(z.string(), z.string()).optional().meta({
      'x-defaultDescription': 'inherited environment; no extra variables',
    }),
    /** Client-owned: installed through managed allowedPluginMarketplaces. */
    plugins: MarketplacePluginsSchema.optional().meta({
      'x-defaultDescription': 'no marketplace plugins',
    }),
    options: z
      .never({
        message:
          '`clientOptions.options` is gone: set its keys in `clientOptions` directly (`clientOptions.appVersion`, not `clientOptions.options.appVersion`).',
      })
      .optional(),
  })
  .strict()
  .refine((options) => !options.connectors || options.mode === 'first-party', {
    message: 'clientOptions.connectors requires mode: first-party.',
    path: ['connectors'],
  })
  .refine(
    (options) =>
      options.mode !== 'first-party' ||
      (!options.appVersion &&
        !options.dataDir &&
        !options.pluginRoots &&
        !options.mcpDataRoot &&
        !options.plugins?.length),
    {
      message:
        'First-party mode uses the signed-in installed app; appVersion, dataDir, plugins, pluginRoots and mcpDataRoot are unsupported.',
      path: ['mode'],
    }
  );

/**
 * The Cowork options that the OS a trial runs on can't use: `pluginRoots`
 * and `mcpDataRoot` are Linux's, `computerUseModel` and `appVersion` are
 * macOS's. Checked when the eval config loads, when MST knows the OS its
 * trials run on, and again on the machine that runs them.
 */
export function coworkOptionIssues(
  options: {
    pluginRoots?: unknown;
    mcpDataRoot?: unknown;
    computerUseModel?: unknown;
    appVersion?: unknown;
    mode?: unknown;
  },
  os: NodeJS.Platform
): string[] {
  const issues: string[] = [];
  const on = osName(os);
  if (options.mode === 'first-party' && os !== 'darwin')
    issues.push(
      'First-party Cowork requires macOS and a signed-in Claude account.'
    );
  if (
    os !== 'linux' &&
    (options.pluginRoots !== undefined || options.mcpDataRoot !== undefined)
  )
    issues.push(
      `pluginRoots and mcpDataRoot are for Cowork on Linux, and this trial runs on ${on}.`
    );
  if (os !== 'darwin' && options.computerUseModel !== undefined)
    issues.push(
      `computerUseModel is the planner of Computer Use on macOS, and this trial runs on ${on}, which has no planner.`
    );
  if (os !== 'darwin' && options.appVersion !== undefined)
    issues.push(
      `appVersion pins Claude Desktop on macOS, and this trial runs on ${on}, which runs the prepared desktop.`
    );
  return issues;
}
/**
 * The evidence in a Cowork session folder, and only that: the audit log, the
 * files the agent wrote (`outputs/`), its transcripts and the tool output it
 * saved to files. Anything else there (the audit key, the agent's settings,
 * snapshots of its environment) never reaches judges or a run directory.
 */
const COWORK_SESSION_EVIDENCE = [
  'audit.jsonl',
  'connector-policy.json',
  'outputs',
  '.claude/projects/*/*.jsonl',
  '.claude/projects/*/*/tool-results',
] as const;

/** Platforms with managed stdio setup, readiness, and cleanup support. */
export const COWORK_STDIO_PLATFORMS = ['darwin', 'linux'] as const;

/**
 * How the transcript was bound to its case, for its telemetry: an exact initial
 * prompt, or the only new session, with how its stored prompt differs.
 */
/** The IDs a task's own telemetry names it by: Cowork's and Claude Code's. */
function sessionIdsOf(transcript: ClaudeTranscript | undefined): string[] {
  if (!transcript) return [];
  return [
    transcript.candidate.id,
    transcript.candidate.metadata?.cliSessionId,
  ].filter((id): id is string => typeof id === 'string' && id.length > 0);
}

function correlationTelemetry(
  transcript: ClaudeTranscript
): Record<string, unknown> {
  const binding = transcript.binding ?? { kind: 'exact-initial-prompt' };
  return binding.kind === 'only-new-session'
    ? { correlation: binding.kind, promptDifference: binding.promptDifference }
    : { correlation: binding.kind };
}

/**
 * What a task past its deadline was waiting on, and for how long: a tool call
 * with no result yet, or else the model (a response under way, or the next
 * one). A long wait on the model can be a stalled response or one very long
 * one; the transcript can't tell which, since Claude logs a message when it
 * ends.
 */
export interface DeadlineWait {
  on: 'model' | 'tool';
  /** The tool, as Claude names it (`mcp__slack__slack_search`). */
  tool?: string;
  /** Since the task's last native event. */
  idleMs?: number;
}

/** When a native task started and ended, from its session's events. */
function taskTimes(
  transcript: Pick<
    ClaudeTranscript,
    'startedAt' | 'completedAt' | 'lastEventAt'
  >
): { startedAt?: string; completedAt?: string } {
  const completedAt = transcript.completedAt ?? transcript.lastEventAt;
  return {
    ...(transcript.startedAt ? { startedAt: transcript.startedAt } : {}),
    ...(completedAt ? { completedAt } : {}),
  };
}

export function deadlineWait(
  transcript: Pick<ClaudeTranscript, 'toolCalls' | 'lastEventAt'>,
  now = Date.now()
): DeadlineWait {
  const last = transcript.toolCalls.at(-1);
  const lastEvent = transcript.lastEventAt
    ? Date.parse(transcript.lastEventAt)
    : NaN;
  return {
    ...(last && last.output === undefined
      ? { on: 'tool' as const, tool: last.rawName ?? last.name }
      : { on: 'model' as const }),
    ...(Number.isFinite(lastEvent)
      ? { idleMs: Math.max(0, now - lastEvent) }
      : {}),
  };
}

export function describeDeadlineWait(wait: DeadlineWait): string {
  const what =
    wait.on === 'tool' ? `the tool ${wait.tool}` : "the model's response";
  if (wait.idleMs === undefined) return `It was waiting on ${what}.`;
  const seconds = Math.round(wait.idleMs / 1000);
  const idle =
    seconds >= 60
      ? `${Math.floor(seconds / 60)}m ${seconds % 60}s`
      : `${seconds}s`;
  return `It had been waiting on ${what} for ${idle}.`;
}

/**
 * How much of the prompt Claude kept, when it kept only its beginning: the
 * bound session's stored prompt is a strict prefix of the case's. A deep link
 * keeps 14,336 characters on Linux, so the driver pastes a longer prompt;
 * this catches any other path that cuts one.
 */
export function truncatedPrompt(
  transcript: Pick<ClaudeTranscript, 'binding'>
): { storedChars: number; promptChars: number } | undefined {
  const binding = transcript.binding;
  if (binding?.kind !== 'only-new-session') return undefined;
  const { storedChars, promptChars, firstDifferenceAt } =
    binding.promptDifference;
  return storedChars < promptChars && firstDifferenceAt === storedChars
    ? { storedChars, promptChars }
    : undefined;
}

const failure = (error: string): ClientRunResult => ({
  finalText: '',
  events: [],
  error,
});

type CoworkSession = Awaited<ReturnType<CoworkDesktop['prepare']>> | undefined;

/** Fixed desktop settings and the native trial body for an open session. */
async function desktopAdapter(
  requests: ClientSessionOptions[],
  context: ClientRunContext,
  selectedDesktop?: CoworkDesktop
): Promise<DesktopClientAdapter<CoworkSession>> {
  requests = structuredClone(requests);
  const configs = requests.map((r) => CoworkSchema.parse(r.config));
  requireIdenticalClientSettings('Cowork', configs);
  requireIdenticalClientSettings(
    'Cowork',
    requests.map((r) => ({
      servers: r.input.servers,
      checkServers: r.input.checkServers,
      env: r.input.env,
    }))
  );
  const config = configs[0]!;
  // How Cowork runs follows from this machine's OS, never the coordinator's.
  const os = process.platform;
  const mac = os === 'darwin';
  const linux = os === 'linux';
  const osIssues = coworkOptionIssues(config, os);
  if (osIssues.length)
    throw new Error(`Cowork can't run this trial: ${osIssues.join(' ')}`);
  const coworkSetup = resolveCoworkSetupConfig(context.evalConfig.coworkSetup);
  const approvalTask = `Approve ${coworkSetup.approveWriteTools ? 'read and write' : 'read-only'} calls only using one-time or current-task approval. Never select persistent or always-allow approval, or change settings.`;
  const plugins = config.plugins ?? [];
  // Fail before any desktop action if Cowork cannot apply a plugin as declared.
  assertCoworkClientPlugins(plugins);
  const servers = requests[0]!.input.servers;
  const firstParty = config.mode === 'first-party';
  if (firstParty) {
    assertFirstPartyServers(servers, config.connectors);
    if (
      context.evalConfig.simulateWrites ||
      context.evalConfig.tools ||
      context.variant?.tools
    )
      throw new Error(
        'First-party mode cannot use simulated writes or tool-metadata proxies.'
      );
  }
  // A request carries `checkServers` only when its servers are proxied. MST
  // then checked them as declared before the proxy started, so Cowork's
  // check after prepare has nothing left to check.
  // Account-backed preparation checks tools and permissions using Claude's auth.
  const readinessServers =
    firstParty || requests[0]!.input.checkServers ? [] : servers;
  const managedServers = firstParty ? [] : servers;
  // Validate declarations before desktop actions. macOS resolves client-resolved
  // paths inside its leased setup transaction; Linux uses prepared runtime paths.
  const stdioServers = clientStdioServers(managedServers, plugins);
  let stdioPaths = {
    ...(config.pluginRoots ? { pluginRoots: config.pluginRoots } : {}),
    ...(config.mcpDataRoot ? { dataRoot: config.mcpDataRoot } : {}),
  };
  if (!linux && stdioServers.some((server) => server.pluginRoots.length))
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
  const httpServers = managedServers
    .map((server, index) => ({
      ...server,
      label: mcpServerLabel(server, index),
    }))
    .filter((server) => server.transport === 'http');
  if (mac) validateMacLocalServers(httpServers);
  coworkManagedPluginSettings({
    servers: mac ? httpServers : managedServers,
    declaredServers: managedServers,
    plugins,
    paths: stdioPaths,
  });
  const env = { ...process.env, ...context.env, ...config.env };
  if (mac && !hasLLMCredential('anthropic', { env }))
    throw new Error(
      'Cowork Computer Use needs ANTHROPIC_API_KEY, or ANTHROPIC_BASE_URL with MST_LLM_AUTH_COMMAND or ANTHROPIC_AUTH_TOKEN for an LLM gateway.'
    );
  // Select the concrete entry point here, on the machine running this batch.
  let platform = selectedDesktop;
  if (firstParty) {
    const { coworkClaudeAi } = await import('./cowork/claudeAi.js');
    platform = coworkClaudeAi(
      platform ?? (await import('./cowork/macos.js')).coworkMacos,
      {
        servers,
        connectors: config.connectors,
        writes: context.evalConfig.writes,
      }
    );
  }
  if (!platform) {
    if (os === 'darwin')
      platform = (await import('./cowork/macos.js')).coworkMacos;
    else if (os === 'linux')
      platform = (await import('./cowork/linux.js')).coworkLinux;
    else throw new Error(`Cowork runs on macOS or Linux, not ${os}.`);
  }
  const dataDir = platform.dataDirectory(config);
  // Pass only the selected variant. Setup intentionally rejects multi-variant eval configs.
  const { variants: _variants, ...evalConfig } = context.evalConfig;
  const managedConfig = { ...evalConfig, coworkSetup, servers };
  // `telemetry.host`: Claude Desktop exports to MST's receiver, which Cowork's
  // VM reaches through its host's address (so not on loopback alone). Only
  // in MST's Linux image, where MST writes Desktop's settings.
  const hostConfig = context.evalConfig.telemetry?.host;
  const hostReceiver =
    hostConfig && linux
      ? await hostTelemetryReceiver(hostConfig, { host: '0.0.0.0', env })
      : undefined;
  if (hostConfig && !hostReceiver)
    console.warn(
      "[mst] cowork: telemetry.host is for Cowork on Linux (MST's image); this run records no host telemetry."
    );
  const otlpSettings = hostReceiver
    ? claudeDesktopOtlpSettings(hostReceiver, {
        'mst.eval': context.evalConfig.name,
        ...(context.variant?.name
          ? { 'mst.variant': context.variant.name }
          : {}),
        ...(env.MST_RUN_ID ? { 'mst.run_id': env.MST_RUN_ID } : {}),
      })
    : undefined;
  const secrets = clientSecretValues(env, servers);
  const safeError = (error: unknown): string =>
    redactClientError(error, secrets, 'Cowork operation failed.');
  return {
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
    // On Linux, a reset that fails once (accessibility_scan_timeout on a
    // slow desktop) would otherwise skip every later case in the batch.
    // macOS already falls back to restarting the app.
    ...(linux ? { resetRetryDelaysMs: RESET_RETRY_DELAYS_MS } : {}),
    async prepare() {
      if (env.MST_COWORK_RECOVER === '1') await platform.recover();
      const session = await platform.prepare({
        evalConfig: managedConfig,
        env,
        model: config.model,
        ...(config.appVersion ? { appVersion: config.appVersion } : {}),
        ...(plugins.length ? { plugins } : {}),
        ...(otlpSettings ? { otlpSettings } : {}),
        ...(stdioServers.length && linux ? { stdioPaths } : {}),
      });
      if (session?.stdioPaths) stdioPaths = session.stdioPaths;
      return session;
    },
    // MST's readiness check runs once setup has resolved the stdio paths.
    readiness() {
      return {
        servers: readinessServers,
        resolve: (server) =>
          coworkReadinessServer(server, env, {
            plugins,
            paths: stdioPaths,
          }),
        env,
      };
    },
    ...(platform.reset
      ? {
          async reset(session: CoworkSession, index: number) {
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
              ...(session?.restart
                ? { restartApp: () => session.restart!() }
                : {}),
            });
          },
        }
      : {}),
    ...(platform.diagnose
      ? {
          async diagnose(_session: CoworkSession, dir: string) {
            await platform.diagnose!({ dir, dataDir, env });
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
      let continuation: DesktopContinuation = 'continue';
      // The sessions the task's own telemetry names, once bound.
      let hostSessions: string[] = [];
      const finishCase = async (): Promise<DesktopCaseOutcome> => {
        const hostTelemetry =
          hostReceiver && hostSessions.length
            ? await hostReceiver.collect(hostSessions).catch(() => undefined)
            : undefined;
        result = {
          ...result,
          ...(hostTelemetry
            ? {
                hostTelemetry,
                ...(result.modelCalls
                  ? {
                      modelCalls: withHostRequestIds(
                        result.modelCalls,
                        hostTelemetry
                      ),
                    }
                  : {}),
              }
            : {}),
          durationMs: Date.now() - caseStartedAt,
          telemetry: {
            ...result.telemetry,
            // What actually ran, pinned or not, so results show app drift.
            ...(session?.app ? { clientApp: session.app } : {}),
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
      // The HITL check failed without acting on the app (CoworkHitlError).
      let hitlUntouched = false;
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
        `[mst:cowork] case ${index + 1}: submitting unchanged prompt\n`
      );
      try {
        const submission = await platform.submit(request.input.prompt, {
          deadlineAt,
          maxActions: config.maxActions,
          model: config.computerUseModel,
          ...(mac && config.model ? { targetModel: config.model } : {}),
          env,
          ...(session?.appPath ? { appPath: session.appPath } : {}),
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
        // Cowork didn't take the prompt, or its Claude session never bound
        // to the case: not the model. Computer Use types why it stopped
        // (a permission, the planner's provider, the deadline); anything
        // else is the client app.
        const message = safeError(error);
        result = {
          ...failure(message),
          ending: computerUseEnding(error, message),
        };
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
            // Linux HITL answers a clarifying question with its first
            // option; the macOS profile turns AskUserQuestion off.
            ...(!mac && coworkSetup.clarifyingQuestions !== 'disabled'
              ? {
                  pendingQuestion: async () => {
                    const current = await findMatchingClaudeSessions({
                      ...match,
                      sessionPath,
                    });
                    return current.length === 1
                      ? pendingUserQuestion(current[0]!)
                      : undefined;
                  },
                }
              : {}),
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
          hitlUntouched = error instanceof CoworkHitlError && !error.touchedUi;
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
        hostSessions = sessionIdsOf(pending);
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
                  ...correlationTelemetry(pending),
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
            'Native Claude transcript deadline exceeded. No resubmission attempted.'
          );
        process.stderr.write(`[mst:cowork] collecting case ${index + 1}\n`);
        let inspections = 0;
        let nextInspection = 0;
        const transcript = await waitForClaudeTranscript({
          ...match,
          sessionPath,
          timeoutMs: remaining,
          ...(mac && !coworkSetup.approveWriteTools
            ? {
                onPending: async (pending) => {
                  // A tool request can arrive after the initial visual check. Revisit
                  // only a bound transcript with an outstanding native tool call, within
                  // the same per-case action budget. Never resubmit the prompt.
                  if (
                    hitlError ||
                    inspections >= 3 ||
                    hitlActions >= config.hitlMaxActions ||
                    Date.now() < nextInspection ||
                    !pending.toolCalls.some((call) => call.output === undefined)
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
                      ...(session?.appPath ? { appPath: session.appPath } : {}),
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
                      ...(error instanceof CoworkDriverError && error.telemetry
                        ? { telemetry: error.telemetry }
                        : {}),
                    });
                    throw error;
                  }
                },
              }
            : {}),
        });
        if (transcript.candidate.metadataPath !== sessionPath)
          throw new Error(
            'Native session identity changed; refusing attribution.'
          );
        hostSessions = sessionIdsOf(transcript);
        const nativeResult: ClientRunResult = {
          finalText: transcript.finalAnswer ?? '',
          events: toolCallEvents(
            coworkOwnToolCalls(
              transcript.toolCalls,
              servers,
              platform.mcpServerNames?.(),
              platform.mcpServerLabels?.()
            ),
            servers
          ),
          ...(transcript.modelCalls?.length
            ? { modelCalls: transcript.modelCalls }
            : {}),
          usage: transcript.usage,
          error: transcript.isError
            ? 'Native Claude task failed.'
            : transcript.finalAnswer === undefined
              ? 'Native transcript has no final answer.'
              : undefined,
        };
        result = {
          ...nativeResult,
          ...taskTimes(transcript),
          // The session folder: audit log, spilled tool output, written files.
          ...(transcript.candidate.sessionDir
            ? {
                artifacts: {
                  dir: transcript.candidate.sessionDir,
                  include: COWORK_SESSION_EVIDENCE,
                },
              }
            : {}),
          // A HITL check that failed without acting on the app can't have
          // changed a task that went on to finish: its answer stands, and
          // the failure is kept as a warning. One that may have acted fails
          // the case.
          error: nativeResult.error ?? (hitlUntouched ? undefined : hitlError),
          telemetry: {
            source: 'claude-native',
            costScope: 'native-inference-only',
            ...transcript.telemetry,
            nativeSessionId: transcript.candidate.id,
            ...correlationTelemetry(transcript),
            ...(hitlWarning
              ? { hitlWarning }
              : hitlUntouched && hitlError && !nativeResult.error
                ? { hitlWarning: hitlError }
                : {}),
          },
          llmDurationMs: transcript.llmDurationMs,
        };
        // Validation may write its own audit receipt and then reject the task.
        // Keep the completed native evidence even when that happens early.
        await platform.validateTranscript?.(transcript);
        process.stderr.write(
          `[mst:cowork] case ${index + 1}: native completion found (${transcript.toolCalls.length} tool calls)\n`
        );
        if (
          config.model &&
          !transcript.telemetry.models.includes(config.model)
        ) {
          throw new Error(
            `Cowork model mismatch: requested ${config.model}, observed ${transcript.telemetry.models.join(', ') || 'unavailable'}.`
          );
        }
        const unavailable = coworkWorkspaceUnavailable(transcript.toolCalls);
        if (unavailable !== undefined) {
          // Cowork's VM didn't start, so the task ran without its shell:
          // an infrastructure failure, kept with its evidence. Cowork
          // starts the VM again for the next task.
          const error = `Cowork's workspace was unavailable: ${unavailable}`;
          result = {
            ...result,
            error,
            ending: infrastructureEnding('workspace', error),
            diagnostics: { ...result.diagnostics, failureKind: 'startup' },
          };
          if (platform.reset) continuation = 'reset';
        }
        const truncated = truncatedPrompt(transcript);
        if (truncated !== undefined) {
          // The model answered the beginning of the prompt, not the case:
          // never graded, kept with its evidence. A retry gets the same
          // part, so the case needs a shorter prompt.
          const error = `Claude kept ${truncated.storedChars} of the prompt's ${truncated.promptChars} characters: the model got only its beginning. No resubmission attempted.`;
          result = {
            ...result,
            error,
            ending: infrastructureEnding('setup', error, false),
            diagnostics: { ...result.diagnostics, failureKind: 'input' },
          };
        }
      } catch (error) {
        // Transcript collection or attribution failed: the app state is unknown.
        const message = safeError(error);
        // The bound session never finished or went away: the client app
        // failed, not the model. Any other error here is the trial's.
        const lostSession =
          error instanceof NativeTranscriptError &&
          (error.failureKind === 'timeout' ||
            error.failureKind === 'no_matching_session');
        const ending = lostSession
          ? infrastructureEnding('client-app', message)
          : undefined;
        result = { ...result, error: message, ...(ending ? { ending } : {}) };
        if (Date.now() >= deadlineAt) {
          // Past the deadline the task may still be running: keep what
          // its bound session did by now, as a failed case's evidence.
          const [partial] = await findMatchingClaudeSessions({
            ...match,
            sessionPath,
          }).catch(() => []);
          const wait =
            partial?.candidate.metadataPath === sessionPath
              ? deadlineWait(partial)
              : undefined;
          if (partial?.candidate.metadataPath === sessionPath)
            hostSessions = sessionIdsOf(partial);
          if (partial?.candidate.metadataPath === sessionPath)
            result = {
              finalText: partial.finalAnswer ?? '',
              events: toolCallEvents(
                coworkOwnToolCalls(
                  partial.toolCalls,
                  servers,
                  platform.mcpServerNames?.(),
                  platform.mcpServerLabels?.()
                ),
                servers
              ),
              ...(partial.modelCalls?.length
                ? { modelCalls: partial.modelCalls }
                : {}),
              usage: partial.usage,
              error:
                (wait
                  ? `${result.error} ${describeDeadlineWait(wait)}`
                  : result.error) ?? 'Client execution failed.',
              ...(ending ? { ending } : {}),
              ...taskTimes(partial),
              artifacts: {
                dir: partial.candidate.sessionDir,
                include: COWORK_SESSION_EVIDENCE,
              },
              telemetry: {
                source: 'claude-native',
                costScope: 'native-inference-only',
                ...partial.telemetry,
                nativeSessionId: partial.candidate.id,
                ...correlationTelemetry(partial),
                deadlineExceeded: true,
                ...(wait ? { deadlineWait: wait } : {}),
                ...(hitlWarning ? { hitlWarning } : {}),
              },
            };
        }
        if (platform.reset) continuation = 'reset';
      }
      // A HITL failure may leave a prompt open; reset before the next task.
      if (hitlError && platform.reset) continuation = 'reset';
      return finishCase();
    },
  };
}

/**
 * Cowork's own MCP servers (its sandbox's `workspace`, a plugin's bundled
 * server) are the client's tools, not the eval's: a call to a server the
 * batch didn't configure is a client-native event. Its raw name stays.
 */
export function coworkOwnToolCalls(
  calls: readonly LLMToolCall[],
  servers: readonly MCPConfig[],
  accountServerNames: readonly string[] = [],
  accountLabels: Readonly<Record<string, string>> = {}
): LLMToolCall[] {
  const nativeNames = [
    ...new Set([...accountServerNames, ...Object.keys(accountLabels)]),
  ];
  const labels = new Set([
    ...servers.map((server, index) => mcpServerLabel(server, index)),
    ...nativeNames,
    ...Object.values(accountLabels),
  ]);
  // The generic parser splits on the first __. Account connector names can
  // contain it too, so only the account's known prefixes establish identity.
  function nativeTool(raw: string | undefined) {
    if (!raw) return undefined;
    const matches = nativeNames.filter(
      (name) => raw.startsWith(`mcp__${name}__`) && raw.length > name.length + 7
    );
    if (matches.length > 1)
      throw new Error(
        `Ambiguous native MCP identity ${raw}: matches ${matches.join(', ')}. Rename the account connectors to remove the ambiguity; refusing attribution.`
      );
    const native = matches[0];
    return native === undefined
      ? undefined
      : {
          server: accountLabels[native] ?? native,
          name: raw.slice(`mcp__${native}__`.length),
        };
  }
  return calls.map((call) => {
    const identity = nativeTool(call.rawName);
    const server =
      identity?.server ??
      (call.server === undefined
        ? undefined
        : (accountLabels[call.server] ?? call.server));
    const source =
      call.source === 'mcp' && server !== undefined && !labels.has(server)
        ? 'builtin'
        : call.source;
    return {
      ...call,
      ...(identity ? { name: identity.name } : {}),
      ...(server !== undefined ? { server } : {}),
      ...(source !== undefined ? { source } : {}),
      ...(call.results
        ? {
            results: call.results.map((result) => ({
              ...result,
              ...(nativeTool(
                result.server === undefined
                  ? result.name
                  : `mcp__${result.server}__${result.name}`
              ) ??
                (result.server
                  ? { server: accountLabels[result.server] ?? result.server }
                  : {})),
            })),
          }
        : {}),
    };
  });
}

/**
 * Why Cowork's sandbox was unavailable to a task, if it was: a call to its
 * own `workspace` server that failed because the VM didn't start ("Workspace
 * unavailable. The isolated Linux environment failed to start (...)").
 */
export function coworkWorkspaceUnavailable(
  calls: readonly LLMToolCall[]
): string | undefined {
  const failed = calls.find(
    (call) =>
      call.isError === true &&
      (call.rawName ?? '').startsWith('mcp__workspace__') &&
      (call.output ?? '').trimStart().startsWith('Workspace unavailable')
  );
  if (!failed) return undefined;
  const reason = /failed to start \((.*)\)/.exec(failed.output ?? '')?.[1];
  return (reason ?? (failed.output ?? '').trim().split('\n')[0]!).slice(0, 300);
}

export function createCoworkClient(platform?: CoworkDesktop): ClientDefinition {
  // Its stdio servers resolve only once the app is prepared, so its batch
  // checks them after `prepare`, not the dispatch before it.
  const definition: ClientDefinition = checksServersAfterPrepare({
    schema: CoworkSchema,
    description: 'Claude Desktop in Cowork mode',
    requirements: {
      os: ['macos', 'linux'],
      install: [
        'macOS: Claude Desktop, signed in, the Xcode Command Line Tools, and Accessibility and Screen Recording permission for the terminal that runs MST',
        "Linux: MST's Cowork image (`--runner docker`), or a prepared desktop with Claude Desktop",
      ],
      credentials: [
        'macOS default third-party: `ANTHROPIC_API_KEY` for Cowork inference, unless managed preferences set its provider',
        'macOS first-party: Cowork inference uses the existing signed-in Claude account; MST installs no inference credential',
        'macOS both modes: `ANTHROPIC_API_KEY` or an LLM gateway for the Computer Use planner',
        'Linux image: Cowork inference, `ANTHROPIC_API_KEY` or an LLM gateway (`ANTHROPIC_BASE_URL` with `MST_LLM_AUTH_COMMAND` or `ANTHROPIC_AUTH_TOKEN`)',
      ],
      setup: [
        'macOS default third-party: `mst cowork setup`, then sign in to Claude Desktop once',
        'macOS first-party: use the installed Claude Desktop and Chrome signed in to the same Claude account, with its selected connectors connected; Chrome needs a loopback DevTools port (`MST_CLAUDE_AI_DEBUG_PORT`, default 9222). Do not run `mst cowork setup` for this mode',
        'Docker: `mst runner setup docker`',
      ],
    },
    evidence: 'structured',
    // Cowork sets up its MCP servers once per batch, so a tool variant goes
    // through one proxy endpoint for the whole batch.
    serversPerBatch: true,
    async open(options, context) {
      return openDesktopSession(
        await desktopAdapter([options], context, platform)
      );
    },
    async run(input, config, context) {
      if (!input.prompt.trim())
        throw new Error('Cowork cases require a non-empty input.');
      return (
        await collectClientBatch(
          definition,
          [{ caseId: 'single', trial: 0, input, config }],
          context
        )
      )[0]!;
    },
  });
  return definition;
}
export const COWORK_CLIENT = createCoworkClient();
