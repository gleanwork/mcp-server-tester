import type {
  ExternalHostCapabilityContext,
  ExternalHostCapabilityImplementation,
  ExternalHostRunResult,
} from '../types.js';
import { runAppleScript } from './macosDesktop.js';
import {
  detectClaudeChatSurface,
  waitForAccessibilityTrace,
} from './claudeAccessibility.js';
import { DEFAULT_APP_NAME, formatError } from './claudeCommon.js';
import {
  type ClaudeSessionSnapshot,
  getClaudeDataDir,
  snapshotClaudeSessions,
  waitForClaudeTrace,
} from './claudeSessions.js';
import type { ClaudeTrace } from './claudeTrace.js';
import {
  buildArtifacts,
  buildClaudeTraceMetadata,
  failureResult,
} from './claudeTraceMetadata.js';
import { runStringOption } from './bindingOptions.js';
import { nativeTraceFailureKind } from '../nativeTraceError.js';

/**
 * The Claude Desktop capabilities. The work lives in the modules they call:
 * `claudeSessions` (the local-agent session store: snapshot, match, wait),
 * `claudeTrace` (parsing a session's audit log), `claudeTraceMetadata`
 * (result and evidence metadata, which the Accessibility fallback also
 * uses) and `claudeAccessibility` (the chat surface's low-confidence
 * Accessibility fallback). Option readers are shared in `bindingOptions`.
 */

type RunState = ExternalHostCapabilityContext['state'];

/** What the Claude capabilities share within one run. */
export interface ClaudeRunState {
  dataDir?: string;
  /** Local-agent sessions that existed before submission. */
  snapshot?: ClaudeSessionSnapshot;
  /** The matched trace, from completion, for normalization. */
  trace?: ClaudeTrace;
}

/** Reserved in `state.data`; a user `module:` capability must not use it. */
const RUN_STATE_KEY = 'anthropic.claude';

/** The typed Claude state for a run, created on first use. */
export function claudeRunState(state: RunState): ClaudeRunState {
  const existing = state.data[RUN_STATE_KEY];
  if (existing) return existing as ClaudeRunState;
  const created: ClaudeRunState = {};
  state.data[RUN_STATE_KEY] = created;
  return created;
}

export const ANTHROPIC_CLAUDE_CAPABILITIES: ExternalHostCapabilityImplementation[] =
  [
    {
      id: 'builtin:anthropic.claude.coworkSurface',
      capabilities: ['control'],
      run: rejectClaudeChatSurfaceCapability,
    },
    {
      id: 'builtin:anthropic.claude.activateCoworkSurface',
      capabilities: ['control'],
      run: activateCoworkSurfaceCapability,
    },
    {
      id: 'builtin:anthropic.claude.accessibilityTrace',
      capabilities: ['completion', 'trace', 'normalize'],
      run: captureClaudeChatAccessibilityResultCapability,
    },
    {
      id: 'builtin:anthropic.claude.localAgentTrace',
      capabilities: ['completion', 'trace'],
      setup: snapshotClaudeSessionsCapability,
      run: captureClaudeCoworkAgentTraceCapability,
    },
    {
      id: 'builtin:anthropic.claude.localAgentNormalize',
      capabilities: ['normalize'],
      run: normalizeClaudeCoworkAgentTraceCapability,
    },
  ];

/**
 * Deterministically switches the Claude desktop app to the Cowork surface via
 * Cmd+2 (the app's built-in shortcut for the Cowork sidebar tab). Idempotent —
 * sending Cmd+2 while already on Cowork is a no-op. Replaces the older
 * rejectClaudeChatSurface capability for use cases that need automatic surface
 * activation (e.g. CI runs).
 */
async function activateCoworkSurfaceCapability({
  config,
  run,
  binding,
  state,
}: ExternalHostCapabilityContext): Promise<ExternalHostRunResult | void> {
  const appName =
    runStringOption(config, binding, 'appName') ?? DEFAULT_APP_NAME;
  const settleDelayMs = 700;
  const script = `
tell application ${JSON.stringify(appName)} to activate
delay 0.4
tell application "System Events"
  tell process ${JSON.stringify(appName)}
    set frontmost to true
    keystroke "2" using command down
  end tell
end tell
delay ${settleDelayMs / 1000}
return "ok"
`;
  try {
    await runAppleScript(script, { timeoutMs: 8_000 });
  } catch (err) {
    return failureResult({
      config,
      context: run,
      driver: state.driver,
      displayName: state.displayName,
      capabilitiesUsed: state.capabilitiesUsed,
      failureKind: 'submission_failed',
      error: `Failed to activate Cowork surface via Cmd+2: ${formatError(err)}`,
      artifacts: [],
      limitations: [
        'Cowork surface activation depends on Cmd+2 being bound to the Cowork sidebar tab in the user-installed Claude app version.',
      ],
    });
  }
}

async function rejectClaudeChatSurfaceCapability({
  config,
  run,
  binding,
  state,
}: ExternalHostCapabilityContext): Promise<ExternalHostRunResult | void> {
  const appName =
    runStringOption(config, binding, 'appName') ?? DEFAULT_APP_NAME;
  const chatSurfaceReason = await detectClaudeChatSurface(appName);
  if (!chatSurfaceReason) {
    return;
  }

  return failureResult({
    config,
    context: run,
    driver: state.driver,
    displayName: state.displayName,
    capabilitiesUsed: state.capabilitiesUsed,
    failureKind: 'submission_failed',
    error: `${state.displayName} surface is not active: ${chatSurfaceReason}`,
    artifacts: [],
    limitations: [
      'Cowork is a distinct Claude Desktop surface; this driver will not submit Cowork evals through the regular Claude Chat composer.',
      'Open or focus an active Cowork/local-agent session before running this driver, or add a deterministic Cowork launch step.',
    ],
  });
}

