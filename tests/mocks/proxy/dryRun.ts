/**
 * The dry-run proxy run from source, in front of an in-process notes server:
 * what a connector's `launch` gives tests that need MST's real proxy (its
 * write record, simulated replies) without a build or a network. Its name
 * matches the built proxy's, so MST reads its write mode from its arguments
 * as it would the real one's. Launch it with `notesProxyServer()`.
 *
 * The notes server's tools: `lookup` (read-only; says whether the proxy sent
 * a token starting `notes-`, without echoing it) and `create_note` (a
 * write). With `?marks=<key>` in the upstream URL, the
 * server stops `create_note` itself and marks its result with `<key>`, as a
 * server whose writes are server-planned does.
 */
import { randomUUID } from 'node:crypto';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import {
  Server,
  WebStandardStreamableHTTPServerTransport,
} from '@modelcontextprotocol/server';
import { createDryRunProxy } from '../../../src/proxy/dryRunProxy.js';
import { startDryRunProxy } from '../../../src/proxy/dryRunProxyStart.js';

const TOOLS = [
  {
    name: 'lookup',
    description: 'Looks up notes.',
    inputSchema: { type: 'object' as const },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'create_note',
    description: 'Creates a note.',
    inputSchema: {
      type: 'object' as const,
      properties: { text: { type: 'string' } },
    },
    annotations: { readOnlyHint: false },
  },
];

let lastAuthorization = '';
const sessions = new Map<string, WebStandardStreamableHTTPServerTransport>();

function notesServer(marks: string | null): Server {
  const server = new Server(
    { name: 'notes', version: '1.0.0' },
    { capabilities: { tools: {} } }
  );
  server.setRequestHandler('tools/list', async () => ({ tools: TOOLS }));
  server.setRequestHandler('tools/call', async (request) => {
    const { name } = request.params;
    const text =
      name === 'lookup'
        ? lastAuthorization.startsWith('Bearer notes-')
          ? 'token ok'
          : 'token bad'
        : JSON.stringify(marks ? { [marks]: true, ok: true } : { ok: true });
    return { content: [{ type: 'text', text }] };
  });
  return server;
}

async function upstream(
  input: string | URL | Request,
  init?: RequestInit
): Promise<Response> {
  const request = new Request(input, init);
  lastAuthorization = request.headers.get('authorization') ?? '';
  const marks = new URL(request.url).searchParams.get('marks');
  const id = request.headers.get('mcp-session-id');
  let transport = id ? sessions.get(id) : undefined;
  if (!transport) {
    transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: randomUUID,
      enableJsonResponse: true,
      onsessioninitialized: (sessionId) => {
        sessions.set(sessionId, transport!);
      },
    });
    await notesServer(marks).connect(transport);
  }
  return transport.handleRequest(request);
}

const started = await startDryRunProxy(process.argv.slice(2), {
  log: (line) => process.stderr.write(`${line}\n`),
  delaysMs: [],
  create: (options) => createDryRunProxy({ ...options, fetch: upstream }),
});
if (started.kind !== 'started') process.exit(2);
const { proxy } = started;
process.stdin.on('end', () => {
  void proxy.close().finally(() => process.exit(0));
});
await proxy.connect(new StdioServerTransport());
