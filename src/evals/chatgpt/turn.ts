/**
 * One trial on the ChatGPT app (`chatgpt` and `codex-app`), in the order it
 * runs: check the settings and resolve the app config, use the batch's app
 * session, snapshot the native sessions, submit the prompt once through the
 * trial machine's OS, then capture and attribute the native turn and keep
 * its evidence. Nothing here resubmits a prompt.
 */
import { createHash, randomUUID } from 'node:crypto';
import { basename } from 'node:path';
import { stat } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import {
  findChatgptTranscript,
  PendingChatgptRecordError,
  snapshotChatgptSessions,
  type ChatgptSessionSnapshot,
  type ChatgptTranscript,
  type ChatgptTranscriptBinding,
  type ChatgptTranscriptSelector,
} from './transcript.js';
import { copyChatgptEvidence } from './evidence.js';
import {
  NativeTranscriptError,
  nativeTranscriptFailureKind,
} from '../nativeTranscriptError.js';
import { resolveCodexSetup } from '../codexSetup/config.js';
import type { ChatgptAppSession } from '../chatgptSetup/session.js';
import {
  ComputerUseDriverError,
  chatgptSurface,
  isLinuxChatgpt,
  submitChatgptQuery,
  stringOption,
  validateChatgptConfig,
} from './driver.js';
import {
  NativeChatgptDriverError,
  runLinuxChatgptDesktop,
} from './linuxDesktop.js';
import type { ChatgptDesktop } from './desktop.js';
import { clientPluginMcpServers } from '../clientPlugins.js';
import { CHATGPT_STALL_MS, saveStallScreenshot } from './stallScreenshot.js';
import type { ChatgptAppConfig } from './config.js';
import type {
  ClientMetadata,
  ExternalClientCorrelationMetadata,
  ExternalClientFailureKind,
} from '../clientTelemetryTypes.js';
import type { LLMToolCall } from '../mstClient/types.js';
import type { UsageMetrics } from '../../types/index.js';
import type { ModelCall } from '../evalFrameworkTypes.js';

const POLL_INTERVAL_MS = 750;
const DEFAULT_TIMEOUT_MS = 120_000;
const PROMPT_MARKER_TEMPLATE =
  'Transcript marker for MCP Server Tester; do not mention this marker in your response: [eval-run-marker:{{marker}}]';

/** One trial's prompt, correlation and deadline. */
export interface ChatgptTrial {
  caseId: string;
  /** The case's prompt. */
  input: string;
  /** What is sent: the prompt, with a marker when correlation includes one. */
  submittedInput: string;
  marker: string;
  correlation: ExternalClientCorrelationMetadata;
  timeoutMs: number;
  startedAtMs: number;
}

/** What one trial's steps share. */
export interface ChatgptTurnState {
  /** The concrete entry point selected when this batch opened. */
  desktop: ChatgptDesktop;
  config: ChatgptAppConfig;
  trial: ChatgptTrial;
  /** The resolved native config name, from the settings check. */
  configName?: string;
  /** The batch's app session, once the trial may use it. */
  session?: ChatgptAppSession;
  sessionsRoot?: string;
  /** Linux only: where matched transcripts are copied before teardown. */
  evidenceDir?: string;
  /** Native sessions that existed before submission. */
  baseline?: ChatgptSessionSnapshot;
  promptSubmitted: boolean;
  /** macOS submission receipt. */
  computerUse?: ClientMetadata['computerUse'];
  /** Linux submission receipt. */
  nativeController?: ClientMetadata['nativeController'];
}

interface ChatgptTurnSuccess {
  success: true;
  response?: string;
  toolCalls: LLMToolCall[];
  modelCalls?: ModelCall[];
  conversationHistory?: ChatgptTranscript['conversationHistory'];
  usage?: UsageMetrics;
  llmDurationMs?: number;
  mcpDurationMs?: number;
  clientMetadata: ClientMetadata;
}

interface ChatgptTurnFailure {
  success: false;
  error: string;
  toolCalls: LLMToolCall[];
  modelCalls?: ModelCall[];
  /** Partial native evidence from a bound turn that did not complete. */
  conversationHistory?: ChatgptTranscript['conversationHistory'];
  usage?: UsageMetrics;
  clientMetadata: ClientMetadata;
}

