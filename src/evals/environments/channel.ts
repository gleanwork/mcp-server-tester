/**
 * The coordinator side of a shard (ADR 0004): stage the bundle on a machine,
 * start `mst collect` over its channel, answer the worker's messages, and
 * copy its results back. `machineEnvironment` builds a whole environment
 * from a function that creates machines.
 */
import path from 'node:path';
import packageJson from '../../../package.json' with { type: 'json' };
import { redactClientSecrets } from '../clientSecrets.js';
import type {
  Environment,
  EnvironmentContext,
  Machine,
  ShardEvents,
  ShardOutcome,
  ShardSpec,
  WorkerChannel,
} from '../evalFrameworkTypes.js';
import {
  encodeMessage,
  lines,
  parseWorkerMessage,
  type CoordinatorMessage,
} from './protocol.js';

export interface ShardChannelOptions {
  /** The command that runs MST on the machine. Default `['mst']`. */
  command?: readonly string[];
  /** Where the bundle and results go on the machine. Default `/mst`. */
  workDir?: string;
  /** How long the worker may stay silent before the shard fails. Default 60 s. */
  silenceMs?: number;
  /** How long a cancelled worker has to finish before it's killed. Default 30 s. */
  cancelGraceMs?: number;
}

/** A push-based async iterable: the worker's stdin. */
function inputQueue() {
  const pending: string[] = [];
  let wake: (() => void) | undefined;
  let closed = false;
  return {
    push(line: string) {
      if (closed) return;
      pending.push(line);
      wake?.();
    },
    close() {
      closed = true;
      wake?.();
    },
    async *[Symbol.asyncIterator](): AsyncGenerator<string> {
      for (;;) {
        while (pending.length) yield pending.shift()!;
        if (closed) return;
        await new Promise<void>((resolve) => (wake = resolve));
        wake = undefined;
      }
    },
  };
}

const STDERR_TAIL = 4096;

