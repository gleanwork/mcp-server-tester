import { gradeShard } from '../../../evals/environments/gradeShard.js';
import { lines } from '../../../evals/environments/protocol.js';

export interface GradeShardCommandOptions {
  bundle: string;
  results: string;
}

/**
 * `mst grade-shard`: grade a shard of a stored run on this machine (ADR
 * 0005). Environments start it; nobody types it. stdout carries only
 * `mst.shard/v1` lines, so anything else the process logs goes to stderr.
 */
export async function gradeShardCommand(
  options: GradeShardCommandOptions
): Promise<void> {
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(options.results))
    throw new Error(
      `mst grade-shard writes its results to a directory, not "${options.results}".`
    );
  const write = process.stdout.write.bind(process.stdout);
  for (const method of ['log', 'info', 'debug', 'warn'] as const)
    console[method] = (...args: unknown[]) => console.error(...args);
  process.stdin.setEncoding('utf8');
  const code = await gradeShard({
    bundleDir: options.bundle,
    resultsDir: options.results,
    input: lines(process.stdin),
    write: (line) => {
      write(line);
    },
  });
  // A judge may leave handles open; the shard is over once `done` is out.
  await new Promise<void>((resolve) => write('', () => resolve()));
  process.exit(code);
}
