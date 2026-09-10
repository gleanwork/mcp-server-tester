import type { TestInfo } from '@playwright/test';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type {
  Tool,
  CallToolResult,
  ListToolsResult,
} from '@modelcontextprotocol/sdk/types.js';
import type { AuthType } from '../../types/index.js';

// Re-export AuthType for backwards compatibility
export type { AuthType } from '../../types/index.js';

const DEFAULT_CALL_TIMEOUT_MS = 30_000;

function withCallTimeout<T>(
  promise: Promise<T>,
  ms: number,
  opName: string
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      timer = setTimeout(
        () =>
          reject(
            new Error(`MCP operation "${opName}" timed out after ${ms}ms`)
          ),
        ms
      );
    }),
  ]).finally(() => clearTimeout(timer));
}

// Dynamic import of test for conditional step tracking
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let testStep:
  | ((name: string, fn: () => Promise<unknown>) => Promise<unknown>)
  | null = null;

// Try to load test.step() dynamically
try {
  /* eslint-disable @typescript-eslint/no-require-imports, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call */
  const playwright = require('@playwright/test');
  if (playwright && playwright.test && playwright.test.step) {
    testStep = playwright.test.step.bind(playwright.test) as typeof testStep;
  }
  /* eslint-enable @typescript-eslint/no-require-imports, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call */
} catch {
  // Not in a test context, that's fine
}

/**
 * Options for creating an MCP fixture
 */
export interface MCPFixtureOptions {
  /**
   * Authentication type used for this test
   * - 'oauth': Interactive OAuth 2.1 with PKCE (browser-based authentication)
   * - 'api-token': Static API token (e.g., from a dashboard or environment variable)
   * - 'none': No authentication
   */
  authType?: AuthType;

  /**
   * Playwright project name for this test
   * Used for filtering and grouping in the reporter
   */
  project?: string;

  /**
   * Timeout in milliseconds for MCP tool/list operations. Default: 30000
   */
  callTimeoutMs?: number;
}

/**
 * High-level API for interacting with MCP servers in tests
 *
 * This interface wraps the raw MCP Client with test-friendly methods
 */
export interface MCPFixtureApi {
  /**
   * The underlying MCP client (for advanced usage)
   */
  client: Client;

  /**
   * Authentication type used for this test session
   */
  authType: AuthType;

  /**
   * Playwright project name for this test session
   */
  project?: string;

  /**
   * Lists all available tools from the MCP server
   *
   * @returns Array of tool definitions
   */
  listTools(): Promise<Array<Tool>>;

  /**
   * Calls a tool on the MCP server
   *
   * @param name - Tool name
   * @param args - Tool arguments
   * @returns Tool call result
   */
  callTool<TArgs extends Record<string, unknown> = Record<string, unknown>>(
    name: string,
    args: TArgs
  ): Promise<CallToolResult>;

  /**
   * Gets information about the connected server
   */
  getServerInfo(): {
    name?: string;
    version?: string;
  } | null;
}

/**
 * Creates an MCP fixture wrapper around a Client, providing a high-level
 * {@link MCPFixtureApi} without requiring Playwright's `test.extend` pattern.
 *
 * Use this when you need to set up an MCP fixture manually — for example in
 * custom fixture hierarchies, non-Playwright test runners (e.g. Vitest,
 * Jest), or when you want to compose the fixture with other lifecycle
 * management logic that doesn't fit the standard `test.extend` model.
 *
 * For the typical Playwright use case, prefer importing `test` and `mcp`
 * directly from `@gleanwork/mcp-server-tester/fixtures/mcp`, which wires
 * this function up automatically.
 *
 * When `testInfo` is provided, all MCP operations are automatically wrapped
 * in `test.step()` calls and attachments are created for the MCP Test
 * Reporter. Omit `testInfo` for lightweight usage outside Playwright.
 *
 * @param client - The MCP client to wrap (created via `createMCPClientForConfig`)
 * @param testInfo - Optional Playwright TestInfo for auto-tracking and reporter attachments
 * @param options - Optional fixture options (authType, project)
 * @returns MCPFixtureApi instance
 *
 * @example
 * ```typescript
 * // Advanced: custom fixture setup inside test.extend
 * const test = base.extend<{ mcp: MCPFixtureApi }>({
 *   mcp: async ({}, use, testInfo) => {
 *     const client = await createMCPClientForConfig(config);
 *     const api = createMCPFixture(client, testInfo, { authType: 'api-token' });
 *     await use(api);
 *     await closeMCPClient(client);
 *   }
 * });
 *
 * // Non-Playwright usage (no reporter attachments)
 * const client = await createMCPClientForConfig(config);
 * const api = createMCPFixture(client);
 * const tools = await api.listTools();
 * ```
 */
