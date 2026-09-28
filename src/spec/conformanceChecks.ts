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
   * Whether all checks passed
   */
  pass: boolean;

  /**
   * List of check results
   */
  checks: MCPConformanceCheck[];

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
 * Validates that the MCP server conforms to expected protocol behavior.
 * Returns both assertion results and raw MCP responses for snapshotting.
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
  const {
    requiredTools = [],
    validateSchemas = true,
    checkServerInfo = true,
    checkResources = true,
    checkPrompts = true,
  } = options;

  const checks: MCPConformanceCheck[] = [];
  const raw: MCPConformanceRaw = {
    serverInfo: null,
    capabilities: null,
    tools: [],
    resources: null,
    prompts: null,
  };

  // Get server info
  const serverInfo = mcp.getServerInfo();
  if (serverInfo) {
    raw.serverInfo = serverInfo as Implementation;
  }

  // Check 1: Server info is present
  if (checkServerInfo) {
    checks.push({
      name: 'server_info_present',
      pass: serverInfo !== null,
      message: serverInfo
        ? `Server info: ${serverInfo.name ?? 'unknown'} v${serverInfo.version ?? 'unknown'}`
        : 'Server info is missing',
    });
  }

  // Get capabilities from client
  const capabilities = mcp.client.getServerCapabilities();
  if (capabilities) {
    raw.capabilities = capabilities;
  }

  // Check 2: Capabilities are valid
  checks.push({
    name: 'capabilities_valid',
    pass: capabilities !== undefined,
    message: capabilities
      ? `Server capabilities: ${formatCapabilities(capabilities)}`
      : 'Server capabilities not available',
  });

  // Check 3: List tools returns valid response
  let tools: Tool[] = [];
  try {
    tools = await mcp.listTools();
    raw.tools = tools;
    checks.push({
      name: 'list_tools_succeeds',
      pass: true,
      message: `listTools returned ${tools.length} tools`,
    });
  } catch (error) {
    checks.push({
      name: 'list_tools_succeeds',
      pass: false,
      message: `listTools failed: ${error instanceof Error ? error.message : String(error)}`,
    });
    const pass = checks.every((check) => check.pass);
    return { pass, checks, raw };
  }

  // Check 4: Required tools are present
  if (requiredTools.length > 0) {
    const toolNames = new Set(tools.map((t) => t.name));
    const missingTools = requiredTools.filter((name) => !toolNames.has(name));

    checks.push({
      name: 'required_tools_present',
      pass: missingTools.length === 0,
      message:
        missingTools.length === 0
          ? `All ${requiredTools.length} required tools are present`
          : `Missing required tools: ${missingTools.join(', ')}`,
    });
  }

  // Check 5: Tool schemas are valid
  if (validateSchemas && tools.length > 0) {
    const invalidTools: Array<string> = [];

    for (const tool of tools) {
      // Check that tool has required fields
      if (!tool.name) {
        invalidTools.push(`(unnamed tool): missing name`);
        continue;
      }

      if (!tool.inputSchema) {
        invalidTools.push(`${tool.name}: missing inputSchema`);
        continue;
      }

      // Check that inputSchema is an object schema
      if (tool.inputSchema.type !== 'object') {
        invalidTools.push(
          `${tool.name}: inputSchema.type must be "object", got "${String(tool.inputSchema.type)}"`
        );
      }
    }

    checks.push({
      name: 'tool_schemas_valid',
      pass: invalidTools.length === 0,
      message:
        invalidTools.length === 0
          ? `All ${tools.length} tools have valid schemas`
          : `Invalid tool schemas:\n  ${invalidTools.join('\n  ')}`,
    });
  }

  // Check 6: List resources (only if server declares resources capability)
  if (checkResources && capabilities?.resources) {
    try {
      const resourcesResult = await mcp.client.listResources();
      raw.resources = resourcesResult.resources;
      checks.push({
        name: 'list_resources_succeeds',
        pass: true,
        message: `listResources returned ${resourcesResult.resources.length} resources`,
      });
    } catch (error) {
      checks.push({
        name: 'list_resources_succeeds',
        pass: false,
        message: `listResources failed: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
  }

  // Check 7: List prompts (only if server declares prompts capability)
  if (checkPrompts && capabilities?.prompts) {
    try {
      const promptsResult = await mcp.client.listPrompts();
      raw.prompts = promptsResult.prompts;
      checks.push({
        name: 'list_prompts_succeeds',
        pass: true,
        message: `listPrompts returned ${promptsResult.prompts.length} prompts`,
      });
    } catch (error) {
      checks.push({
        name: 'list_prompts_succeeds',
        pass: false,
        message: `listPrompts failed: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
  }

  // Check 8: Calling invalid tool returns error
  try {
    const result = await mcp.callTool('__nonexistent_tool__', {});
    // MCP SDK may return isError: true instead of throwing
    const hasError = result.isError === true;
    checks.push({
      name: 'invalid_tool_returns_error',
      pass: hasError,
      message: hasError
        ? 'Nonexistent tool correctly returned an error'
        : 'Calling nonexistent tool should have returned an error',
    });
  } catch {
    // Or it may throw - both are acceptable
    checks.push({
      name: 'invalid_tool_returns_error',
      pass: true,
      message: 'Nonexistent tool correctly threw an error',
    });
  }

  const pass = checks.every((check) => check.pass);

  const result: MCPConformanceResult = { pass, checks, raw };

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

/**
 * Formats server capabilities for display
 */
function formatCapabilities(capabilities: ServerCapabilities): string {
  const parts: string[] = [];
  if (capabilities.tools) parts.push('tools');
  if (capabilities.resources) parts.push('resources');
  if (capabilities.prompts) parts.push('prompts');
  if (capabilities.logging) parts.push('logging');
  if (capabilities.completions) parts.push('completions');
  if (capabilities.experimental) parts.push('experimental');
  return parts.length > 0 ? parts.join(', ') : 'none declared';
}
