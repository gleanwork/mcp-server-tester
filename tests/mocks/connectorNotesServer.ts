/**
 * A notes server a connector launches, the way a dry-run proxy is launched:
 * `--token-file <file>` names the token MST keeps fresh, and
 * `--simulate-writes <file>` (with `simulateWrites`) is where it records the
 * writes it answers instead of making.
 *
 * `lookup` says whether the token file holds a token, without echoing it;
 * `create_note` is a write.
 */
import { readFile } from 'node:fs/promises';
import { McpServer } from '@modelcontextprotocol/server';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { z } from 'zod';
import { recordSimulatedWrite } from '../../src/proxy/simulatedWrites.js';

function flag(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const tokenFile = flag('--token-file');
const writesFile = flag('--simulate-writes');

const server = new McpServer({ name: 'notes', version: '1.0.0' });

server.registerTool(
  'lookup',
  { description: 'Looks up notes.', inputSchema: z.object({}) },
  async () => {
    const token = tokenFile
      ? ((
          JSON.parse(await readFile(tokenFile, 'utf8')) as {
            accessToken?: string;
          }
        ).accessToken ?? '')
      : '';
    return {
      content: [
        {
          type: 'text',
          text: token.startsWith('notes-') ? 'token ok' : 'token bad',
        },
      ],
    };
  }
);

server.registerTool(
  'create_note',
  {
    description: 'Creates a note.',
    inputSchema: z.object({ text: z.string() }),
  },
  async ({ text }: { text: string }) => {
    if (writesFile)
      await recordSimulatedWrite(writesFile, {
        time: new Date().toISOString(),
        server: 'notes',
        tool: 'create_note',
        arguments: { text },
        reply: { ok: true },
      });
    return { content: [{ type: 'text', text: '{"ok":true}' }] };
  }
);

await server.connect(new StdioServerTransport());