async function snapshotClaudeSessionsCapability({
  config,
  run,
  binding,
  state,
}: ExternalHostCapabilityContext): Promise<ExternalHostRunResult | void> {
  const dataDir = getClaudeDataDir(config, binding);
  const runState = claudeRunState(state);
  runState.dataDir = dataDir;

  try {
    runState.snapshot = await snapshotClaudeSessions(dataDir);
  } catch (err) {
    return failureResult({
      config,
      context: run,
      driver: state.driver,
      displayName: state.displayName,
      capabilitiesUsed: state.capabilitiesUsed,
      failureKind: 'parse_failure',
      error: `Failed to snapshot Claude session directory: ${formatError(err)}`,
      artifacts: [],
      limitations: [`Claude data directory: ${dataDir}`],
    });
  }
}

async function captureClaudeChatAccessibilityResultCapability({
  config,
  run,
  binding,
  state,
}: ExternalHostCapabilityContext): Promise<ExternalHostRunResult | void> {
  try {
    return await waitForAccessibilityTrace({
      config,
      context: run,
      driver: state.driver,
      displayName: state.displayName,
      capabilitiesUsed: state.capabilitiesUsed,
      timeoutMs: run.timeoutMs,
      appName: runStringOption(config, binding, 'appName'),
    });
  } catch (err) {
    const message = formatError(err);
    return failureResult({
      config,
      context: run,
      driver: state.driver,
      displayName: state.displayName,
      capabilitiesUsed: state.capabilitiesUsed,
      failureKind: nativeTraceFailureKind(err, 'unknown'),
      error: message,
      artifacts: [],
      limitations: [
        'Claude Chat Desktop currently uses Accessibility as the fallback trace source; IndexedDB parsing has not been stabilized.',
      ],
    });
  }
}

async function captureClaudeCoworkAgentTraceCapability({
  config,
  run,
  binding,
  state,
}: ExternalHostCapabilityContext): Promise<ExternalHostRunResult | void> {
  const runState = claudeRunState(state);
  const dataDir = runState.dataDir ?? getClaudeDataDir(config, binding);
  const snapshot = runState.snapshot;

  if (!snapshot) {
    return failureResult({
      config,
      context: run,
      driver: state.driver,
      displayName: state.displayName,
      capabilitiesUsed: state.capabilitiesUsed,
      failureKind: 'parse_failure',
      error: 'Claude Cowork trace step requires a session snapshot.',
      artifacts: [],
      limitations: [`Claude data directory: ${dataDir}`],
    });
  }

  try {
    runState.trace = await waitForClaudeTrace({
      dataDir,
      marker: run.marker,
      correlation: run.correlation,
      snapshot,
      timeoutMs: run.timeoutMs,
      startedAtMs: run.startedAtMs,
    });
  } catch (err) {
    const message = formatError(err);
    return failureResult({
      config,
      context: run,
      driver: state.driver,
      displayName: state.displayName,
      capabilitiesUsed: state.capabilitiesUsed,
      failureKind: nativeTraceFailureKind(err, 'unknown'),
      error: message,
      artifacts: [],
      limitations: [`Claude data directory: ${dataDir}`],
    });
  }
}

async function normalizeClaudeCoworkAgentTraceCapability({
  config,
  run,
  state,
}: ExternalHostCapabilityContext): Promise<ExternalHostRunResult> {
  const trace = claudeRunState(state).trace;
  if (!trace) {
    return failureResult({
      config,
      context: run,
      driver: state.driver,
      displayName: state.displayName,
      capabilitiesUsed: state.capabilitiesUsed,
      failureKind: 'parse_failure',
      error: 'Claude Cowork trace normalization requires a parsed trace.',
      artifacts: [],
      limitations: [],
    });
  }

  const artifacts = buildArtifacts(trace);
  const metadata = buildClaudeTraceMetadata({
    config,
    context: run,
    driver: state.driver,
    displayName: state.displayName,
    capabilitiesUsed: state.capabilitiesUsed,
    artifacts,
    trace,
    limitations: trace.parseWarnings,
  });

  if (trace.isError) {
    return {
      success: false,
      toolCalls: trace.toolCalls,
      error:
        trace.finalAnswer ??
        `Claude host run failed${trace.terminalReason ? `: ${trace.terminalReason}` : ''}`,
      externalHost: {
        ...metadata,
        failureKind: 'host_run_failed',
      },
    };
  }

  if (trace.finalAnswer === undefined) {
    return {
      success: false,
      toolCalls: trace.toolCalls,
      error: 'Claude trace completed but did not include a final answer.',
      externalHost: {
        ...metadata,
        failureKind: 'parse_failure',
      },
    };
  }

  return {
    success: true,
    toolCalls: trace.toolCalls,
    response: trace.finalAnswer,
    conversationHistory: trace.finalAnswer
      ? [{ role: 'assistant', content: trace.finalAnswer }]
      : undefined,
    usage: trace.usage,
    llmDurationMs: trace.llmDurationMs,
    externalHost: metadata,
  };
}
