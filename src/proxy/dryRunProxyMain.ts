/**
 * `node dist/proxy/dryRun.js --upstream-url <url> --name <label> [options]`:
 * the dry-run proxy on stdio. A small entry point of its own, so a client that
 * launches one proxy per server doesn't load the whole CLI each time.
 */
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { createDryRunProxy } from './dryRunProxy.js';
import {
  DRY_RUN_PROXY_USAGE,
  parseDryRunProxyArgs,
} from './dryRunProxyArgs.js';

function fail(message: string): never {
  process.stderr.write(`dry-run proxy: ${message}\n${DRY_RUN_PROXY_USAGE}\n`);
  process.exit(2);
}

async function main(): Promise<void> {
  let options;
  try {
    options = parseDryRunProxyArgs(process.argv.slice(2));
  } catch (error) {
    fail(error instanceof Error ? error.message : 'invalid arguments');
  }
  const log = (line: string) => process.stderr.write(`${line}\n`);
  let proxy;
  try {
    proxy = await createDryRunProxy({ ...options, log });
  } catch {
    // Never echo the upstream error: it can carry a token or response body.
    log(
      `dry-run proxy ${options.name}: cannot connect to the upstream MCP server`
    );
    process.exit(1);
  }
  const close = () => {
    void proxy.close().finally(() => process.exit(0));
  };
  process.stdin.on('end', close);
  process.on('SIGTERM', close);
  process.on('SIGINT', close);
  await proxy.connect(new StdioServerTransport());
}

void main();
