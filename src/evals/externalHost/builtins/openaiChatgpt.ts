import { createHash, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { basename, dirname, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import {
  findChatgptTrace,
  isChatgptBuiltinServer,
  snapshotChatgptSessions,
  type ChatgptSessionSnapshot,
  type ChatgptTraceBinding,
  type ChatgptTraceSelector,
} from './chatgptTrace.js';
import {
  defaultChatgptAppPath,
  defaultChatgptBundleId,
  defaultChatgptConfigHome,
  getChatgptApplicationController,
} from './chatgptController.js';
import {
  installCodexConfig,
  resolveCodexSetup,
  type CodexConfigInstallation,
} from '../../codexSetup/config.js';
import {
  ComputerUseDriverError,
  runAnthropicComputerUseSubmission,
} from '../../cowork/anthropicComputerUse.js';
import type {
  ExternalHostCapabilityContext,
  ExternalHostCapabilityImplementation,
  ExternalHostConfig,
  ExternalHostFailureKind,
  ExternalHostMetadata,
  ExternalHostRunResult,
  HostCapability,
  HostDriverId,
} from '../types.js';
import { driverToSlug, hostTypeFromDriver } from '../driverIdentity.js';

const activeApplications = new Set<string>();
const POLL_INTERVAL_MS = 750;

/** The planner owns all UI navigation. Native code owns only app/config lifecycle. */
export const OPENAI_CHATGPT_CAPABILITIES: ExternalHostCapabilityImplementation[] =
  [
    {
      id: 'builtin:openai.chatgpt.configLifecycle',
      capabilities: ['control'],
      setup: setupChatgptConfig,
    },
    {
      id: 'builtin:openai.chatgpt.appLifecycle',
      capabilities: ['control'],
      setup: setupChatgptAppLifecycle,
      teardown: teardownChatgptAppLifecycle,
    },
    {
      id: 'builtin:openai.chatgpt.computerUseSurface',
      capabilities: ['control'],
      setup: snapshotBeforeSubmission,
    },
    {
      id: 'builtin:openai.chatgpt.computerUseSubmit',
      capabilities: ['input'],
      run: submitChatgptPrompt,
    },
    {
      id: 'builtin:openai.chatgpt.computerUseTrace',
      capabilities: ['completion', 'trace', 'normalize'],
      run: captureChatgptComputerUseResult,
    },
  ];

function plannerEnvironment(config: ExternalHostConfig): NodeJS.ProcessEnv {
  return {
    ...process.env,
    ...readLaunchEnvironment(config.options?.computerUseEnvironment),
  };
}

async function setupChatgptConfig({
  config,
  binding,
  state,
  run,
}: ExternalHostCapabilityContext): Promise<ExternalHostRunResult | void> {
  try {
    validateChatgptConfig(config);
    if (run.correlation.strategy === 'exact_prompt') {
      if (
        run.correlation.includedInPrompt ||
        run.submittedScenario !== run.scenario
      )
        throw new Error(
          'Exact-prompt correlation requires an unchanged prompt.'
        );
    } else if (
      run.correlation.strategy !== 'prompt_marker' ||
      !run.correlation.includedInPrompt
    ) {
      throw new Error(
        'ChatGPT requires exact_prompt or an included prompt_marker; uncorrelated telemetry is not supported.'
      );
    }
    if (!config.codexSetup) return;
    const configName =
      stringOption(binding.with, 'configName') ??
      stringOption(config.options, 'codexConfigName');
    const resolved = resolveCodexSetup(config.codexSetup, configName);
    if (basename(resolved.configPath) !== 'config.toml')
      throw new Error(
        'ChatGPT loads CODEX_HOME/config.toml; configPath must end in config.toml.'
      );
    state.data.chatgptConfigName = resolved.configName;
  } catch (error) {
    return failureResult({
      config,
      context: run,
      driver: state.driver,
      displayName: state.displayName,
      capabilitiesUsed: state.capabilitiesUsed,
      failureKind: 'submission_failed',
      error: formatError(error),
      limitations: [
        'Preflight failed before application or configuration changes.',
      ],
    });
  }
}

function validateChatgptConfig(config: ExternalHostConfig): void {
  if (
    (config.options?.computerUseProvider ?? 'anthropic-computer-use') !==
    'anthropic-computer-use'
  )
    throw new Error(
      'ChatGPT macOS requires the anthropic-computer-use driver; there is no deterministic UI fallback.'
    );
  if (config.options?.chatgptTrace === 'accessibility')
    throw new Error(
      'ChatGPT requires native transcript evidence, not UI answer extraction.'
    );
  if (!plannerEnvironment(config).ANTHROPIC_API_KEY)
    throw new Error(
      'ANTHROPIC_API_KEY is required for the Computer Use planner.'
    );
  const actions = config.options?.computerUseMaxActions ?? 32;
  if (!Number.isInteger(actions) || Number(actions) < 1 || Number(actions) > 64)
    throw new Error(
      'Computer Use action budget must be an integer from 1 to 64.'
    );
}

interface ChatgptLifecycleState {
  controller: Awaited<ReturnType<typeof getChatgptApplicationController>>;
  wasRunning: boolean;
  stopped: boolean;
  launchAttempted: boolean;
  installation?: CodexConfigInstallation;
}

function sessionSettings(
  config: ExternalHostConfig,
  binding?: Record<string, unknown>
) {
  const configName =
    stringOption(binding, 'configName') ??
    stringOption(config.options, 'codexConfigName');
  const setup = config.codexSetup
    ? resolveCodexSetup(config.codexSetup, configName)
    : undefined;
  if (setup?.servers.some((server) => isChatgptBuiltinServer(server.label)))
    throw new Error(
      'ChatGPT MCP server labels must not collide with built-in host tool namespaces.'
    );
  if (setup && basename(setup.configPath) !== 'config.toml')
    throw new Error(
      'ChatGPT loads CODEX_HOME/config.toml; configPath must end in config.toml.'
    );
  return {
    setup,
    model: config.model,
    reasoningEffort: config.reasoningEffort,
    environment: readLaunchEnvironment(config.options?.environment),
    appPath:
      stringOption(binding, 'appPath') ??
      stringOption(config.options, 'chatgptAppPath') ??
      defaultChatgptAppPath(),
    bundleId:
      stringOption(binding, 'bundleId') ??
      stringOption(config.options, 'chatgptBundleId') ??
      defaultChatgptBundleId(),
    sessionsRoot: stringOption(config.options, 'chatgptSessionRoot'),
  };
}

/** One app/config transaction. Per-query native baselines and run state never live here. */
export class ChatgptAppSession {
  #lifecycle?: ChatgptLifecycleState;
  #lease?: string;
  #settings?: ReturnType<typeof sessionSettings>;
  #ready = false;
  #disposed = false;
  sessionsRoot?: string;
  readonly telemetry = {
    id: randomUUID(),
    scope: 'batch' as 'batch' | 'case',
    setupStatus: 'not-started' as 'not-started' | 'completed' | 'failed',
    cleanupStatus: 'not-started' as 'not-started' | 'completed' | 'failed',
    setupDurationMs: 0,
    cleanupDurationMs: 0,
    events: [] as Array<{
      phase: 'setup' | 'cleanup';
      operation: string;
      completedAt: string;
    }>,
  };

  constructor(scope: 'batch' | 'case' = 'batch') {
    this.telemetry.scope = scope;
  }

  async prepare(
    config: ExternalHostConfig,
    binding?: Record<string, unknown>
  ): Promise<void> {
    if (this.#settings || this.#disposed)
      throw new Error('ChatGPT app session cannot be prepared twice.');
    const started = Date.now();
    try {
      validateChatgptConfig(config);
      const settings = sessionSettings(config, binding);
      this.#settings = settings;
      if (activeApplications.has(settings.bundleId))
        throw new Error(
          'Another MST run is already managing this ChatGPT application.'
        );
      activeApplications.add(settings.bundleId);
      this.#lease = settings.bundleId;
      process.stderr.write(
        '[mst:chatgpt] Anthropic Computer Use requires Screen Recording and Accessibility permission. Keep ChatGPT visible and the desktop idle.\n'
      );
      const controller = await getChatgptApplicationController({
        appPath: settings.appPath,
        bundleId: settings.bundleId,
      });
      const wasRunning = (await controller.state()).running;
      const lifecycle = (this.#lifecycle = {
        controller,
        wasRunning,
        stopped: false,
        launchAttempted: false,
      } as ChatgptLifecycleState);
      if (wasRunning) {
        await controller.stop();
        this.record('setup', 'stop');
      }
      lifecycle.stopped = true;
      const environment = { ...settings.environment };
      if (config.codexSetup) {
        lifecycle.installation = await installCodexConfig(config.codexSetup, {
          configName: settings.setup?.configName,
          model: config.model,
          reasoningEffort: config.reasoningEffort,
        });
        this.record('setup', 'install_config');
        const configHome = dirname(lifecycle.installation.configPath);
        if (
          configHome !== defaultChatgptConfigHome() ||
          environment.CODEX_HOME !== undefined
        )
          environment.CODEX_HOME = configHome;
      }
      this.sessionsRoot =
        settings.sessionsRoot ??
        join(
          environment.CODEX_HOME ??
            process.env.CODEX_HOME ??
            defaultChatgptConfigHome(),
          'sessions'
        );
      lifecycle.launchAttempted = true;
      await controller.start(environment);
      this.record('setup', 'start');
      this.#ready = true;
      this.telemetry.setupStatus = 'completed';
    } catch (error) {
      this.telemetry.setupStatus = 'failed';
      throw error;
    } finally {
      this.telemetry.setupDurationMs = Date.now() - started;
    }
  }

  assertCompatible(
    config: ExternalHostConfig,
    binding?: Record<string, unknown>
  ): void {
    if (
      !this.#ready ||
      this.#disposed ||
      !isDeepStrictEqual(this.#settings, sessionSettings(config, binding))
    )
      throw new Error(
        'ChatGPT batch app session is unavailable or has different settings.'
      );
  }

  async dispose(): Promise<void> {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#ready = false;
    const started = Date.now();
    try {
      const lifecycle = this.#lifecycle;
      if (lifecycle?.stopped) {
        if (lifecycle.launchAttempted) {
          await lifecycle.controller.stop();
          this.record('cleanup', 'stop');
        }
        if (lifecycle.installation) {
          await lifecycle.installation.restore({ archiveChanges: true });
          this.record('cleanup', 'restore_config');
        }
        if (lifecycle.wasRunning) {
          await lifecycle.controller.start();
          this.record('cleanup', 'start');
        }
      }
      this.telemetry.cleanupStatus = 'completed';
    } catch (error) {
      this.telemetry.cleanupStatus = 'failed';
      throw error;
    } finally {
      this.telemetry.cleanupDurationMs = Date.now() - started;
      if (this.#lease) activeApplications.delete(this.#lease);
    }
  }

  private record(phase: 'setup' | 'cleanup', operation: string): void {
    this.telemetry.events.push({
      phase,
      operation,
      completedAt: new Date().toISOString(),
    });
  }
}

async function setupChatgptAppLifecycle({
  config,
  binding,
  state,
  run,
}: ExternalHostCapabilityContext): Promise<ExternalHostRunResult | void> {
  try {
    const shared = config.options?.managedChatgptSession;
    const settings = {
      ...binding.with,
      configName: state.data.chatgptConfigName,
    };
    if (shared !== undefined) {
      if (!(shared instanceof ChatgptAppSession))
        throw new Error('Invalid managed ChatGPT app session.');
      shared.assertCompatible(config, settings);
      state.data.chatgptSessionsRoot = shared.sessionsRoot;
    } else {
      const session = new ChatgptAppSession('case');
      state.data.chatgptAppSession = session;
      await session.prepare(config, settings);
      state.data.chatgptSessionsRoot = session.sessionsRoot;
    }
  } catch (error) {
    return failureResult({
      config,
      context: run,
      driver: state.driver,
      displayName: state.displayName,
      capabilitiesUsed: state.capabilitiesUsed,
      failureKind: 'app_unavailable',
      error: `Failed to prepare ChatGPT desktop app: ${formatError(error)}`,
      limitations: [
        'The app lifecycle controller is macOS-only; it does not navigate the UI.',
      ],
    });
  }
}

async function teardownChatgptAppLifecycle({
  state,
}: ExternalHostCapabilityContext): Promise<void> {
  await (
    state.data.chatgptAppSession as ChatgptAppSession | undefined
  )?.dispose();
}

function readLaunchEnvironment(value: unknown): Record<string, string> {
  if (value === undefined) return {};
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.entries(value).some(
      ([key, entry]) =>
        !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || typeof entry !== 'string'
    )
  )
    throw new Error(
      'ChatGPT environment must map environment names to strings.'
    );
  return { ...value } as Record<string, string>;
}

async function snapshotBeforeSubmission({
  state,
}: ExternalHostCapabilityContext): Promise<void> {
  state.data.chatgptSessionBaseline = await snapshotChatgptSessions(
    state.data.chatgptSessionsRoot as string
  );
}

async function submitChatgptPrompt({
  config,
  run,
  state,
}: ExternalHostCapabilityContext): Promise<ExternalHostRunResult | void> {
  try {
    const receipt = await runAnthropicComputerUseSubmission(
      run.submittedScenario,
      {
        application: 'chatgpt',
        targetModel: config.model,
        reasoningEffort: config.reasoningEffort,
        model: stringOption(config.options, 'computerUseModel'),
        maxActions: Number(config.options?.computerUseMaxActions ?? 32),
        deadlineAt: run.startedAtMs + run.timeoutMs,
        env: plannerEnvironment(config),
      }
    );
    state.data.chatgptPromptSubmitted = true;
    state.data.chatgptComputerUse = {
      provider: 'anthropic-computer-use',
      submission: { status: 'completed', telemetry: receipt.telemetry },
    } satisfies ExternalHostMetadata['computerUse'];
  } catch (error) {
    const computerUse: ExternalHostMetadata['computerUse'] = {
      provider: 'anthropic-computer-use',
      submission: {
        status: 'failed',
        ...(error instanceof ComputerUseDriverError
          ? { telemetry: error.telemetry }
          : {}),
      },
    };
    state.data.chatgptComputerUse = computerUse;
    return failureResult({
      config,
      context: run,
      driver: state.driver,
      displayName: state.displayName,
      capabilitiesUsed: state.capabilitiesUsed,
      computerUse,
      failureKind: 'submission_failed',
      error: `ChatGPT Computer Use submission failed: ${formatError(error)}`,
      limitations: [
        'No automatic resubmission is attempted after a failed or ambiguous driver action.',
      ],
    });
  }
}

async function captureChatgptComputerUseResult({
  config,
  run,
  state,
}: ExternalHostCapabilityContext): Promise<ExternalHostRunResult> {
  let matched = false;
  let bound: ChatgptTraceBinding | undefined;
  const selector: ChatgptTraceSelector =
    run.correlation.strategy === 'exact_prompt'
      ? { strategy: 'exact_prompt', prompt: run.submittedScenario }
      : run.marker;
  const bindingDeadline = Math.min(
    Date.now() + 30_000,
    run.startedAtMs + run.timeoutMs
  );
  const computerUse = state.data
    .chatgptComputerUse as ExternalHostMetadata['computerUse'];
  const metadataOptions = {
    config,
    context: run,
    driver: state.driver,
    displayName: state.displayName,
    capabilitiesUsed: state.capabilitiesUsed,
    computerUse,
  };
  try {
    const baseline = state.data.chatgptSessionBaseline as
      | ChatgptSessionSnapshot
      | undefined;
    if (!baseline || state.data.chatgptPromptSubmitted !== true)
      throw new Error(
        'Native telemetry requires a session baseline and a submitted prompt.'
      );
    while (
      Date.now() < run.startedAtMs + run.timeoutMs &&
      (matched || Date.now() < bindingDeadline)
    ) {
      const found = await findChatgptTrace(
        state.data.chatgptSessionsRoot as string,
        baseline,
        selector,
        run.startedAtMs,
        {
          requireFreshSession: true,
          observedBeforeMs: Math.min(
            Date.now(),
            run.startedAtMs + run.timeoutMs
          ),
          bound,
        }
      );
      if (found) {
        matched = true;
        const { trace, path } = found;
        bound ??= { path, sessionId: trace.sessionId, turnId: trace.turnId };
        if (trace.complete) {
          if (trace.error) throw new Error(trace.error);
          if (config.model && trace.model !== config.model)
            throw new Error(
              `ChatGPT model mismatch: requested ${config.model}, recorded ${trace.model ?? 'unknown'}.`
            );
          if (
            config.reasoningEffort &&
            trace.reasoningEffort !== config.reasoningEffort
          )
            throw new Error(
              `ChatGPT reasoning effort mismatch: requested ${config.reasoningEffort}, recorded ${trace.reasoningEffort ?? 'unknown'}.`
            );
          if (!trace.response)
            throw new Error(
              'Completed ChatGPT turn has no native final answer.'
            );
          const metadata = buildMetadata(metadataOptions);
          return {
            success: true,
            response: trace.response,
            toolCalls: trace.toolCalls,
            conversationHistory: trace.conversationHistory,
            usage: trace.usage,
            llmDurationMs: trace.llmDurationMs,
            mcpDurationMs: trace.mcpDurationMs,
            externalHost: {
              ...metadata,
              correlation: {
                ...metadata.correlation,
                ...(trace.promptMatch
                  ? {
                      nativePromptMatch: trace.promptMatch,
                      nativePromptSha256: trace.nativePromptSha256,
                    }
                  : {}),
              },
              traceSource: 'host-local-transcript',
              traceConfidence: 'high',
              traceLimitations: trace.limitations,
              artifacts: [
                {
                  kind: 'transcript',
                  name: 'ChatGPT native session',
                  path,
                  contentType: 'application/x-ndjson',
                  summary: `Matched turn ${trace.turnId}`,
                },
              ],
              session: {
                id: trace.sessionId,
                turnId: trace.turnId,
                ...(run.correlation.includedInPrompt
                  ? { runMarker: run.marker }
                  : {}),
                startedAt: trace.startedAt,
                completedAt: trace.completedAt,
              },
              telemetry: trace.telemetry,
              sources: {
                finalAnswer: 'host-local-transcript',
                toolCalls: 'host-local-transcript',
                usage: trace.usage ? 'host-local-transcript' : 'none',
                cost: 'none',
              },
              evidence: {
                finalAnswer: {
                  source: 'host-local-transcript',
                  confidence: 'high',
                },
                toolCalls: {
                  source: 'host-local-transcript',
                  confidence: 'high',
                },
                usage: {
                  source: trace.usage ? 'host-local-transcript' : 'none',
                  confidence: trace.usage ? 'high' : 'unknown',
                },
                cost: { source: 'none', confidence: 'unknown' },
              },
            },
          };
        }
      }
      await delay(
        Math.min(
          POLL_INTERVAL_MS,
          Math.max(1, run.startedAtMs + run.timeoutMs - Date.now())
        )
      );
    }
    return failureResult({
      ...metadataOptions,
      failureKind: matched ? 'timeout' : 'no_matching_session',
      error: matched
        ? 'Timed out waiting for the native ChatGPT turn to complete.'
        : 'No unique fresh native ChatGPT session matched the submitted query within the binding deadline.',
      limitations: [],
    });
  } catch (error) {
    const message = formatError(error);
    return failureResult({
      ...metadataOptions,
      failureKind: message.includes('Ambiguous')
        ? 'ambiguous_matching_sessions'
        : message.includes('mismatch') ||
            message.includes('aborted') ||
            message.includes('Bound ChatGPT') ||
            message.includes('fresh ChatGPT')
          ? 'host_run_failed'
          : 'parse_failure',
      error: message,
      limitations: [],
    });
  }
}

interface MetadataOptions {
  config: ExternalHostConfig;
  context: ExternalHostCapabilityContext['run'];
  driver: HostDriverId;
  displayName: string;
  capabilitiesUsed: readonly HostCapability[];
  computerUse?: ExternalHostMetadata['computerUse'];
}
function buildMetadata(options: MetadataOptions): ExternalHostMetadata {
  return {
    driver: options.driver,
    driverSlug: driverToSlug(options.driver),
    displayName: options.displayName,
    hostName: options.displayName,
    hostType: options.config.hostType ?? hostTypeFromDriver(options.driver),
    hostVariant: options.config.variant,
    capabilitiesUsed: [...options.capabilitiesUsed],
    traceSource: 'none',
    traceConfidence: 'unknown',
    artifacts: [],
    session: options.context.correlation.includedInPrompt
      ? { runMarker: options.context.marker }
      : {},
    correlation: {
      ...options.context.correlation,
      promptSha256: createHash('sha256')
        .update(options.context.submittedScenario, 'utf8')
        .digest('hex'),
      promptUnchanged:
        options.context.submittedScenario === options.context.scenario,
    },
    computerUse: options.computerUse,
  };
}
function failureResult(
  options: MetadataOptions & {
    failureKind: ExternalHostFailureKind;
    error: string;
    limitations: string[];
  }
): ExternalHostRunResult {
  return {
    success: false,
    toolCalls: [],
    error: options.error,
    externalHost: {
      ...buildMetadata(options),
      failureKind: options.failureKind,
      traceLimitations: options.limitations,
    },
  };
}
function stringOption(
  options: Record<string, unknown> | undefined,
  key: string
): string | undefined {
  const value = options?.[key];
  return typeof value === 'string' ? value : undefined;
}
function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
