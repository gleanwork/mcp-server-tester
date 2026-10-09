/**
 * The worker side of a shard (`mst collect`, ADR 0004). It runs the
 * bundle's requests with the same client code a local run uses, writes each
 * result as soon as it finishes, and talks `mst.shard/v1` to the coordinator.
 */
import { randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import packageJson from '../../../package.json' with { type: 'json' };
import { getClient } from '../builtinClients.js';
import { redactClientSecrets } from '../clientSecrets.js';
import { isInfrastructureError } from '../infrastructureFailure.js';
import { resolveServerSecrets } from '../serverSecrets.js';
import { installPlugins } from '../../plugins/extensions.js';
import { loadPlugins } from '../../plugins/loadPlugins.js';
import type {
  ClientBatchRequest,
  ClientRunContext,
  ClientRunResult,
} from '../evalFrameworkTypes.js';
import {
  SHARD_PROTOCOL,
  encodeMessage,
  parseCoordinatorMessage,
  readShardBundle,
  type ShardTokens,
  type TrialKey,
  type WorkerMessage,
} from './protocol.js';

/** Where the worker keeps access tokens: a tmpfs mount in worker images. */
const DEFAULT_TOKENS_DIR = '/run/mst/tokens';

export interface CollectShardOptions {
  bundleDir: string;
  resultsDir: string;
  /** The coordinator's lines (the worker's stdin). */
  input: AsyncIterable<string>;
  /** Writes one protocol line (the worker's stdout). */
  write: (line: string) => void;
  /**
   * `MST_TOKENS_DIR` (default `/run/mst/tokens`), `MST_IMAGE` (the image's
   * digest), `MST_HEARTBEAT_MS` (default 15000) and `MST_TOKEN_RENEW_MS`
   * (how long before expiry to ask again; default 120000).
   */
  env?: Readonly<Record<string, string | undefined>>;
}

/** A promise with its resolver: the coordinator's next `tokens`. */
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

async function writeFileAtomically(
  file: string,
  content: string,
  mode?: number
): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${randomBytes(4).toString('hex')}.tmp`;
  await fs.writeFile(temporary, content, { mode });
  await fs.rename(temporary, file);
}

/**
 * Runs the shard in `bundleDir` and returns the process's exit code. A
 * cancel (or the coordinator closing stdin) lets the trial in flight finish,
 * runs no more, and still reports `done`.
 */
export async function collectShard(
  options: CollectShardOptions
): Promise<number> {
  const env = options.env ?? process.env;
  const send = (message: WorkerMessage) =>
    options.write(encodeMessage(message));
  const bundle = await readShardBundle(options.bundleDir);
  const tokensDir = env.MST_TOKENS_DIR ?? DEFAULT_TOKENS_DIR;
  const heartbeatMs = Number(env.MST_HEARTBEAT_MS ?? 15_000);
  const renewMs = Number(env.MST_TOKEN_RENEW_MS ?? 120_000);
  const firstRequest = bundle.batches[0]?.requests[0];

  let cancelled = false;
  let waiting = deferred<ShardTokens>();
  // Stops the shard after the trial in flight; a wait for tokens ends too.
  const cancel = () => {
    cancelled = true;
    waiting.resolve({ byServer: {} });
  };
  // Read the coordinator's messages for as long as the shard runs.
  const reading = (async () => {
    for await (const line of options.input) {
      const message = parseCoordinatorMessage(line);
      if (message.type === 'cancel') cancel();
      else {
        const { type: _type, ...tokens } = message;
        waiting.resolve(tokens);
      }
    }
    // The coordinator is gone: finish the trial in flight, and stop.
    cancel();
  })();
  reading.catch(cancel);

  send({
    type: 'hello',
    protocol: SHARD_PROTOCOL,
    mst: packageJson.version,
    ...(env.MST_IMAGE ? { image: env.MST_IMAGE } : {}),
    client: { name: firstRequest?.config.type ?? 'none' },
  });
  const heartbeat = setInterval(
    () => send({ type: 'heartbeat', at: new Date().toISOString() }),
    heartbeatMs
  );
  heartbeat.unref();

  // Values the worker never lets out in an error: tokens and secrets.
  const secrets = new Set<string>();
  let runEnv: Record<string, string> = {};
  let renewal: NodeJS.Timeout | undefined;
  async function receiveTokens(reason: 'start' | 'expiring'): Promise<void> {
    if (cancelled) return;
    waiting = deferred<ShardTokens>();
    send({ type: 'need-tokens', servers: bundle.tokenServers, reason });
    const tokens = await waiting.promise;
    if (cancelled) return;
    for (const [server, token] of Object.entries(tokens.byServer)) {
      // A label names a file in the tokens directory, never a path.
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(server))
        throw new Error(`"${server}" can't name a token file.`);
      secrets.add(token.accessToken);
      await writeFileAtomically(
        path.join(tokensDir, server),
        token.accessToken,
        0o600
      );
    }
    if (tokens.env) {
      runEnv = tokens.env;
      for (const value of Object.values(tokens.env))
        if (value) secrets.add(value);
    }
    // Ask again before the first token expires.
    const expiries = Object.values(tokens.byServer)
      .map((token) => token.expiresAt)
      .filter((at): at is number => at !== undefined);
    if (expiries.length) {
      clearTimeout(renewal);
      renewal = setTimeout(
        () => {
          receiveTokens('expiring').catch(() => {});
        },
        Math.max(0, Math.min(...expiries) - renewMs - Date.now())
      );
      renewal.unref();
    }
  }

  let collected = 0;
  let infra = 0;
  async function save(
    batch: number,
    index: number,
    key: TrialKey,
    result: ClientRunResult
  ): Promise<void> {
    const stored: ClientRunResult = result.error
      ? { ...result, error: redactClientSecrets(result.error, [...secrets]) }
      : result;
    const relative = `${batch}/${index}.json`;
    await writeFileAtomically(
      path.join(options.resultsDir, relative),
      `${JSON.stringify({ format: SHARD_PROTOCOL, kind: 'client-result', key, result: stored })}\n`
    );
    const isInfra =
      stored.error !== undefined &&
      (stored.diagnostics?.failureKind !== undefined ||
        isInfrastructureError(stored.error));
    if (isInfra) infra++;
    else collected++;
    send({
      type: 'trial',
      key,
      status: isInfra ? 'infra' : 'collected',
      path: relative,
    });
  }

  try {
    await receiveTokens('start');
    const runtimeEnv = { ...runEnv, MST_TOKENS_DIR: tokensDir };
    installPlugins(
      await loadPlugins(bundle.plugins, { baseDir: options.bundleDir })
    );
    // Servers arrive as declared; their secrets come from this machine's
    // environment and the coordinator's `tokens`.
    const serverEnv = { ...process.env, ...runtimeEnv };
    for (const [batchIndex, batch] of bundle.batches.entries()) {
      if (cancelled || !batch.requests.length) continue;
      const definition = getClient(batch.requests[0]!.config.type);
      if (
        batch.requests.some(
          (request) => request.config.type !== batch.requests[0]!.config.type
        )
      )
        throw new Error('A shard batch must hold one client type.');
      const requests: ClientBatchRequest[] = batch.requests.map((request) => ({
        ...request,
        input: {
          ...request.input,
          servers: request.input.servers.map((server) =>
            resolveServerSecrets(server, serverEnv)
          ),
          env: runtimeEnv,
        },
      }));
      const keyOf = (index: number): TrialKey => ({
        variant: batch.variant.name,
        caseId: requests[index]!.caseId,
        trial: requests[index]!.trial,
      });
      const context: ClientRunContext = {
        evalConfig: bundle.evalConfig,
        variant: batch.variant,
        env: runtimeEnv,
      };
      if (definition.runBatch) {
        const reported = new Set<number>();
        const results = await definition.runBatch(requests, {
          ...context,
          reportResult: async (index, result) => {
            if (reported.has(index) || !requests[index]) return;
            reported.add(index);
            await save(batchIndex, index, keyOf(index), result);
          },
        });
        // What the client didn't report as it went.
        for (const [index, result] of results.entries())
          if (!reported.has(index) && requests[index])
            await save(batchIndex, index, keyOf(index), result);
        continue;
      }
      for (const [index, request] of requests.entries()) {
        if (cancelled) break;
        let result: ClientRunResult;
        try {
          result = await definition.run!(
            request.input,
            request.config,
            context
          );
        } catch (error) {
          result = {
            finalText: '',
            events: [],
            error: error instanceof Error ? error.message : String(error),
          };
        }
        await save(batchIndex, index, keyOf(index), result);
      }
    }
  } finally {
    clearInterval(heartbeat);
    clearTimeout(renewal);
  }
  let cleanup: 'ok' | 'failed' = 'ok';
  try {
    await fs.rm(tokensDir, { recursive: true, force: true });
  } catch {
    cleanup = 'failed';
  }
  send({ type: 'done', collected, infra, cancelled, cleanup });
  return 0;
}
