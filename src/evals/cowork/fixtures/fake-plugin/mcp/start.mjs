// Fake plugin MCP adapter for tests. Like a real adapter, it reads its endpoint
// from env and its bearer credential from a private file in its data dir. With
// a valid credential it exposes four tools; otherwise only one static tool.
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

const url = process.env.FAKE_MCP_URL ?? '';
let token = '';
try {
  const file = JSON.parse(
    await readFile(
      join(process.env.FAKE_PLUGIN_DATA ?? '', 'creds.json'),
      'utf8'
    )
  );
  token = file.tokens?.access_token ?? '';
} catch {
  /* degraded: static tools only */
}
const server = new McpServer({ name: 'fake-plugin', version: '1.0.0' });
const names =
  token === 'good-token' && url.endsWith('/eval')
    ? ['search', 'read', 'chat', 'leaked_env']
    : ['help'];
for (const name of names)
  server.registerTool(
    name,
    { description: name, inputSchema: {} },
    async () => ({
      content: [
        {
          type: 'text',
          // Report whether a parent secret leaked into this process.
          text:
            name === 'leaked_env'
              ? String(process.env.FAKE_PARENT_SECRET !== undefined)
              : name,
        },
      ],
    })
  );
await server.connect(new StdioServerTransport());
