import { createRequire } from 'node:module';

/** The Linux ChatGPT driver (dist/chatgpt/linuxDriver.js), resolved through MST's package exports. */
export function linuxChatgptRuntime(): string {
  return createRequire(
    typeof __filename === 'string' ? __filename : import.meta.url
  ).resolve('@gleanwork/mcp-server-tester/chatgpt-linux-runtime');
}
