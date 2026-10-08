import { randomUUID } from 'node:crypto';
import type {
  ExternalClientCorrelationConfig,
  ExternalClientCorrelationMetadata,
  ExternalClientConfig,
  ExternalClientRunResult,
  ClientRunContext,
} from './types.js';
import {
  driverToSlug,
  clientTypeFromDriver,
  normalizeClientDriver,
} from './driverIdentity.js';
import {
  createExternalClientRunner,
  loadExternalClientConfig,
} from './capabilityRuntime.js';

const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_PROMPT_MARKER_TEMPLATE =
  'Trace marker for MCP Server Tester; do not mention this marker in your response: [eval-run-marker:{{marker}}]';

export function formatSubmittedInput(
  input: string,
  marker: string,
  correlation: ExternalClientCorrelationConfig = {
    strategy: 'prompt_marker',
    includeInPrompt: true,
  }
): string {
  const metadata = normalizeCorrelation(correlation, marker);
  if (!metadata.includedInPrompt) {
    return input;
  }

  const template = correlation.promptTemplate ?? DEFAULT_PROMPT_MARKER_TEMPLATE;
  return `${input}\n\n${template.replaceAll('{{marker}}', marker)}`;
}

export async function runExternalClientCase(
  input: string,
  config: ExternalClientConfig,
  options: { caseId?: string; runId?: string } = {}
): Promise<ExternalClientRunResult> {
  const runId = options.runId ?? `external-client-${randomUUID()}`;
  const marker = `MCP_SERVER_TESTER_${runId}`;

  let loaded;
  try {
    loaded = loadExternalClientConfig(config);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return unsupportedClientResult(config, marker, message);
  }

  const timeoutMs = loaded.config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const correlation = normalizeCorrelation(loaded.config.correlation, marker);
  const submittedInput = formatSubmittedInput(
    input,
    marker,
    loaded.config.correlation
  );

  const context: ClientRunContext = {
    runId,
    caseId: options.caseId ?? 'unknown',
    input,
    submittedInput,
    marker,
    correlation,
    timeoutMs,
    startedAtMs: Date.now(),
  };

  const runner = createExternalClientRunner(loaded);

  return runner.run(context);
}

function normalizeCorrelation(
  correlation: ExternalClientCorrelationConfig | undefined,
  marker: string
): ExternalClientCorrelationMetadata {
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

function unsupportedClientResult(
  config: ExternalClientConfig,
  marker: string,
  error: string
): ExternalClientRunResult {
  const driver = (() => {
    try {
      return normalizeClientDriver(config.driver);
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
    clientMetadata: {
      driver,
      driverSlug,
      displayName: config.name ?? driverSlug,
      clientName: config.name ?? driverSlug,
      clientType: config.clientType ?? clientTypeFromDriver(driver),
      clientVariant: config.variant,
      capabilitiesUsed: [],
      traceSource: 'none',
      traceConfidence: 'unknown',
      traceLimitations: [
        'The external client capability configuration could not be loaded.',
      ],
      artifacts: [],
      session: { runMarker: marker },
      correlation: normalizeCorrelation(config.correlation, marker),
      failureKind: 'unsupported_client',
    },
  };
}
