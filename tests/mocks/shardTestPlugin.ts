/**
 * Clients for shard tests, loaded by `mst collect` in a child process. Each
 * reads the `acme` token before and after its delay, so a test can see a
 * token renewed mid-trial, and logs to stdout, which must not reach the
 * protocol.
 */
import { appendFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import type {
  ClientConfig,
  ClientRunInput,
  ClientRunResult,
} from '../../src/entries/evals.js';
import type { Plugin } from '../../src/plugins/plugin.js';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function token(input: ClientRunInput): Promise<string> {
  const dir = input.env?.MST_TOKENS_DIR;
  if (!dir) return 'none';
  // The connector token file format: { version: 1, accessToken }.
  return readFile(path.join(dir, 'acme.json'), 'utf8')
    .then((text) => (JSON.parse(text) as { accessToken: string }).accessToken)
    .catch(() => 'none');
}

/** With SHARD_TEST_LOG set, each trial's start and end (ms), for overlap checks. */
async function mark(event: 'start' | 'end', prompt: string): Promise<void> {
  const log = process.env.SHARD_TEST_LOG;
  if (log) await appendFile(log, `${event} ${prompt} ${Date.now()}\n`);
}

async function probe(
  input: ClientRunInput,
  config: ClientConfig
): Promise<ClientRunResult> {
  console.log('a stray log line from the client');
  await mark('start', input.prompt);
  const first = await token(input);
  const options = config as {
    delayMs?: number;
    clientOptions?: { delayMs?: number };
  };
  await sleep(Number(options.delayMs ?? options.clientOptions?.delayMs ?? 0));
  const second = await token(input);
  await mark('end', input.prompt);
  if (input.prompt === 'flaky')
    return {
      finalText: '',
      events: [],
      error: `ECONNRESET while using ${second}`,
    };
  return {
    finalText: `${input.prompt}: ${first} then ${second}; key ${input.env?.API_KEY ?? 'unset'}`,
    events: [],
  };
}

const schema = z.object({ type: z.string() }).passthrough();

/** Reports the server entry it got, and the token its token file holds. */
async function servers(input: ClientRunInput): Promise<ClientRunResult> {
  const server = input.servers[0] as {
    label?: string;
    command?: string;
    args?: string[];
  };
  const args = server.args ?? [];
  const file = args[args.indexOf('--token-file') + 1];
  const token = file
    ? await readFile(file, 'utf8')
        .then(
          (text) => (JSON.parse(text) as { accessToken: string }).accessToken
        )
        .catch(() => 'unreadable')
    : 'none';
  return {
    finalText: JSON.stringify({
      label: server.label,
      command: server.command,
      file,
      token,
    }),
    events: [],
  };
}

export default {
  meta: { name: 'shard-test-plugin', namespace: 'shard-test' },
  connectors: {
    acme: {
      url: 'https://acme.example/mcp',
      auth: { type: 'static', token: async () => 'unused' },
      // Like a dry-run proxy: launched from this machine's install.
      launch: ({ label, tokenFile }) => ({
        transport: 'stdio',
        label,
        command: '/worker/node',
        args: ['/worker/proxy.js', '--token-file', tokenFile ?? ''],
      }),
    },
  },
  clients: {
    servers: { schema, evidence: 'structured', run: servers },
    probe: { schema, evidence: 'structured', run: probe },
    batch: {
      schema,
      evidence: 'structured',
      async runBatch(requests, context) {
        const results: ClientRunResult[] = [];
        for (const [index, request] of requests.entries()) {
          const result = await probe(request.input, request.config);
          await context.reportResult?.(index, result);
          results.push(result);
        }
        return results;
      },
    },
  },
} satisfies Plugin;
