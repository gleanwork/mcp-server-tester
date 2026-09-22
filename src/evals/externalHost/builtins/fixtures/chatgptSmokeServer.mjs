import { appendFile } from 'node:fs/promises';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

const [label, token, logPath] = process.argv.slice(2);
if (!label || !token || !logPath)
  throw new Error('Expected label, token, log path');
const server = new McpServer({ name: label, version: '1.0.0' });
server.registerTool(
  `${label}_token`,
  {
    description: `Return the read-only smoke-test token for ${label}.`,
    inputSchema: {},
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  async () => {
    await appendFile(logPath, `${label}:called\n`);
    return { content: [{ type: 'text', text: token }] };
  }
);
await server.connect(new StdioServerTransport());
await appendFile(logPath, `${label}:connected\n`);
