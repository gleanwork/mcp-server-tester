/**
 * Simple mock MCP server for testing purposes (legacy era only)
 *
 * Serves the shared mock tools over stdio using the legacy `initialize`
 * handshake. See dualEraServer.ts for a server that also speaks the
 * 2026-07-28 protocol.
 */

import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { createMockMcpServer } from './mockServerDefinition.js';

const server = createMockMcpServer();
await server.connect(new StdioServerTransport());

console.error('Test MCP Server started');
