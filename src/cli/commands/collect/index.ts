import { collectShard } from '../../../evals/environments/collect.js';
import { lines } from '../../../evals/environments/protocol.js';

export interface CollectOptions {
  bundle: string;
  results: string;
}

/**
 * `mst collect`: run a shard on this machine (ADR 0004). Environments start
 * it; nobody types it. stdout carries only `mst.shard/v1` lines, so anything
 * else the process logs goes to stderr.
 */
export async function collect(options: CollectOptions): Promise<void> {
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(options.results))
    throw new Error(
      `mst collect writes its results to a directory, not "${options.results}".`
    );
  const write = process.stdout.write.bind(process.stdout);
  for (const method of ['log', 'info', 'debug', 'warn'] as const)
    console[method] = (...args: unknown[]) => console.error(...args);
  process.stdin.setEncoding('utf8');
  const code = await collectShard({
    bundleDir: options.bundle,
    resultsDir: options.results,
    input: lines(process.stdin),
    write: (line) => {
      write(line);
    },
  });
  // A client may leave handles open; the shard is over once `done` is out.
  await new Promise<void>((resolve) => write('', () => resolve()));
  process.exit(code);
}
