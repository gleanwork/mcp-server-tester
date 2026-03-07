// globalSetup.ts
import { injectTokens } from '@gleanwork/mcp-server-tester';

export default async function globalSetup() {
  await injectTokens('https://api.example.com/mcp', {
    accessToken: process.env.MCP_ACCESS_TOKEN!,
    tokenType: 'Bearer',
  });
}
