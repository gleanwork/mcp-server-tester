import type {
  Implementation,
  ServerCapabilities,
  Tool,
} from '@modelcontextprotocol/client';
import type { MCPFixtureApi } from '../mcp/fixtures/mcpFixture.js';
import type { ConnectionTarget } from '../mcp/connectionTarget.js';
import type { WireTap } from '../mcp/wireTap.js';
import type { ProtocolEra } from '../types/index.js';
import { errorMessage } from '../utils/errorMessage.js';
import type {
  ConformanceSeverity,
  MCPConformanceCheck,
} from '../types/reporter.js';

/**
 * Everything a conformance check can read. Built once per
 * `runConformanceChecks()` call.
 */
export interface ConformanceContext {
  mcp: MCPFixtureApi;
  /** Era of the connection under test (legacy when unknown). */
  era: ProtocolEra;
  /** Negotiated revision, e.g. '2026-07-28', when known. */
  negotiated: string | null;
  serverInfo: Implementation | null;
  capabilities: ServerCapabilities | null;
  tools: Tool[];
  /** Set when listTools failed during setup. */
  toolsError?: string;
  /** Raw frames of the connection, when MST created the client. */
  tap?: WireTap;
  /** Where the client connected, when MST created the client. */
  target?: ConnectionTarget;
  /** Whether raw probe requests are allowed. */
  probe: boolean;
  /** Error codes observed in probe responses (for reserved-code checks). */
  observedErrorCodes: number[];
  /** Scratch space checks use to share results (e.g. the discover result). */
  shared: Map<string, unknown>;
}

/** What a check reports. `null` means "not applicable, omit". */
export type CheckOutcome =
  | {
      pass: boolean;
      message: string;
      /** Overrides the definition's severity for this outcome. */
      severity?: ConformanceSeverity;
    }
  | { skip: string }
  | null;

/** A registered conformance check. */
export interface ConformanceCheckDefinition {
  /** Stable name, e.g. 'discover_succeeds'. */
  name: string;
  /** Which eras the check applies to. Other eras omit it entirely. */
  eras: readonly ProtocolEra[];
  severity: ConformanceSeverity;
  /** Spec section or requirement ID the check enforces. */
  specRef?: string;
  /** Stop running further checks when this one fails. */
  stopOnFailure?: boolean;
  /** Needs a working tools/list; omitted when listTools failed in setup. */
  requiresTools?: boolean;
  run(context: ConformanceContext): Promise<CheckOutcome>;
}

/** Runs definitions in order and converts outcomes to reported checks. */
export async function runCheckDefinitions(
  definitions: readonly ConformanceCheckDefinition[],
  context: ConformanceContext
): Promise<MCPConformanceCheck[]> {
  const checks: MCPConformanceCheck[] = [];
  for (const definition of definitions) {
    if (!definition.eras.includes(context.era)) continue;
    let outcome: CheckOutcome;
    try {
      outcome = await definition.run(context);
    } catch (error) {
      outcome = {
        pass: false,
        message: `Check threw: ${errorMessage(error)}`,
      };
    }
    if (outcome === null) continue;
    const base = {
      name: definition.name,
      severity: definition.severity,
      ...(context.negotiated ? { specVersion: context.negotiated } : {}),
      ...(definition.specRef ? { specRef: definition.specRef } : {}),
    };
    if ('skip' in outcome) {
      checks.push({
        ...base,
        pass: true,
        skipped: true,
        message: outcome.skip,
      });
      continue;
    }
    checks.push({
      ...base,
      ...(outcome.severity ? { severity: outcome.severity } : {}),
      pass: outcome.pass,
      message: outcome.message,
    });
    if (!outcome.pass && definition.stopOnFailure) break;
  }
  return checks;
}

/**
 * A conformance result passes when every non-skipped 'must' check passes.
 * Failing 'should' checks are warnings.
 */
export function conformancePasses(
  checks: readonly MCPConformanceCheck[]
): boolean {
  return checks.every(
    (check) =>
      check.pass || check.skipped || (check.severity ?? 'must') === 'should'
  );
}