/**
 * What a trial's native turn came to: its answer, or why it failed and the
 * failure kind that decides its ending (ADR 0010), with the native calls,
 * usage and evidence it kept.
 */
export type ChatgptTurn = ChatgptTurnSuccess | ChatgptTurnFailure;

/** When a fresh native session must have appeared; never after the run deadline. */
export function chatgptBindingDeadline(
  desktop: ChatgptDesktop,
  now: number,
  runDeadline: number
): number {
  return Math.min(now + desktop.bindingWindowMs, runDeadline);
}

/**
 * Run one trial on the batch's prepared app session. The prompt is sent
 * once at most; every failure comes back as a turn with its failure kind.
 */
export async function runChatgptTurn(
  prompt: string,
  config: ChatgptAppConfig,
  session: ChatgptAppSession,
  options: { caseId?: string } = {}
): Promise<ChatgptTurn> {
  const state: ChatgptTurnState = {
    desktop: session.desktop,
    config,
    trial: chatgptTrial(prompt, config, options.caseId ?? 'unknown'),
    promptSubmitted: false,
  };
  try {
    const rejected =
      checkChatgptSettings(state) ?? useAppSession(state, session);
    if (rejected) return rejected;
    await snapshotBeforeSubmission(state);
    const failedSubmission = await submitChatgptPrompt(state);
    if (failedSubmission) return failedSubmission;
    return await captureChatgptTurn(state);
  } catch (error) {
    // A step that threw instead of returning its failure.
    return failureResult(state, {
      failureKind: 'client_run_failed',
      error: `ChatGPT trial failed: ${formatError(error)}`,
      limitations: ['The ChatGPT trial did not produce a result.'],
    });
  }
}

/** The trial's marker, correlation and the prompt it sends. */
export function chatgptTrial(
  input: string,
  config: ChatgptAppConfig,
  caseId: string
): ChatgptTrial {
  const marker = `MCP_SERVER_TESTER_external-client-${randomUUID()}`;
  // Exact-prompt matching unless the config asks for a marker.
  const requested = {
    strategy: 'exact_prompt' as const,
    ...config.correlation,
  };
  const strategy = requested.strategy ?? 'none';
  const correlation: ExternalClientCorrelationMetadata = {
    strategy,
    marker,
    includedInPrompt:
      strategy === 'prompt_marker'
        ? (requested.includeInPrompt ?? true)
        : false,
  };
  return {
    caseId,
    input,
    submittedInput: correlation.includedInPrompt
      ? `${input}\n\n${PROMPT_MARKER_TEMPLATE.replaceAll('{{marker}}', marker)}`
      : input,
    marker,
    correlation,
    timeoutMs: config.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    startedAtMs: Date.now(),
  };
}

/** Validate the settings and resolve the app config, before the app is touched. */
export function checkChatgptSettings(
  state: ChatgptTurnState
): ChatgptTurn | undefined {
  const { config, trial } = state;
  try {
    validateChatgptConfig(config);
    state.desktop.validate(config);
    if (trial.correlation.strategy === 'exact_prompt') {
      if (
        trial.correlation.includedInPrompt ||
        trial.submittedInput !== trial.input
      )
        throw new Error(
          'Exact-prompt correlation requires an unchanged prompt.'
        );
    } else if (
      trial.correlation.strategy !== 'prompt_marker' ||
      !trial.correlation.includedInPrompt
    ) {
      throw new Error(
        'ChatGPT requires exact_prompt or an included prompt_marker; uncorrelated telemetry is not supported.'
      );
    }
    if (!config.codexSetup) return undefined;
    const resolved = resolveCodexSetup(
      config.codexSetup,
      stringOption(config.options, 'codexConfigName')
    );
    if (basename(resolved.configPath) !== 'config.toml')
      throw new Error(
        'ChatGPT loads CODEX_HOME/config.toml; configPath must end in config.toml.'
      );
    state.configName = resolved.configName;
    return undefined;
  } catch (error) {
    return failureResult(state, {
      failureKind: 'submission_failed',
      error: formatError(error),
      limitations: [
        'Preflight failed before application or configuration changes.',
      ],
    });
  }
}

