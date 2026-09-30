/** Result, evidence and host-identity metadata for Claude Desktop runs. */
import type {
  ExternalHostConfig,
  ExternalHostFailureKind,
  ExternalHostMetadata,
  ExternalHostRunResult,
  HostArtifact,
  HostCapability,
  HostDriverId,
  HostRunContext,
} from '../types.js';
import { driverToSlug, hostTypeFromDriver } from '../driverIdentity.js';
import { type ClaudeTrace, metadataTimestampString } from './claudeTrace.js';

const CLAUDE_DESKTOP_MACOS_CAPABILITIES = [
  'control',
  'input',
  'completion',
  'trace',
  'normalize',
] as const;

export function buildClaudeTraceMetadata(options: {
  config: ExternalHostConfig;
  context: HostRunContext;
  driver: HostDriverId;
  displayName: string;
  capabilitiesUsed?: readonly HostCapability[];
  artifacts: HostArtifact[];
  trace: ClaudeTrace;
  limitations: string[];
}): ExternalHostMetadata {
  const correlationLimitations = options.context.correlation.includedInPrompt
    ? []
    : [
        'Trace was matched by recently updated host artifacts because no prompt marker was included.',
      ];
  const limitations = buildTraceLimitations(options.trace, [
    ...options.limitations,
    ...correlationLimitations,
  ]);
  const traceConfidence = getTraceConfidence(
    options.trace,
    options.context.correlation
  );
  const finalAnswerEvidence = buildEvidence(
    options.trace.isComplete && options.trace.finalAnswer !== undefined,
    traceConfidence
  );
  const toolCallsEvidence = buildEvidence(
    options.trace.transcriptParsed,
    traceConfidence
  );
  const usageEvidence = buildEvidence(
    options.trace.usageAvailable,
    traceConfidence
  );
  const costEvidence = buildEvidence(
    options.trace.costAvailable,
    traceConfidence
  );

  return {
    ...buildHostIdentityMetadata(
      options.config,
      options.driver,
      options.displayName
    ),
    hostVariant: options.config.variant,
    capabilitiesUsed: [
      ...(options.capabilitiesUsed ?? CLAUDE_DESKTOP_MACOS_CAPABILITIES),
    ],
    traceSource: 'host-local-transcript',
    traceConfidence,
    traceLimitations: limitations.length > 0 ? limitations : undefined,
    artifacts: options.artifacts,
    session: {
      id:
        options.trace.candidate.metadata.sessionId ??
        options.trace.candidate.id,
      runMarker: options.context.marker,
      requestId: options.trace.requestId,
      cliSessionId: options.trace.candidate.metadata.cliSessionId,
      cwd: options.trace.candidate.metadata.cwd,
      startedAt: metadataTimestampString(
        options.trace.candidate.metadata.createdAt
      ),
      completedAt: options.trace.completedAt,
    },
    correlation: options.context.correlation,
    sources: {
      finalAnswer: finalAnswerEvidence.source,
      toolCalls: toolCallsEvidence.source,
      usage: usageEvidence.source,
      cost: costEvidence.source,
    },
    evidence: {
      finalAnswer: finalAnswerEvidence,
      toolCalls: toolCallsEvidence,
      usage: usageEvidence,
      cost: costEvidence,
    },
  };
}

function buildEvidence(
  available: boolean,
  confidence: ExternalHostMetadata['traceConfidence']
) {
  return available
    ? ({ source: 'host-local-transcript', confidence } as const)
    : ({ source: 'none', confidence: 'unknown' } as const);
}

function getTraceConfidence(
  trace: ClaudeTrace,
  correlation: HostRunContext['correlation']
): ExternalHostMetadata['traceConfidence'] {
  if (!trace.isComplete || !trace.auditParsed) {
    return 'unknown';
  }
  if (
    trace.parseWarnings.some((warning) =>
      warning.startsWith('Claude audit log discarded')
    )
  ) {
    return 'medium';
  }
  return correlation.includedInPrompt ? 'high' : 'medium';
}

function buildTraceLimitations(
  trace: ClaudeTrace,
  limitations: string[]
): string[] {
  const output = [...limitations];

  if (!trace.transcriptParsed) {
    output.push(
      'Tool-call evidence is unavailable because a complete structured Claude transcript was not found or could not be parsed.'
    );
  }

  if (!trace.usageAvailable) {
    output.push('Usage evidence is unavailable from the parsed Claude trace.');
  }

  if (!trace.costAvailable) {
    output.push('Cost evidence is unavailable from the parsed Claude trace.');
  }

  return Array.from(new Set(output));
}

export function failureResult(options: {
  config: ExternalHostConfig;
  context: HostRunContext;
  driver: HostDriverId;
  displayName: string;
  capabilitiesUsed?: readonly HostCapability[];
  failureKind: ExternalHostFailureKind;
  error: string;
  artifacts: HostArtifact[];
  limitations: string[];
}): ExternalHostRunResult {
  return {
    success: false,
    toolCalls: [],
    error: options.error,
    externalHost: {
      ...buildHostIdentityMetadata(
        options.config,
        options.driver,
        options.displayName
      ),
      hostVariant: options.config.variant,
      capabilitiesUsed: [...(options.capabilitiesUsed ?? [])],
      traceSource: 'none',
      traceConfidence: 'unknown',
      traceLimitations: options.limitations,
      artifacts: options.artifacts,
      session: { runMarker: options.context.marker },
      correlation: options.context.correlation,
      failureKind: options.failureKind,
    },
  };
}

export function buildHostIdentityMetadata(
  config: ExternalHostConfig,
  driver: HostDriverId,
  displayName: string
): Pick<
  ExternalHostMetadata,
  'driver' | 'driverSlug' | 'displayName' | 'hostName' | 'hostType'
> {
  return {
    driver,
    driverSlug: driverToSlug(driver),
    displayName,
    hostName: displayName,
    hostType: config.hostType ?? hostTypeFromDriver(driver),
  };
}

export function buildArtifacts(trace: ClaudeTrace): HostArtifact[] {
  const artifacts: HostArtifact[] = [
    {
      kind: 'metadata',
      name: 'Claude session metadata',
      path: trace.candidate.metadataPath,
      contentType: 'application/json',
    },
  ];

  if (trace.auditPath) {
    artifacts.push({
      kind: 'audit',
      name: 'Claude audit log',
      path: trace.auditPath,
      contentType: 'application/x-ndjson',
    });
  }

  if (trace.transcriptPath) {
    artifacts.push({
      kind: 'transcript',
      name: 'Claude transcript',
      path: trace.transcriptPath,
      contentType: 'application/x-ndjson',
    });
  }

  return artifacts;
}
