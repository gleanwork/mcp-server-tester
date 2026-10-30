/**
 * Starting the stdio dry-run proxy: parse its arguments, read its token file
 * and connect to the upstream server, trying again when that fails.
 *
 * A proxy that can't start exits, and its client sees only "connection
 * closed". On a shard that just started, the first proxy sometimes failed so
 * while the next one, seconds later, connected; so a failed start is tried
 * again after 2 s and 5 s before the proxy gives up, and each failure is
 * logged with why (describeStartupFailure: never a token or response body).
 */
import {
  createDryRunProxy,
  describeStartupFailure,
  TokenFileError,
  type DryRunProxy,
  type DryRunProxyOptions,
} from './dryRunProxy.js';
import { parseDryRunProxyArgs } from './dryRunProxyArgs.js';

/** The waits before each try after the first. */
const START_RETRY_DELAYS_MS = [2_000, 5_000];

export type DryRunProxyStart =
  | { kind: 'started'; proxy: DryRunProxy }
  /** The arguments are wrong: trying again can't help. */
  | { kind: 'usage'; message: string }
  /** Every try failed; each was logged. */
  | { kind: 'failed' };

export async function startDryRunProxy(
  argv: readonly string[],
  {
    log,
    delaysMs = START_RETRY_DELAYS_MS,
    sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms)),
    create = createDryRunProxy,
    env = process.env,
  }: {
    log: (line: string) => void;
    delaysMs?: readonly number[];
    sleep?: (ms: number) => Promise<unknown>;
    create?: (options: DryRunProxyOptions) => Promise<DryRunProxy>;
    env?: Record<string, string | undefined>;
  }
): Promise<DryRunProxyStart> {
  // For the log before the arguments parse (a token file not there yet).
  const nameAt = argv.indexOf('--name');
  const name = (nameAt >= 0 ? argv[nameAt + 1] : undefined) ?? 'proxy';
  for (let attempt = 0; ; attempt++) {
    try {
      let options;
      try {
        options = parseDryRunProxyArgs(argv, env);
      } catch (error) {
        // A token file that isn't there yet is worth waiting for; bad
        // arguments aren't.
        if (!(error instanceof TokenFileError))
          return {
            kind: 'usage',
            message:
              error instanceof Error ? error.message : 'invalid arguments',
          };
        throw error;
      }
      return { kind: 'started', proxy: await create({ ...options, log }) };
    } catch (error) {
      const delay = delaysMs[attempt];
      log(
        `dry-run proxy ${name}: cannot connect to the upstream MCP server (${describeStartupFailure(error)})` +
          (delay === undefined
            ? ''
            : `; trying again in ${Math.round(delay / 1000)} s`)
      );
      if (delay === undefined) return { kind: 'failed' };
      await sleep(delay);
    }
  }
}