/**
 * Use the batch's prepared app session, which must have been prepared with
 * these settings. The trial never prepares or disposes an app itself.
 */
export function useAppSession(
  state: ChatgptTurnState,
  session: ChatgptAppSession
): ChatgptTurn | undefined {
  try {
    session.assertCompatible(state.config, { configName: state.configName });
    state.session = session;
    state.sessionsRoot = session.sessionsRoot;
    state.evidenceDir = session.evidenceDir;
    return undefined;
  } catch (error) {
    return failureResult(state, {
      failureKind: 'app_unavailable',
      error: `Failed to prepare ChatGPT desktop app: ${formatError(error)}`,
      limitations: [
        'The caller must provide the authenticated desktop and platform permissions.',
      ],
    });
  }
}

/** Snapshot the native sessions before submission. */
async function snapshotBeforeSubmission(
  state: ChatgptTurnState
): Promise<void> {
  state.baseline = await snapshotChatgptSessions(state.sessionsRoot as string);
}

/** Submit once through the trial machine's OS. */
export async function submitChatgptPrompt(
  state: ChatgptTurnState
): Promise<ChatgptTurn | void> {
  return state.desktop.submit(state);
}

/** Linux: deterministic AT-SPI actions through the MST-owned app session. */
export async function submitNatively(
  state: ChatgptTurnState
): Promise<ChatgptTurn | void> {
  const { config, trial } = state;
  try {
    const session = state.session;
    if (!session)
      throw new Error('Linux ChatGPT requires its MST-owned app session.');
    const receipt = await runLinuxChatgptDesktop(
      'submit',
      config,
      trial.startedAtMs + trial.timeoutMs,
      trial.submittedInput,
      (prompt) => session.openPrompt(prompt)
    );
    state.promptSubmitted = true;
    state.nativeController = {
      provider: 'linux-atspi',
      surface: chatgptSurface(config),
      submission: { status: 'completed', telemetry: receipt.telemetry },
    };
    return;
  } catch (error) {
    const nativeController: ClientMetadata['nativeController'] = {
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
    // Show what covered the composer; capture never changes the outcome.
    const screenshot =
      typeof state.evidenceDir === 'string'
        ? await saveStallScreenshot({
            evidenceDir: state.evidenceDir,
            caseId: trial.caseId,
            display: process.env.DISPLAY,
            xauthority: process.env.XAUTHORITY,
            label: 'submit',
          })
        : { error: 'No MST-owned evidence directory.' };
    const result = await withEvidence(
      failureResult(state, {
        nativeController,
        failureKind: 'submission_failed',
        error: `ChatGPT native submission failed: ${formatError(error)}`,
        limitations: [
          'No automatic resubmission is attempted after a failed or ambiguous native action.',
        ],
      }),
      state
    );
    attachScreenshot(
      result,
      screenshot,
      'ChatGPT display at submission failure'
    );
    return result;
  }
}

/** macOS: Anthropic Computer Use fills and submits the composer. */
export async function submitWithComputerUse(
  state: ChatgptTurnState
): Promise<ChatgptTurn | void> {
  const { config, trial } = state;
  try {
    state.session?.noteSubmission(trial.submittedInput);
    const receipt = await submitChatgptQuery(
      trial.submittedInput,
      config,
      trial.startedAtMs + trial.timeoutMs,
      state.session?.workspace
    );
    state.promptSubmitted = true;
    state.computerUse = {
      provider: 'anthropic-computer-use',
      submission: { status: 'completed', telemetry: receipt.telemetry },
    };
  } catch (error) {
    const computerUse: ClientMetadata['computerUse'] = {
      provider: 'anthropic-computer-use',
      submission: {
        status: 'failed',
        ...(error instanceof ComputerUseDriverError
          ? { telemetry: error.telemetry }
          : {}),
      },
    };
    state.computerUse = computerUse;
    return failureResult(state, {
      computerUse,
      failureKind: 'submission_failed',
      error: `ChatGPT Computer Use submission failed: ${formatError(error)}`,
      limitations: [
        'No automatic resubmission is attempted after a failed or ambiguous driver action.',
      ],
    });
  }
}

/** Fail a silent Linux turn early and attach a display screenshot. */
async function stalledResult(
  state: ChatgptTurnState,
  found: { path: string; transcript: ChatgptTranscript },
  bound: ChatgptTranscriptBinding | undefined,
  silentMs: number
): Promise<ChatgptTurn> {
  const silentSeconds = Math.round(silentMs / 1000);
  const { evidenceDir } = state;
  const screenshot =
    typeof evidenceDir === 'string' && isLinuxChatgpt(state.config)
      ? await saveStallScreenshot({
          evidenceDir,
          caseId: state.trial.caseId,
          display: process.env.DISPLAY,
          xauthority: process.env.XAUTHORITY,
        })
      : { error: 'Screenshots are captured only on Linux ChatGPT.' };
  const result = await withEvidence(
    partialFailure(
      state,
      found,
      'timeout',
      `ChatGPT turn stalled: its transcript was silent for ${silentSeconds}s (limit ${CHATGPT_STALL_MS / 1000}s).`
    ),
    state,
    boundEvidence(bound)
  );
  attachScreenshot(
    result,
    screenshot,
    'ChatGPT display at stall',
    `Captured after ${silentSeconds}s of transcript silence`
  );
  return result;
}

function attachScreenshot(
  result: ChatgptTurn,
  screenshot: { path?: string; error?: string },
  name: string,
  summary?: string
): void {
  const external = result.clientMetadata;
  if (!external) return;
  if (screenshot.path)
    external.artifacts = [
      ...external.artifacts,
      {
        kind: 'screenshot',
        name,
        path: screenshot.path,
        contentType: 'image/png',
        ...(summary ? { summary } : {}),
      },
    ];
  else
    external.transcriptLimitations = [
      ...(external.transcriptLimitations ?? []),
      `${name} screenshot unavailable: ${screenshot.error}`,
    ];
}

/**
 * Bind one fresh native turn to the submitted prompt, wait for it to
 * complete, and verify its model, reasoning effort and surface. A turn that
 * fails keeps what it recorded, at low confidence; an ambiguous match fails.
 */
export async function captureChatgptTurn(
  state: ChatgptTurnState
): Promise<ChatgptTurn> {
  const { config, trial } = state;
  let matched = false;
  let bound: ChatgptTranscriptBinding | undefined;
  let latest: { path: string; transcript: ChatgptTranscript } | undefined;
  const steps = state.desktop;
  const runDeadline = trial.startedAtMs + trial.timeoutMs;
  // Transcript growth is the only progress signal; a silent turn is stalled.
  let pendingRecordSince: number | undefined;
  // Consecutive pending reads; one read alone doesn't show an unfinished rewrite.
  let pendingReads = 0;
  // The wait is measured from here: setup and submission happen before it.
  const collectionStartedAt = Date.now();
  // A bound turn's wait starts when it bound: its deadline is the run's.
  let boundAtMs: number | undefined;
  let progressKey: string | undefined;
  let progressAtMs = Date.now();
  const selector: ChatgptTranscriptSelector =
    trial.correlation.strategy === 'exact_prompt'
      ? { strategy: 'exact_prompt', prompt: trial.submittedInput }
      : trial.marker;
  const bindingDeadline = chatgptBindingDeadline(
    steps,
    Date.now(),
    runDeadline
  );
  // A rewrite that never finishes is a transcript failure, not a lost
  // submission. Keep what the bound turn recorded before it.
  const unfinishedRewrite = async (error: string): Promise<ChatgptTurn> => {
    const result = await withEvidence(
      latest
        ? partialFailure(state, latest, 'parse_failure', error)
        : failureResult(state, {
            failureKind: 'parse_failure',
            error,
            limitations: [],
          }),
      state,
      boundEvidence(bound)
    );
    // Without a bound turn, keep the display, as a binding timeout does.
    if (!latest && isLinuxChatgpt(config) && state.evidenceDir)
      attachScreenshot(
        result,
        await saveStallScreenshot({
          evidenceDir: state.evidenceDir,
          caseId: trial.caseId,
          display: process.env.DISPLAY,
          xauthority: process.env.XAUTHORITY,
        }),
        'ChatGPT display at native binding timeout'
      );
    return result;
  };
  try {
    const baseline = state.baseline;
    if (!baseline || !state.promptSubmitted)
      throw new Error(
        'Native telemetry requires a session baseline and a submitted prompt.'
      );
    const mcpServers = [
      ...(config.codexSetup
        ? resolveCodexSetup(config.codexSetup, state.configName).servers.map(
            (server) => server.label
          )
        : []),
      ...clientPluginMcpServers(config.plugins ?? []).map(
        (target) => target.server
      ),
    ];
    while (
      Date.now() < runDeadline &&
      (matched || Date.now() < bindingDeadline)
    ) {
      let found: Awaited<ReturnType<typeof findChatgptTranscript>>;
      try {
        found = await findChatgptTranscript(
          state.sessionsRoot as string,
          baseline,
          selector,
          trial.startedAtMs,
          {
            surface: chatgptSurface(config),
            mcpServers,
            nativeMarkdownEscapes: steps.nativeMarkdownEscapes,
            requireFreshSession: true,
            observedBeforeMs: Math.min(Date.now(), runDeadline),
            bound,
          }
        );
        pendingRecordSince = undefined;
        pendingReads = 0;
      } catch (error) {
        if (!(error instanceof PendingChatgptRecordError)) throw error;
        pendingRecordSince ??= Date.now();
        pendingReads += 1;
        if (Date.now() - pendingRecordSince >= CHATGPT_STALL_MS)
          return await unfinishedRewrite(
            'Native ChatGPT record rewrite did not complete within the stall deadline.'
          );
        // Read-only polling: no record is accepted or discarded, and no prompt
        // is resubmitted. A completed replacement must pass the usual parser.
        await delay(
          Math.min(
            POLL_INTERVAL_MS,
            Math.max(1, (matched ? runDeadline : bindingDeadline) - Date.now())
          )
        );
        continue;
      }
      if (found) {
        matched = true;
        const { transcript, path } = found;
        boundAtMs ??= Date.now();
        bound ??= {
          path,
          sessionId: transcript.sessionId,
          turnId: transcript.turnId,
        };
        latest = found;
        const size = await stat(path).then(
          (info) => `${info.size}:${info.mtimeMs}`,
          () => undefined
        );
        if (size !== progressKey) {
          progressKey = size;
          progressAtMs = Date.now();
        }
        if (
          !transcript.complete &&
          Date.now() - progressAtMs >= CHATGPT_STALL_MS
        )
          return await stalledResult(
            state,
            found,
            bound,
            Date.now() - progressAtMs
          );
        // Awaited here, so a mismatch it throws is classified below.
        if (transcript.complete)
          return await completedTurn(state, found, bound);
      }
      await delay(
        Math.min(
          POLL_INTERVAL_MS,
          Math.max(1, (matched ? runDeadline : bindingDeadline) - Date.now())
        )
      );
    }
    // Only a rewrite left unfinished for most of this wait is why the wait
    // failed; one caught on the last poll is an ordinary timeout.
    const waitEnd = matched ? runDeadline : bindingDeadline;
    if (
      pendingRecordSince !== undefined &&
      pendingReads > 1 &&
      waitEnd - pendingRecordSince >=
        (waitEnd - (boundAtMs ?? collectionStartedAt)) / 2
    )
      return await unfinishedRewrite(
        matched
          ? 'Native ChatGPT record rewrite did not complete before the run timeout.'
          : 'Native ChatGPT record rewrite did not complete before the binding deadline.'
      );
    const timeoutError =
      'Timed out waiting for the native ChatGPT turn to complete.';
    const result = await withEvidence(
      latest
        ? partialFailure(state, latest, 'timeout', timeoutError)
        : failureResult(state, {
            failureKind: matched ? 'timeout' : 'no_matching_session',
            error: matched
              ? timeoutError
              : 'No unique fresh native ChatGPT session matched the submitted query within the binding deadline.',
            limitations: [],
          }),
      state,
      boundEvidence(bound)
    );
    // An acknowledged Send is not proof of a fresh native session. Keep the
    // failure, but preserve the display to diagnose a lost/blocked submission.
    if (!latest && isLinuxChatgpt(config) && state.evidenceDir) {
      attachScreenshot(
        result,
        await saveStallScreenshot({
          evidenceDir: state.evidenceDir,
          caseId: trial.caseId,
          display: process.env.DISPLAY,
          xauthority: process.env.XAUTHORITY,
        }),
        'ChatGPT display at native binding timeout'
      );
    }
    return result;
  } catch (error) {
    return withEvidence(
      failureResult(state, {
        // Anything not classified where it was detected is a transcript we
        // could not read as expected.
        failureKind: nativeTranscriptFailureKind(error, 'parse_failure'),
        error: formatError(error),
        limitations: [],
      }),
      state,
      boundEvidence(bound)
    );
  }
}

/**
 * A completed native turn: it fails when it recorded an error, or when its
 * model or reasoning effort isn't what the trial asked for.
 */
async function completedTurn(
  state: ChatgptTurnState,
  found: { path: string; transcript: ChatgptTranscript },
  bound: ChatgptTranscriptBinding | undefined
): Promise<ChatgptTurn> {
  const { config, trial } = state;
  const { transcript, path } = found;
  if (transcript.error)
    return withEvidence(
      partialFailure(state, found, 'client_run_failed', transcript.error),
      state,
      boundEvidence(bound)
    );
  if (config.model && transcript.model !== config.model)
    throw new NativeTranscriptError(
      'client_run_failed',
      `ChatGPT model mismatch: requested ${config.model}, recorded ${transcript.model ?? 'unknown'}.`
    );
  if (
    config.reasoningEffort &&
    transcript.reasoningEffort !== config.reasoningEffort
  )
    throw new NativeTranscriptError(
      'client_run_failed',
      `ChatGPT reasoning effort mismatch: requested ${config.reasoningEffort}, recorded ${transcript.reasoningEffort ?? 'unknown'}.`
    );
  if (!transcript.response)
    throw new Error('Completed ChatGPT turn has no native final answer.');
  const metadata = buildMetadata(state);
  return withEvidence(
    {
      success: true,
      response: transcript.response,
      toolCalls: transcript.toolCalls,
      ...(transcript.modelCalls ? { modelCalls: transcript.modelCalls } : {}),
      conversationHistory: transcript.conversationHistory,
      usage: transcript.usage,
      llmDurationMs: transcript.llmDurationMs,
      mcpDurationMs: transcript.mcpDurationMs,
      clientMetadata: {
        ...metadata,
        correlation: {
          ...metadata.correlation,
          ...(transcript.promptMatch
            ? {
                nativePromptMatch: transcript.promptMatch,
                nativePromptSha256: transcript.nativePromptSha256,
              }
            : {}),
        },
        transcriptSource: 'client-local-transcript',
        transcriptConfidence: 'high',
        transcriptLimitations: transcript.limitations,
        artifacts: [
          {
            kind: 'transcript',
            name: 'ChatGPT native session',
            path,
            contentType: 'application/x-ndjson',
            summary: `Matched turn ${transcript.turnId}`,
          },
        ],
        session: {
          id: transcript.sessionId,
          turnId: transcript.turnId,
          ...(trial.correlation.includedInPrompt
            ? { runMarker: trial.marker }
            : {}),
          startedAt: transcript.startedAt,
          completedAt: transcript.completedAt,
        },
        telemetry: transcript.telemetry,
        sources: {
          finalAnswer: 'client-local-transcript',
          toolCalls: 'client-local-transcript',
          usage: transcript.usage ? 'client-local-transcript' : 'none',
          cost: 'none',
        },
        evidence: {
          finalAnswer: {
            source: 'client-local-transcript',
            confidence: 'high',
          },
          toolCalls: {
            source: 'client-local-transcript',
            confidence: 'high',
          },
          usage: {
            source: transcript.usage ? 'client-local-transcript' : 'none',
            confidence: transcript.usage ? 'high' : 'unknown',
          },
          cost: { source: 'none', confidence: 'unknown' },
        },
      },
    },
    state,
    { path, summary: `Matched turn ${transcript.turnId}` }
  );
}

/**
 * A bound turn that timed out or aborted: the case fails, but the native calls,
 * usage, and messages recorded so far are kept at low (partial) confidence.
 */
function partialFailure(
  state: ChatgptTurnState,
  { path, transcript }: { path: string; transcript: ChatgptTranscript },
  failureKind: ExternalClientFailureKind,
  error: string
): ChatgptTurn {
  const metadata = buildMetadata(state);
  const usageSource = transcript.usage ? 'client-local-transcript' : 'none';
  return {
    success: false,
    error,
    toolCalls: transcript.toolCalls,
    ...(transcript.modelCalls ? { modelCalls: transcript.modelCalls } : {}),
    conversationHistory: transcript.conversationHistory,
    usage: transcript.usage,
    clientMetadata: {
      ...metadata,
      failureKind,
      transcriptSource: 'client-local-transcript',
      transcriptConfidence: 'low',
      transcriptLimitations: transcript.limitations,
      artifacts: [
        {
          kind: 'transcript',
          name: 'ChatGPT native session',
          path,
          contentType: 'application/x-ndjson',
          summary: `Bound turn ${transcript.turnId}; did not complete successfully`,
        },
      ],
      session: {
        ...metadata.session,
        id: transcript.sessionId,
        turnId: transcript.turnId,
        startedAt: transcript.startedAt,
        completedAt: transcript.completedAt,
      },
      telemetry: transcript.telemetry,
      sources: {
        finalAnswer: 'none',
        toolCalls: 'client-local-transcript',
        usage: usageSource,
        cost: 'none',
      },
      evidence: {
        finalAnswer: { source: 'none', confidence: 'unknown' },
        toolCalls: { source: 'client-local-transcript', confidence: 'low' },
        usage: {
          source: usageSource,
          confidence: transcript.usage ? 'low' : 'unknown',
        },
        cost: { source: 'none', confidence: 'unknown' },
      },
    },
  };
}

function boundEvidence(
  bound: ChatgptTranscriptBinding | undefined
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
  result: ChatgptTurn,
  state: ChatgptTurnState,
  matched?: { path: string; summary: string }
): Promise<ChatgptTurn> {
  const { evidenceDir, sessionsRoot } = state;
  if (typeof evidenceDir !== 'string' || typeof sessionsRoot !== 'string')
    return result;
  const copy = await copyChatgptEvidence({
    evidenceDir,
    sessionsRoot,
    caseId: state.trial.caseId,
    matched,
  });
  const external = result.clientMetadata;
  if (!external) return result;
  external.artifacts = [
    ...external.artifacts.filter(
      (artifact) => !(matched && artifact.path === matched.path)
    ),
    ...copy.artifacts,
  ];
  external.transcriptLimitations = [
    ...(external.transcriptLimitations ?? []),
    ...copy.limitations,
  ];
  if (result.success && copy.matchedCopied === false)
    return {
      success: false,
      toolCalls: [],
      error:
        'The matched native ChatGPT transcript could not be preserved as evidence.',
      clientMetadata: {
        ...external,
        failureKind: 'client_run_failed',
        transcriptSource: 'none',
        transcriptConfidence: 'unknown',
      },
    };
  return result;
}

/** The trial's correlation and submission receipts; no evidence yet. */
function buildMetadata(
  state: ChatgptTurnState,
  receipts: Pick<ClientMetadata, 'computerUse' | 'nativeController'> = {}
): ClientMetadata {
  const { trial } = state;
  return {
    transcriptSource: 'none',
    transcriptConfidence: 'unknown',
    artifacts: [],
    session: trial.correlation.includedInPrompt
      ? { runMarker: trial.marker }
      : {},
    correlation: {
      ...trial.correlation,
      promptSha256: createHash('sha256')
        .update(trial.submittedInput, 'utf8')
        .digest('hex'),
      promptUnchanged: trial.submittedInput === trial.input,
    },
    computerUse: receipts.computerUse ?? state.computerUse,
    nativeController: receipts.nativeController ?? state.nativeController,
  };
}

function failureResult(
  state: ChatgptTurnState,
  options: Pick<ClientMetadata, 'computerUse' | 'nativeController'> & {
    failureKind: ExternalClientFailureKind;
    error: string;
    limitations: string[];
  }
): ChatgptTurn {
  return {
    success: false,
    toolCalls: [],
    error: options.error,
    clientMetadata: {
      ...buildMetadata(state, options),
      failureKind: options.failureKind,
      transcriptLimitations: options.limitations,
    },
  };
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
