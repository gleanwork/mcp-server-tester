/**
 * A connector and a client for runs whose shards use connector servers,
 * loaded by `mst collect` in a child process. The `notes` connector launches
 * connectorNotesServer.ts with its token file; the `caller` client connects
 * to the servers it is given, lists their tools and calls them, as a desktop
 * client would.
 */
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import {
  closeMCPClient,
  createMCPClientForConfig,
} from '../../src/mcp/clientFactory.js';
import type {
  ClientRunResult,
  TraceEvent,
} from '../../src/evals/evalFrameworkTypes.js';
import type { Plugin } from '../../src/plugins/plugin.js';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const SERVER = fileURLToPath(
  new URL('./connectorNotesServer.ts', import.meta.url)
);

/** Text of a tool result's content. */
function text(result: unknown): string {
  const content = (result as { content?: Array<{ text?: string }> }).content;
  return (content ?? []).map((part) => part.text ?? '').join('');
}

export default {
  meta: { name: 'shard-connector-plugin', namespace: 'sc' },
  connectors: {
    notes: {
      url: 'https://notes.example/mcp',
      auth: { type: 'oauth' },
      launch: ({ tokenFile, simulateWrites }) => ({
        transport: 'stdio',
        command: process.execPath,
        cwd: ROOT,
        args: [
          '--import',
          'tsx',
          SERVER,
          '--token-file',
          tokenFile!,
          ...(simulateWrites ? ['--simulate-writes', simulateWrites.file] : []),
        ],
      }),
    },
  },
  clients: {
    caller: {
      schema: z.object({ type: z.string() }).passthrough(),
      evidence: 'structured',
      async run(input): Promise<ClientRunResult> {
        const events: TraceEvent[] = [];
        for (const config of input.servers) {
          const client = await createMCPClientForConfig(config);
          try {
            const { tools } = await client.listTools();
            for (const tool of tools) {
              const args = tool.name === 'create_note' ? { text: 'hi' } : {};
              const output = text(
                await client.callTool({ name: tool.name, arguments: args })
              );
              events.push({
                kind: 'tool_call',
                source: 'mcp',
                server: config.label,
                name: tool.name,
                arguments: args,
                output,
              });
            }
          } finally {
            await closeMCPClient(client);
          }
        }
        return {
          finalText: events.map((event) => event.output).join('; '),
          events,
        };
      },
    },
  },
} satisfies Plugin;
