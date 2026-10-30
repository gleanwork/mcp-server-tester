/**
 * `node dist/proxy/dryRun.js --upstream-url <url> --name <label> [options]`:
 * the dry-run proxy on stdio. A small entry point of its own, so a client that
 * launches one proxy per server doesn't load the whole CLI each time.
 */
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { startDryRunProxy } from './dryRunProxyStart.js';
import { DRY_RUN_PROXY_USAGE } from './dryRunProxyArgs.js';

function fail(message: string): never {
  process.stderr.write(`dry-run proxy: ${message}\n${DRY_RUN_PROXY_USAGE}\n`);
  process.exit(2);
}

async function main(): Promise<void> {
  const log = (line: string) => process.stderr.write(`${line}\n`);
  const started = await startDryRunProxy(process.argv.slice(2), { log });
  if (started.kind === 'usage') fail(started.message);
  if (started.kind === 'failed') process.exit(1);
  const { proxy } = started;
  const close = () => {
    void proxy.close().finally(() => process.exit(0));
  };
  process.stdin.on('end', close);
  process.on('SIGTERM', close);
  process.on('SIGINT', close);
  await proxy.connect(new StdioServerTransport());
}

void main();
