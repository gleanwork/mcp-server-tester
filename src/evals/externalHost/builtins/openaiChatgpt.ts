import { createHash } from 'node:crypto';
import { basename } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import {
  findChatgptTrace,
  snapshotChatgptSessions,
  type ChatgptSessionSnapshot,
  type ChatgptTrace,
  type ChatgptTraceBinding,
  type ChatgptTraceSelector,
} from './chatgptTrace.js';
import { copyChatgptEvidence } from './chatgptEvidence.js';
import { resolveCodexSetup } from '../../codexSetup/config.js';
import { ChatgptAppSession } from '../../chatgptSetup/session.js';
import {
  ComputerUseDriverError,
  chatgptSurface,
  isLinuxChatgpt,
  submitChatgptQuery,
  stringOption,
  validateChatgptConfig,
} from '../../chatgpt/driver.js';
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

import {
  NativeChatgptDriverError,
  runLinuxChatgptDesktop,
} from '../../chatgpt/linux.js';
import { validateLinuxChatgptConfig } from '../../chatgptSetup/linuxProfile.js';
import { hostPluginMcpServers } from '../../hostPlugins.js';

const POLL_INTERVAL_MS = 750;

/** Cold Linux first turns need time to flush; neither platform can exceed the run deadline. */
export function chatgptBindingDeadline(
  linux: boolean,
  now: number,
  runDeadline: number
): number {
  return Math.min(now + (linux ? 120_000 : 30_000), runDeadline);
}

/** Platform-specific input; shared lifecycle and strict native evidence. */
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
    {
      id: 'builtin:openai.chatgpt.nativeSurface',
      capabilities: ['control'],
      setup: snapshotBeforeSubmission,
    },
    {
      id: 'builtin:openai.chatgpt.nativeSubmit',
      capabilities: ['input'],
      run: submitChatgptPrompt,
    },
    {
      id: 'builtin:openai.chatgpt.nativeTrace',
      capabilities: ['completion', 'trace', 'normalize'],
      run: captureChatgptComputerUseResult,
    },
  ];

