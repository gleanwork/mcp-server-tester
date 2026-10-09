/**
 * A test environment whose "machines" are directories on this machine and
 * whose channel is a child process running MST's CLI from source. It is the
 * smallest real `machineEnvironment`: put and get copy directories, exec
 * spawns `mst collect`.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { machineEnvironment } from '../../src/evals/environments/channel.js';
import type {
  Environment,
  EnvironmentContext,
  WorkerChannel,
} from '../../src/entries/evals.js';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const CLI = path.join(ROOT, 'src/cli/index.ts');

/** Runs `mst <argv[1..]>` from source in a child process, with `env` added. */
export function forkChannel(env: Record<string, string>): WorkerChannel {
  return {
    exec(argv, { stdin, signal }) {
      const child = spawn(
        process.execPath,
        ['--import', 'tsx', CLI, ...argv.slice(1)],
        {
          cwd: ROOT,
          env: { ...process.env, ...env },
          stdio: ['pipe', 'pipe', 'pipe'],
        }
      );
      const kill = () => child.kill('SIGKILL');
      if (signal.aborted) kill();
      else signal.addEventListener('abort', kill, { once: true });
      void (async () => {
        try {
          for await (const line of stdin) child.stdin.write(line);
        } finally {
          child.stdin.end();
        }
      })();
      return {
        stdout: child.stdout,
        stderr: child.stderr,
        exit: new Promise<number>((resolve) =>
          child.on('close', (code) => resolve(code ?? -1))
        ),
      };
    },
    async put(localDir, remoteDir) {
      await fs.cp(localDir, remoteDir, { recursive: true });
    },
    async get(remoteDir, localDir) {
      await fs.mkdir(localDir, { recursive: true });
      await fs.cp(remoteDir, localDir, { recursive: true }).catch(() => {});
    },
  };
}

/** What a test can see of its machines. */
export interface ForkEnvironment extends Environment {
  /** `keep` for each machine disposed, in order. */
  disposed: boolean[];
}

/** An environment whose machines are directories under `root`. */
export function forkEnvironment(
  context: EnvironmentContext,
  root: string,
  env: Record<string, string>,
  options: {
    silenceMs?: number;
    cancelGraceMs?: number;
    /** A shard whose machine can't be created, as if its VM never came up. */
    failShard?: number;
  } = {}
): ForkEnvironment {
  const { failShard, ...channelOptions } = options;
  const disposed: boolean[] = [];
  const environment = machineEnvironment(
    context,
    async (shard) => {
      if (shard.index === failShard)
        throw new Error(`machine ${shard.index} never came up`);
      const workDir = path.join(root, `machine-${shard.index}`);
      await fs.mkdir(workDir, { recursive: true });
      return {
        id: `fork-${shard.index}`,
        workDir,
        // Each machine keeps its own tokens, unless the test names a directory.
        channel: forkChannel({
          MST_TOKENS_DIR: path.join(workDir, 'tokens'),
          ...env,
        }),
        async dispose({ keep }) {
          disposed.push(keep);
          if (!keep) await fs.rm(workDir, { recursive: true, force: true });
        },
      };
    },
    channelOptions
  );
  return Object.assign(environment, { disposed });
}
