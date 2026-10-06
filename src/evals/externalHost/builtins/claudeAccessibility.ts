import type {
  ExternalHostConfig,
  ExternalHostRunResult,
  HostCapability,
  HostDriverId,
  ClientRunContext,
} from '../types.js';
import {
  readMacosAccessibilityText,
  readMacosFrontWindowContents,
} from './macosDesktop.js';
import { buildHostIdentityMetadata } from './claudeTraceMetadata.js';
import { NativeTraceError } from '../nativeTraceError.js';
import {
  DEFAULT_APP_NAME,
  POLL_INTERVAL_MS,
  delay,
  formatError,
} from './claudeCommon.js';
import { configStringOption } from './bindingOptions.js';

async function readAccessibilityFallback(
  config: ExternalHostConfig,
  context: ClientRunContext,
  driver: HostDriverId,
  displayName: string,
  capabilitiesUsed: readonly HostCapability[],
  options: { appName?: string } = {}
): Promise<ExternalHostRunResult | undefined> {
  let visibleText: string;
  try {
    visibleText = await readMacosAccessibilityText(
      options.appName ??
        configStringOption(config, 'appName') ??
        DEFAULT_APP_NAME
    );
  } catch {
    return undefined;
  }

  if (!visibleText.includes(context.marker)) {
    return undefined;
  }

  const response = extractAccessibilityResponse(visibleText);
  if (!response) {
    return undefined;
  }

  return {
    success: true,
    toolCalls: [],
    response,
    conversationHistory: [{ role: 'assistant', content: response }],
    externalHost: {
      ...buildHostIdentityMetadata(config, driver, displayName),
      hostVariant: config.variant,
      capabilitiesUsed: [...capabilitiesUsed],
      traceSource: 'accessibility',
      traceConfidence: 'low',
      traceLimitations: [
        'Claude did not produce a matching local-agent transcript; final answer was captured from the visible Accessibility tree.',
        'Tool calls, token usage, cost, and hidden context are unavailable from this fallback source.',
      ],
      artifacts: [
        {
          kind: 'trace',
          name: 'Claude visible accessibility text',
          contentType: 'text/plain',
          summary: visibleText.slice(0, 1000),
        },
      ],
      session: {
        runMarker: context.marker,
      },
      correlation: context.correlation,
      sources: {
        finalAnswer: 'accessibility',
        toolCalls: 'none',
        usage: 'none',
        cost: 'none',
      },
      evidence: {
        finalAnswer: { source: 'accessibility', confidence: 'low' },
        toolCalls: { source: 'none', confidence: 'unknown' },
        usage: { source: 'none', confidence: 'unknown' },
        cost: { source: 'none', confidence: 'unknown' },
      },
    },
  };
}

export async function detectClaudeChatSurface(
  appName: string
): Promise<string | undefined> {
  let surfaceText: string;
  try {
    // `entire contents of front window` is a single IPC batch transfer; it can
    // be multi-MB on a fully-loaded Electron window (handled by the maxBuffer
    // bump in runAppleScript). The recursive AppleScript alternative does one
    // IPC round-trip per element and hits the per-script timeout on large
    // trees.
    surfaceText = await readMacosFrontWindowContents(appName);
  } catch (err) {
    return `could not verify active Claude surface via Accessibility: ${formatError(err)}`;
  }

  if (looksLikeClaudeChatSurface(surfaceText)) {
    return 'visible controls match the regular Claude Chat surface';
  }

  return undefined;
}

export function looksLikeClaudeChatSurface(visibleText: string): boolean {
  const chatSignals = [
    'New chat',
    'Projects',
    'Artifacts',
    'Ask your org',
    'Write a message',
  ];
  const signalCount = chatSignals.filter((signal) =>
    visibleText.includes(signal)
  ).length;
  return signalCount >= 3;
}

export async function waitForAccessibilityTrace(options: {
  config: ExternalHostConfig;
  context: ClientRunContext;
  driver: HostDriverId;
  displayName: string;
  capabilitiesUsed: readonly HostCapability[];
  timeoutMs: number;
  appName?: string;
}): Promise<ExternalHostRunResult> {
  const deadline = Date.now() + options.timeoutMs;

  while (Date.now() < deadline) {
    const fallback = await readAccessibilityFallback(
      options.config,
      options.context,
      options.driver,
      options.displayName,
      options.capabilitiesUsed,
      { appName: options.appName }
    );
    if (fallback) {
      return fallback;
    }
    await delay(POLL_INTERVAL_MS);
  }

  throw new NativeTraceError(
    'timeout',
    `Timed out waiting for Claude Chat Desktop visible response for marker ${options.context.marker}`
  );
}

export function extractAccessibilityResponse(
  visibleText: string
): string | undefined {
  const lines = visibleText
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  const responseLine = [...lines]
    .reverse()
    .find((line) => line.startsWith('Claude responded: '));
  if (responseLine) {
    return responseLine.slice('Claude responded: '.length).trim();
  }

  const inlineResponseMatch = /Claude responded:\s*([^,\n]+)/.exec(visibleText);
  if (inlineResponseMatch?.[1]) {
    return inlineResponseMatch[1].trim();
  }

  const markerIndex = lines.findIndex((line) =>
    line.includes('[eval-run-marker:')
  );
  if (markerIndex >= 0) {
    return lines
      .slice(markerIndex + 1)
      .find(
        (line) =>
          !line.startsWith('Write a message') &&
          !line.includes('Claude is AI and can make mistakes')
      );
  }

  return undefined;
}