async function setupChatgptConfig({
  config,
  binding,
  state,
  run,
}: ExternalHostCapabilityContext): Promise<ExternalHostRunResult | void> {
  try {
    validateChatgptConfig(config);
    if (isLinuxChatgpt(config)) validateLinuxChatgptConfig(config);
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
      state.data.chatgptActiveSession = shared;
      state.data.chatgptSessionsRoot = shared.sessionsRoot;
      state.data.chatgptEvidenceDir = shared.evidenceDir;
    } else {
      const session = new ChatgptAppSession('case');
      state.data.chatgptAppSession = session;
      state.data.chatgptActiveSession = session;
      await session.prepare(config, settings);
      state.data.chatgptSessionsRoot = session.sessionsRoot;
      state.data.chatgptEvidenceDir = session.evidenceDir;
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
        'The caller must provide the authenticated desktop and platform permissions.',
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
  if (isLinuxChatgpt(config)) {
    try {
      const session = state.data.chatgptActiveSession;
      if (!(session instanceof ChatgptAppSession))
        throw new Error('Linux ChatGPT requires its MST-owned app session.');
      const receipt = await runLinuxChatgptDesktop(
        'submit',
        config,
        run.startedAtMs + run.timeoutMs,
        run.submittedScenario,
        (prompt) => session.openPrompt(prompt)
      );
      state.data.chatgptPromptSubmitted = true;
      state.data.chatgptNativeController = {
        provider: 'linux-atspi',
        surface: chatgptSurface(config),
        submission: { status: 'completed', telemetry: receipt.telemetry },
      } satisfies ExternalHostMetadata['nativeController'];
      return;
    } catch (error) {
      const nativeController: ExternalHostMetadata['nativeController'] = {
        provider: 'linux-atspi',
        surface: chatgptSurface(config),
        submission: {
          status: 'failed',
          ...(error instanceof NativeChatgptDriverError
            ? {
                telemetry: error.telemetry,
                ...(error.diagnostics.draftState
                  ? { draftState: { ...error.diagnostics.draftState } }
                  : {}),
              }
            : {}),
        },
      };
      return withEvidence(
        failureResult({
          config,
          context: run,
          driver: state.driver,
          displayName: state.displayName,
          capabilitiesUsed: state.capabilitiesUsed,
          nativeController,
          failureKind: 'submission_failed',
          error: `ChatGPT native submission failed: ${formatError(error)}`,
          limitations: [
            'No automatic resubmission is attempted after a failed or ambiguous native action.',
          ],
        }),
        run,
        state
      );
    }
  }
  try {
    const receipt = await submitChatgptQuery(
      run.submittedScenario,
      config,
      run.startedAtMs + run.timeoutMs
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
  let latest: { path: string; trace: ChatgptTrace } | undefined;
  const selector: ChatgptTraceSelector =
    run.correlation.strategy === 'exact_prompt'
      ? { strategy: 'exact_prompt', prompt: run.submittedScenario }
      : run.marker;
  const bindingDeadline = chatgptBindingDeadline(
    isLinuxChatgpt(config),
    Date.now(),
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
    nativeController: state.data
      .chatgptNativeController as ExternalHostMetadata['nativeController'],
  };
  try {
    const baseline = state.data.chatgptSessionBaseline as
      | ChatgptSessionSnapshot
      | undefined;
    if (!baseline || state.data.chatgptPromptSubmitted !== true)
      throw new Error(
        'Native telemetry requires a session baseline and a submitted prompt.'
      );
    const mcpServers = [
      ...(config.codexSetup
        ? resolveCodexSetup(
            config.codexSetup,
            state.data.chatgptConfigName as string | undefined
          ).servers.map((server) => server.label)
        : []),
      ...hostPluginMcpServers(config.plugins ?? []).map(
        (target) => target.server
      ),
    ];
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
          surface: chatgptSurface(config),
          mcpServers,
          nativeMarkdownEscapes: isLinuxChatgpt(config),
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
        latest = found;
        if (trace.complete) {
          if (trace.error)
            return withEvidence(
              partialFailure(
                metadataOptions,
                found,
                'host_run_failed',
                trace.error
              ),
              run,
              state,
              boundEvidence(bound)
            );
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
          return withEvidence(
            {
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
            },
            run,
            state,
            { path, summary: `Matched turn ${trace.turnId}` }
          );
        }
      }
      await delay(
        Math.min(
          POLL_INTERVAL_MS,
          Math.max(
            1,
            (matched ? run.startedAtMs + run.timeoutMs : bindingDeadline) -
              Date.now()
          )
        )
      );
    }
    const timeoutError =
      'Timed out waiting for the native ChatGPT turn to complete.';
    return withEvidence(
      latest
        ? partialFailure(metadataOptions, latest, 'timeout', timeoutError)
        : failureResult({
            ...metadataOptions,
            failureKind: matched ? 'timeout' : 'no_matching_session',
            error: matched
              ? timeoutError
              : 'No unique fresh native ChatGPT session matched the submitted query within the binding deadline.',
            limitations: [],
          }),
      run,
      state,
      boundEvidence(bound)
    );
  } catch (error) {
    const message = formatError(error);
    return withEvidence(
      failureResult({
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
      }),
      run,
      state,
      boundEvidence(bound)
    );
  }
}

/**
 * A bound turn that timed out or aborted: the case fails, but the native calls,
 * usage, and messages recorded so far are kept at low (partial) confidence.
 */
function partialFailure(
  options: MetadataOptions,
  { path, trace }: { path: string; trace: ChatgptTrace },
  failureKind: ExternalHostFailureKind,
  error: string
): ExternalHostRunResult {
  const metadata = buildMetadata(options);
  const usageSource = trace.usage ? 'host-local-transcript' : 'none';
  return {
    success: false,
    error,
    toolCalls: trace.toolCalls,
    conversationHistory: trace.conversationHistory,
    usage: trace.usage,
    externalHost: {
      ...metadata,
      failureKind,
      traceSource: 'host-local-transcript',
      traceConfidence: 'low',
      traceLimitations: trace.limitations,
      artifacts: [
        {
          kind: 'transcript',
          name: 'ChatGPT native session',
          path,
          contentType: 'application/x-ndjson',
          summary: `Bound turn ${trace.turnId}; did not complete successfully`,
        },
      ],
      session: {
        ...metadata.session,
        id: trace.sessionId,
        turnId: trace.turnId,
        startedAt: trace.startedAt,
        completedAt: trace.completedAt,
      },
      telemetry: trace.telemetry,
      sources: {
        finalAnswer: 'none',
        toolCalls: 'host-local-transcript',
        usage: usageSource,
        cost: 'none',
      },
      evidence: {
        finalAnswer: { source: 'none', confidence: 'unknown' },
        toolCalls: { source: 'host-local-transcript', confidence: 'low' },
        usage: {
          source: usageSource,
          confidence: trace.usage ? 'low' : 'unknown',
        },
        cost: { source: 'none', confidence: 'unknown' },
      },
    },
  };
}

function boundEvidence(
  bound: ChatgptTraceBinding | undefined
): { path: string; summary: string } | undefined {
  return bound
    ? {
        path: bound.path,
        summary: `Bound turn ${bound.turnId}; did not complete successfully`,
      }
    : undefined;
}

/**
 * Linux only: copy the matched transcript into MST_CHATGPT_EVIDENCE_DIR before
 * teardown. The artifact references the copy.
 * A matched transcript that cannot be preserved fails the case (fail closed).
 */
async function withEvidence(
  result: ExternalHostRunResult,
  run: ExternalHostCapabilityContext['run'],
  state: ExternalHostCapabilityContext['state'],
  matched?: { path: string; summary: string }
): Promise<ExternalHostRunResult> {
  const evidenceDir = state.data.chatgptEvidenceDir;
  const sessionsRoot = state.data.chatgptSessionsRoot;
  if (typeof evidenceDir !== 'string' || typeof sessionsRoot !== 'string')
    return result;
  const copy = await copyChatgptEvidence({
    evidenceDir,
    sessionsRoot,
    caseId: run.caseId,
    matched,
  });
  const external = result.externalHost;
  if (!external) return result;
  external.artifacts = [
    ...external.artifacts.filter(
      (artifact) => !(matched && artifact.path === matched.path)
    ),
    ...copy.artifacts,
  ];
  external.traceLimitations = [
    ...(external.traceLimitations ?? []),
    ...copy.limitations,
  ];
  if (result.success && copy.matchedCopied === false)
    return {
      success: false,
      toolCalls: [],
      error:
        'The matched native ChatGPT transcript could not be preserved as evidence.',
      externalHost: {
        ...external,
        failureKind: 'host_run_failed',
        traceSource: 'none',
        traceConfidence: 'unknown',
      },
    };
  return result;
}

interface MetadataOptions {
  config: ExternalHostConfig;
  context: ExternalHostCapabilityContext['run'];
  driver: HostDriverId;
  displayName: string;
  capabilitiesUsed: readonly HostCapability[];
  computerUse?: ExternalHostMetadata['computerUse'];
  nativeController?: ExternalHostMetadata['nativeController'];
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
    nativeController: options.nativeController,
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
function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
