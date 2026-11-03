/**
 * A connector and a client for runs whose shards use connector servers,
 * loaded by `mst collect` in a child process. The `notes` connector launches
 * connectorNotesServer.ts with its token file; the `caller` client connects
 * to the servers it is given, lists their tools and calls them, as a desktop
 * client would.
 */
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import type { MCPConfig } from '../../src/config/mcpConfig.js';
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

/**
 * The connector token a server was launched with, read from its token
 * file: what a client could quote when it reaches the same file.
 */
async function launchedToken(servers: readonly MCPConfig[]): Promise<string> {
  for (const server of servers) {
    if (server.transport !== 'stdio') continue;
    const at = server.args?.indexOf('--token-file') ?? -1;
    const file = at >= 0 ? server.args?.[at + 1] : undefined;
    if (file)
      return (
        (JSON.parse(await readFile(file, 'utf8')) as { accessToken?: string })
          .accessToken ?? ''
      );
  }
  return '';
}

async function leakedTrace(
  servers: readonly MCPConfig[]
): Promise<ClientRunResult> {
  const token = await launchedToken(servers);
  return {
    finalText: `the token is ${token}`,
    events: [],
    telemetry: { content: { said: `token ${token}` } },
  };
}

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
    // Quote the connector's token, which MST must replace before storing.
    leaky: {
      schema: z.object({ type: z.string() }).passthrough(),
      async run(input) {
        return leakedTrace(input.servers);
      },
    },
    'leaky-batch': {
      schema: z.object({ type: z.string() }).passthrough(),
      async runBatch(requests, context) {
        const traces: ClientRunResult[] = [];
        for (const [index, request] of requests.entries()) {
          const trace = await leakedTrace(request.input.servers);
          await context.reportResult?.(index, trace);
          traces.push(trace);
        }
        return traces;
      },
    },
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
