/**
 * The calibration set's client: `calibration/client/scripted` makes the
 * tool calls a case lists, against the real servers, and gives the case's
 * answer. It calls no model. See ./cases.ts.
 */
import {
  Client,
  StreamableHTTPClientTransport,
} from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { z } from 'zod';
import type { MCPConfig } from '../../src/config/mcpConfig.js';
import type {
  ClientRunResult,
  TraceEvent,
} from '../../src/evals/evalFrameworkTypes.js';
import type { Plugin } from '../../src/plugins/plugin.js';

const ScriptedConfig = z
  .object({
    type: z.string(),
    model: z.string().optional(),
    /** The fixture folder's absolute path, for `{files}` in arguments. */
    files: z.string(),
    // Each case gives its own steps and answer; the eval's options have none.
    steps: z
      .array(
        z
          .object({
            server: z.string(),
            tool: z.string(),
            args: z.record(z.string(), z.unknown()),
          })
          .strict()
      )
      .optional(),
    answer: z.string().optional(),
  })
  .strict();

interface Connection {
  label: string;
  client: Client;
}

async function connect(servers: MCPConfig[]): Promise<Connection[]> {
  const connections: Connection[] = [];
  try {
    for (const server of servers) {
      const client = new Client({ name: 'calibration', version: '1.0.0' });
      if (server.transport === 'stdio')
        await client.connect(
          new StdioClientTransport({
            command: server.command,
            args: server.args ?? [],
            env: { PATH: process.env.PATH ?? '', ...(server.env ?? {}) },
            ...(server.cwd !== undefined ? { cwd: server.cwd } : {}),
            stderr: 'ignore',
          })
        );
      else if (server.transport === 'http')
        await client.connect(
          new StreamableHTTPClientTransport(new URL(server.serverUrl))
        );
      else
        throw new Error(
          `The calibration client connects to stdio and http servers, not ${(server as { transport: string }).transport}.`
        );
      connections.push({ label: server.label ?? '', client });
    }
    return connections;
  } catch (error) {
    await Promise.allSettled(connections.map(({ client }) => client.close()));
    throw error;
  }
}

/** Replaces `{files}` in string arguments with the fixture folder. */
function withFiles(
  args: Record<string, unknown>,
  files: string
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(args).map(([key, value]) => [
      key,
      typeof value === 'string' ? value.replaceAll('{files}', files) : value,
    ])
  );
}

function text(content: unknown): string {
  return Array.isArray(content)
    ? content
        .filter(
          (item): item is { type: 'text'; text: string } =>
            typeof item === 'object' &&
            item !== null &&
            (item as { type?: unknown }).type === 'text'
        )
        .map((item) => item.text)
        .join('\n')
    : '';
}

async function runScript(
  config: z.infer<typeof ScriptedConfig>,
  connections: Connection[]
): Promise<ClientRunResult> {
  if (config.steps === undefined || config.answer === undefined)
    throw new Error(
      'A calibration case gives its steps and answer in clientOptions.'
    );
  const events: TraceEvent[] = [];
  for (const step of config.steps) {
    const connection = connections.find(({ label }) => label === step.server);
    if (!connection)
      throw new Error(
        `The case calls server ${step.server}, which isn't in the eval.`
      );
    const args = withFiles(step.args, config.files);
    let output: string;
    let isError: boolean;
    try {
      const result = await connection.client.callTool({
        name: step.tool,
        arguments: args,
      });
      output = text(result.content);
      isError = result.isError === true;
    } catch (error) {
      // A protocol error, such as arguments the tool's schema rejects.
      output = error instanceof Error ? error.message : String(error);
      isError = true;
    }
    events.push({
      kind: 'tool_call',
      source: 'mcp',
      name: step.tool,
      server: step.server,
      arguments: args,
      output,
      isError,
    });
  }
  return { finalText: config.answer, events };
}

const plugin: Plugin = {
  meta: { name: 'mst-calibration', namespace: 'calibration' },
  clients: {
    scripted: {
      schema: ScriptedConfig,
      evidence: 'structured',
      headless: true,
      async runBatch(requests) {
        // Every case uses the same servers: connect once for the batch.
        const pools = new Map<string, Connection[]>();
        try {
          const results: ClientRunResult[] = [];
          for (const request of requests) {
            const key = JSON.stringify(request.input.servers);
            let pool = pools.get(key);
            if (!pool) {
              pool = await connect(request.input.servers);
              pools.set(key, pool);
            }
            results.push(
              await runScript(ScriptedConfig.parse(request.config), pool)
            );
          }
          return results;
        } finally {
          await Promise.allSettled(
            [...pools.values()].flat().map(({ client }) => client.close())
          );
        }
      },
    },
  },
};

export default plugin;