/** Runs `shard` on the machine behind `channel`, start to finish. */
export async function runShardOverChannel(
  channel: WorkerChannel,
  shard: ShardSpec,
  events: ShardEvents,
  signal: AbortSignal,
  options: ShardChannelOptions = {}
): Promise<ShardOutcome> {
  const workDir = options.workDir ?? '/mst';
  const remoteBundle = path.posix.join(workDir, 'bundle');
  const remoteResults = path.posix.join(workDir, 'results');
  const silenceMs = options.silenceMs ?? 60_000;
  const cancelGraceMs = options.cancelGraceMs ?? 30_000;
  const outcome: ShardOutcome = {
    ok: false,
    collected: 0,
    infra: 0,
    cancelled: false,
  };
  let failure: string | undefined;
  let done = false;
  let cleanupFailed = false;
  // Tokens and secrets sent to the worker, kept out of the reason.
  const secrets: string[] = [];

  await channel.put(shard.bundleDir, remoteBundle);
  const stdin = inputQueue();
  const send = (message: CoordinatorMessage) =>
    stdin.push(encodeMessage(message));
  const kill = new AbortController();
  const run = channel.exec(
    [
      ...(options.command ?? ['mst']),
      'collect',
      '--bundle',
      remoteBundle,
      '--results',
      remoteResults,
    ],
    { stdin, signal: kill.signal }
  );

  let stderr = '';
  const readingStderr = (async () => {
    for await (const chunk of run.stderr)
      stderr = (stderr + chunk.toString()).slice(-STDERR_TAIL);
  })();

  let graceTimer: NodeJS.Timeout | undefined;
  const cancel = (reason: string) => {
    if (outcome.cancelled || done) return;
    outcome.cancelled = true;
    send({ type: 'cancel', reason });
    graceTimer = setTimeout(() => kill.abort(), cancelGraceMs);
  };
  const onAbort = () => cancel('The run was cancelled.');
  if (signal.aborted) onAbort();
  else signal.addEventListener('abort', onAbort, { once: true });

  let silence: NodeJS.Timeout | undefined;
  const fail = (reason: string) => {
    failure ??= reason;
    kill.abort();
  };
  const listen = () => {
    clearTimeout(silence);
    // A worker that said `done` only has to exit.
    if (done) return;
    silence = setTimeout(
      () =>
        fail(
          `The worker sent nothing for ${Math.round(silenceMs / 1000)} s; its channel may be gone.`
        ),
      silenceMs
    );
  };

  try {
    listen();
    for await (const line of lines(run.stdout)) {
      listen();
      // Anything that isn't a protocol message (a stray log line) is skipped.
      if (!line.startsWith('{')) continue;
      const message = parseWorkerMessage(line);
      if (message.type === 'hello') {
        if (message.mst !== packageJson.version) {
          send({
            type: 'cancel',
            reason: `This run uses MST ${packageJson.version}.`,
          });
          fail(
            `The worker runs MST ${message.mst}, but this run uses ${packageJson.version}: install the same version in the worker's image.`
          );
          break;
        }
        events.progress({
          type: 'hello',
          mst: message.mst,
          ...(message.image ? { image: message.image } : {}),
          client: message.client.name,
        });
      } else if (message.type === 'need-tokens') {
        const tokens = await events.requestTokens({
          servers: message.servers,
          reason: message.reason,
        });
        for (const token of Object.values(tokens.byServer))
          secrets.push(token.accessToken);
        for (const value of Object.values(tokens.env ?? {}))
          if (value) secrets.push(value);
        send({ type: 'tokens', ...tokens });
      } else if (message.type === 'trial') {
        // Copy as the trials come, so a dropped channel loses at most one.
        await channel.get(remoteResults, shard.resultsDir);
        events.progress(message);
      } else if (message.type === 'heartbeat') {
        events.progress(message);
      } else {
        done = true;
        outcome.collected = message.collected;
        outcome.infra = message.infra;
        outcome.cancelled ||= message.cancelled;
        cleanupFailed = message.cleanup === 'failed';
        stdin.close();
        clearTimeout(silence);
        // Something in the worker may keep it alive: it has had its say.
        clearTimeout(graceTimer);
        graceTimer = setTimeout(() => kill.abort(), cancelGraceMs);
      }
    }
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  } finally {
    clearTimeout(silence);
    stdin.close();
    signal.removeEventListener('abort', onAbort);
  }
  const exitCode = await run.exit.catch(() => -1);
  clearTimeout(graceTimer);
  await readingStderr.catch(() => {});
  try {
    await channel.get(remoteResults, shard.resultsDir);
  } catch {
    // Nothing more to copy, or the machine is gone: the trials are missing.
  }

  const detail = stderr.trim()
    ? ` Its last output: ${redactClientSecrets(stderr.trim(), secrets)}`
    : '';
  if (failure) outcome.reason = failure;
  else if (outcome.cancelled) outcome.reason = 'The shard was cancelled.';
  else if (!done)
    outcome.reason = `The worker exited (code ${exitCode}) before it finished.${detail}`;
  else if (cleanupFailed)
    outcome.reason = "The worker couldn't remove its tokens.";
  // After `done`, an exit forced by the grace period isn't a failure.
  else if (exitCode !== 0 && !kill.signal.aborted)
    outcome.reason = `The worker exited with code ${exitCode}.${detail}`;
  outcome.ok = outcome.reason === undefined;
  return outcome;
}

/**
 * An environment that creates a machine per shard with `provision` and runs
 * the shard over the machine's channel (ADR 0004). Each machine is deleted
 * when its shard ends, or kept as `context.keep` says.
 */
export function machineEnvironment(
  context: EnvironmentContext,
  provision: (shard: ShardSpec, signal: AbortSignal) => Promise<Machine>,
  options: Omit<ShardChannelOptions, 'workDir'> = {}
): Environment {
  const live = new Set<Machine>();
  return {
    async runShard(shard, events, signal) {
      let machine: Machine;
      try {
        machine = await provision(shard, signal);
      } catch (error) {
        return {
          ok: false,
          reason: `Couldn't create a machine for shard ${shard.index + 1}: ${error instanceof Error ? error.message : String(error)}`,
          collected: 0,
          infra: 0,
          cancelled: signal.aborted,
        };
      }
      live.add(machine);
      let outcome: ShardOutcome | undefined;
      try {
        outcome = await runShardOverChannel(
          machine.channel,
          shard,
          events,
          signal,
          {
            ...options,
            ...(machine.workDir ? { workDir: machine.workDir } : {}),
          }
        );
        return outcome;
      } finally {
        live.delete(machine);
        const keep =
          context.keep === 'always' ||
          (context.keep === 'failed' && !outcome?.ok);
        await machine.dispose({ keep });
      }
    },
    async close() {
      const remaining = [...live];
      live.clear();
      await Promise.allSettled(
        remaining.map((machine) => machine.dispose({ keep: false }))
      );
    },
  };
}
