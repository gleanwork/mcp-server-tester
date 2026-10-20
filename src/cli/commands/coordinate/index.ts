import {
  runCoordinatorDaemon,
  startCoordinator,
} from '../../../evals/detach/coordinate.js';
import { lines } from '../../../evals/environments/protocol.js';

export interface CoordinateOptions {
  bundle: string;
  /** The coordinator itself, as `mst coordinate` starts it. */
  daemon?: boolean;
  secrets?: string;
}

/**
 * `mst coordinate`: a detached run's coordinator (ADR 0007). `--detach`
 * starts it over the coordinator machine's channel; nobody types it.
 */
export async function coordinate(options: CoordinateOptions): Promise<void> {
  if (options.daemon) {
    process.exitCode = await runCoordinatorDaemon({
      bundleDir: options.bundle,
      ...(options.secrets ? { secretsFile: options.secrets } : {}),
    });
    return;
  }
  process.stdin.setEncoding('utf8');
  await startCoordinator({
    bundleDir: options.bundle,
    input: lines(process.stdin),
    write: (line) => process.stdout.write(line),
  });
}
