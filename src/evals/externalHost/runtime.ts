import { randomUUID } from 'node:crypto';
import type {
  ExternalHostCorrelationConfig,
  ExternalHostCorrelationMetadata,
  ExternalHostConfig,
  ExternalHostRunResult,
  HostRunContext,
} from './types.js';
import {
  driverToSlug,
  hostTypeFromDriver,
  normalizeHostDriver,
} from './driverIdentity.js';
import {
  createExternalHostRunner,
  loadExternalHostConfig,
} from './capabilityRuntime.js';

const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_PROMPT_MARKER_TEMPLATE =
  'Trace marker for MCP Server Tester; do not mention this marker in your response: [eval-run-marker:{{marker}}]';

export function formatSubmittedScenario(
  scenario: string,
  marker: string,
  correlation: ExternalHostCorrelationConfig = {
    strategy: 'prompt_marker',
    includeInPrompt: true,
  }
): string {
  const metadata = normalizeCorrelation(correlation, marker);
  if (!metadata.includedInPrompt) {
    return scenario;
  }

  const template = correlation.promptTemplate ?? DEFAULT_PROMPT_MARKER_TEMPLATE;
  return `${scenario}\n\n${template.replaceAll('{{marker}}', marker)}`;
}

export async function runExternalHostScenario(
  scenario: string,
  config: ExternalHostConfig,
  options: { caseId?: string; runId?: string } = {}
): Promise<ExternalHostRunResult> {
  const runId = options.runId ?? `external-host-${randomUUID()}`;
  const marker = `MCP_SERVER_TESTER_${runId}`;

  let loaded;
  try {
    loaded = await loadExternalHostConfig(config);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return unsupportedHostResult(config, marker, message);
  }

  const timeoutMs = loaded.config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const correlation = normalizeCorrelation(loaded.config.correlation, marker);
  const submittedScenario = formatSubmittedScenario(
    scenario,
    marker,
    loaded.config.correlation
  );

  const context: HostRunContext = {
    runId,
    caseId: options.caseId ?? 'unknown',
    scenario,
    submittedScenario,
    marker,
    correlation,
    timeoutMs,
    startedAtMs: Date.now(),
  };

  const runner = createExternalHostRunner(loaded);

  return runner.run(context);
}

function normalizeCorrelation(
  correlation: ExternalHostCorrelationConfig | undefined,
  marker: string
): ExternalHostCorrelationMetadata {
  const strategy = correlation?.strategy ?? 'none';
  const includedInPrompt =
    strategy === 'prompt_marker'
      ? (correlation?.includeInPrompt ?? true)
      : false;

  return {
    strategy,
    marker,
    includedInPrompt,
  };
}

function unsupportedHostResult(
  config: ExternalHostConfig,
  marker: string,
  error: string
): ExternalHostRunResult {
  const driver = (() => {
    try {
      return normalizeHostDriver(config.driver);
    } catch {
      return {
        provider: 'unknown',
        product: 'unknown',
        surface: 'unknown',
        runtime: 'unknown',
      };
    }
  })();
  const driverSlug = driverToSlug(driver);

  return {
    success: false as const,
    toolCalls: [],
    error,
    externalHost: {
      driver,
      driverSlug,
      displayName: config.name ?? driverSlug,
      hostName: config.name ?? driverSlug,
      hostType: config.hostType ?? hostTypeFromDriver(driver),
      hostVariant: config.variant,
      capabilitiesUsed: [],
      traceSource: 'none',
      traceConfidence: 'unknown',
      traceLimitations: [
        'The external host capability configuration could not be loaded.',
      ],
      artifacts: [],
      session: { runMarker: marker },
      correlation: normalizeCorrelation(config.correlation, marker),
      failureKind: 'unsupported_host',
    },
  };
}