export function createMCPFixture(
  client: Client,
  testInfo?: TestInfo,
  options?: MCPFixtureOptions
): MCPFixtureApi {
  const authType = options?.authType ?? 'none';
  const project = options?.project;
  const callTimeout = options?.callTimeoutMs ?? DEFAULT_CALL_TIMEOUT_MS;
  // If no testInfo, return basic API without tracking
  if (!testInfo) {
    return {
      client,
      authType,
      project,

      async listTools(): Promise<Array<Tool>> {
        const result = await withCallTimeout(
          client.listTools() as Promise<ListToolsResult>,
          callTimeout,
          'listTools'
        );
        return result.tools;
      },

      async callTool<TArgs extends Record<string, unknown>>(
        name: string,
        args: TArgs
      ): Promise<CallToolResult> {
        const result = await withCallTimeout(
          client.callTool({
            name,
            arguments: args,
          }) as Promise<CallToolResult>,
          callTimeout,
          `callTool("${name}")`
        );
        return result;
      },

      getServerInfo() {
        const serverVersion = client.getServerVersion();
        if (!serverVersion) {
          return null;
        }
        return {
          name: serverVersion.name,
          version: serverVersion.version,
        };
      },
    };
  }

  // With testInfo, return tracked API
  return {
    client,
    authType,
    project,

    async listTools(): Promise<Array<Tool>> {
      const execute = async () => {
        const result = await withCallTimeout(
          client.listTools() as Promise<ListToolsResult>,
          callTimeout,
          'listTools'
        );
        const tools = result.tools;

        // Auto-attach for reporter
        await testInfo.attach('mcp-list-tools', {
          contentType: 'application/json',
          body: JSON.stringify(
            {
              operation: 'listTools',
              toolCount: tools.length,
              tools: tools.map((t) => ({
                name: t.name,
                description: t.description,
              })),
            },
            null,
            2
          ),
        });

        return tools;
      };

      // Wrap in test.step if available
      return (
        testStep ? testStep('MCP: listTools()', execute) : execute()
      ) as Promise<Array<Tool>>;
    },

    async callTool<TArgs extends Record<string, unknown>>(
      name: string,
      args: TArgs
    ): Promise<CallToolResult> {
      const execute = async () => {
        const startTime = Date.now();
        const result = await withCallTimeout(
          client.callTool({
            name,
            arguments: args,
          }) as Promise<CallToolResult>,
          callTimeout,
          `callTool("${name}")`
        );
        const durationMs = Date.now() - startTime;

        // Auto-attach for reporter
        await testInfo.attach(`mcp-call-${name}`, {
          contentType: 'application/json',
          body: JSON.stringify(
            {
              operation: 'callTool',
              toolName: name,
              args,
              result,
              durationMs,
              isError: result.isError || false,
              authType,
              project,
            },
            null,
            2
          ),
        });

        return result;
      };

      // Wrap in test.step if available
      return (
        testStep ? testStep(`MCP: callTool("${name}")`, execute) : execute()
      ) as Promise<CallToolResult>;
    },

    getServerInfo() {
      const serverVersion = client.getServerVersion();
      const result = serverVersion
        ? {
            name: serverVersion.name,
            version: serverVersion.version,
          }
        : null;

      // Fire-and-forget attachment (don't block synchronous call)
      testInfo
        .attach('mcp-server-info', {
          contentType: 'application/json',
          body: JSON.stringify(
            {
              operation: 'getServerInfo',
              serverInfo: result,
            },
            null,
            2
          ),
        })
        .catch((err) => {
          console.error('[MCPFixture] Failed to attach server info:', err);
        });

      return result;
    },
  };
}
