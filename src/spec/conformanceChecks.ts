import type { MCPFixtureApi } from '../mcp/fixtures/mcpFixture.js';
import type { TestInfo } from '@playwright/test';
import type {
  Tool,
  Resource,
  Prompt,
  ServerCapabilities,
  Implementation,
} from '@modelcontextprotocol/client';
import type { MCPConformanceCheck } from '../types/reporter.js';
import type { MCPProtocolInfo } from '../types/index.js';
import { getWireTap } from '../mcp/wireTap.js';
import { errorMessage } from '../utils/errorMessage.js';
import { getConnectionTarget } from '../mcp/connectionTarget.js';
import {
  conformancePasses,
  runCheckDefinitions,
  type ConformanceContext,
} from './registry.js';
import { coreChecks } from './checks/core.js';
import { modernChecks } from './checks/modern.js';
import { skillsChecks, type SkillsCheckOptions } from './checks/skills.js';

export type { MCPConformanceCheck };

/**
 * Options for conformance checks
 */
export interface MCPConformanceOptions {
  /**
   * List of tools that must be present
   */
  requiredTools?: Array<string>;

  /**
   * Whether to validate tool schemas
   * @default true
   */
  validateSchemas?: boolean;

  /**
   * Whether to check server info is present
   * @default true
   */
  checkServerInfo?: boolean;

  /**
   * Whether to check resources capability (if declared by server)
   * @default true
   */
  checkResources?: boolean;

  /**
   * Whether to check prompts capability (if declared by server)
   * @default true
   */
  checkPrompts?: boolean;

  /**
   * Whether modern-era checks may send raw probe requests (malformed or
   * mismatched requests) to the server. Over stdio a probe starts a separate,
   * short-lived copy of the server. Set to false for servers where that is
   * expensive or has side effects; those checks are then reported as skipped.
   * @default true
   */
  probe?: boolean;

  /**
   * Agent Skills (SEP-2640) checks. They run in every era when the server
   * declares `io.modelcontextprotocol/skills`. Pass options to tune them, or
   * false to turn them off.
   */
  skills?: SkillsCheckOptions | false;
}

/**
 * Raw MCP responses for snapshotting
 */
export interface MCPConformanceRaw {
  /**
   * Server info (name, version)
   * null if not available
   */
  serverInfo: Implementation | null;

  /**
   * Server capabilities
   * null if not available
   */
  capabilities: ServerCapabilities | null;

  /**
   * List of tools from the server
   */
  tools: Tool[];

  /**
   * List of resources from the server
   * null if server doesn't declare resources capability
   */
  resources: Resource[] | null;

  /**
   * List of prompts from the server
   * null if server doesn't declare prompts capability
   */
  prompts: Prompt[] | null;
}

/**
 * Result of conformance checks
 */
export interface MCPConformanceResult {
  /**
   * Whether every 'must' check passed. Failing 'should' checks are warnings
   * and skipped checks never fail the result.
   */
  pass: boolean;

  /**
   * List of check results
   */
  checks: MCPConformanceCheck[];

  /**
   * Protocol the checked connection requested and negotiated. Checks are
   * selected by its era: legacy connections run the core checks, modern
   * (2026-07-28+) connections also run the modern-era checks.
   */
  protocol: MCPProtocolInfo;

  /**
   * Raw MCP responses for snapshotting
   *
   * @example
   * ```typescript
   * const result = await runConformanceChecks(mcp);
   * expect(result.raw.tools).toMatchSnapshot();
   * expect(result.raw.capabilities).toMatchSnapshot();
   * ```
   */
  raw: MCPConformanceRaw;
}

/**
 * Runs MCP protocol conformance checks
 *
 * Validates that the MCP server conforms to expected protocol behavior for
 * the protocol the connection negotiated (see `mcp.protocol`). Returns both
 * assertion results and raw MCP responses for snapshotting.
 *
 * When testInfo is provided, results are automatically attached for the MCP reporter.
 *
 * @param mcp - MCP fixture API
 * @param options - Conformance check options
 * @param testInfo - Optional Playwright TestInfo for reporter integration
 * @returns Conformance check results with raw responses
 *
 * @example
 * ```typescript
 * // Basic usage
 * const result = await runConformanceChecks(mcp, {
 *   requiredTools: ['get_weather', 'search_docs'],
 *   validateSchemas: true,
 * });
 *
 * // Check assertions
 * expect(result.pass).toBe(true);
 *
 * // With reporter integration (recommended in Playwright tests)
 * const result = await runConformanceChecks(mcp, {
 *   requiredTools: ['search'],
 * }, testInfo);
 *
 * // Snapshot raw responses
 * expect(result.raw.tools).toMatchSnapshot();
 * expect(result.raw.capabilities).toMatchSnapshot();
 * ```
 */
export async function runConformanceChecks(
  mcp: MCPFixtureApi,
  options: MCPConformanceOptions = {},
  testInfo?: TestInfo
): Promise<MCPConformanceResult> {
  const raw: MCPConformanceRaw = {
    serverInfo: null,
    capabilities: null,
    tools: [],
    resources: null,
    prompts: null,
  };

  const serverInfo = mcp.getServerInfo();
  if (serverInfo) raw.serverInfo = serverInfo as Implementation;
  const capabilities = mcp.client.getServerCapabilities() ?? null;
  raw.capabilities = capabilities;

  let toolsError: string | undefined;
  try {
    raw.tools = await mcp.listTools();
  } catch (error) {
    toolsError = errorMessage(error);
  }

  const protocol = mcp.protocol;
  const context: ConformanceContext = {
    mcp,
    era: protocol.era ?? 'legacy',
    negotiated: protocol.negotiated,
    serverInfo: raw.serverInfo,
    capabilities,
    tools: raw.tools,
    ...(toolsError !== undefined ? { toolsError } : {}),
    tap: getWireTap(mcp.client),
    target: getConnectionTarget(mcp.client),
    probe: options.probe ?? true,
    observedErrorCodes: [],
    shared: new Map(),
  };

  const core = coreChecks(
    {
      requiredTools: options.requiredTools ?? [],
      validateSchemas: options.validateSchemas ?? true,
      checkServerInfo: options.checkServerInfo ?? true,
      checkResources: options.checkResources ?? true,
      checkPrompts: options.checkPrompts ?? true,
    },
    raw
  );
  // When tools/list fails, the core checks stop at list_tools_succeeds, but
  // modern wire-level checks still run: the SDK can reject a malformed
  // result (e.g. missing cache hints) whose raw frame is what they inspect.
  const skills =
    options.skills === false || toolsError !== undefined
      ? []
      : skillsChecks(options.skills);
  const checks = [
    ...(await runCheckDefinitions(core, context)),
    ...(await runCheckDefinitions(skills, context)),
    // Modern checks run last so reserved_error_codes sees every error the
    // other checks provoked.
    ...(await runCheckDefinitions(
      toolsError === undefined
        ? modernChecks
        : modernChecks.filter((definition) => !definition.requiresTools),
      context
    )),
  ];
  const pass = conformancePasses(checks);
  const result: MCPConformanceResult = { pass, checks, protocol, raw };

  // Attach results for MCP reporter if testInfo is provided
  if (testInfo) {
    await testInfo.attach('mcp-conformance-checks', {
      contentType: 'application/json',
      body: JSON.stringify(
        {
          operation: 'conformanceChecks',
          pass,
          checks,
          serverInfo: raw.serverInfo,
          capabilities: raw.capabilities,
          toolCount: raw.tools.length,
          protocol,
          authType: mcp.authType,
          project: mcp.project,
        },
        null,
        2
      ),
    });
  }

  return result;
}
