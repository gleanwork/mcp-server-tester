/**
 * Debug logging utilities
 *
 * Uses the `debug` package for conditional logging.
 * Enable via DEBUG environment variable:
 *
 * @example
 * ```bash
 * # Enable all mcp-server-tester logs
 * DEBUG=mcp-server-tester:* npm test
 *
 * # Enable only client logs
 * DEBUG=mcp-server-tester:client npm test
 *
 * # Enable only OAuth logs
 * DEBUG=mcp-server-tester:oauth npm test
 *
 * # Enable HTTP-level trace logging (URL, headers, transport selection)
 * DEBUG=mcp-server-tester:http npx playwright test
 * ```
 */

import createDebug from 'debug';

const NAMESPACE = 'mcp-server-tester';

/**
 * Debug logger for MCP client operations
 */
export const debugClient = createDebug(`${NAMESPACE}:client`);

/**
 * Debug logger for OAuth operations
 */
export const debugOAuth = createDebug(`${NAMESPACE}:oauth`);

/**
 * Debug logger for eval operations
 */
export const debugEval = createDebug(`${NAMESPACE}:eval`);

/**
 * Debug logger for HTTP-level trace logging.
 *
 * Enable with:
 * ```bash
 * DEBUG=mcp-server-tester:http npx playwright test
 * ```
 *
 * Logs: server URL, transport type selected (Streamable HTTP vs SSE),
 * outgoing request header names, and connection outcomes.
 */
export const debugHttp = createDebug(`${NAMESPACE}:http`);
