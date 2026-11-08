/**
 * The worker side of a shard (`mst collect`, ADR 0004). It runs the
 * bundle's requests with the same client code a local run uses, writes each
 * result as soon as it finishes, and talks `mst.shard/v1` to the coordinator.
 */
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import packageJson from '../../../package.json' with { type: 'json' };
import { getClient } from '../builtinClients.js';
import {
  clientSecretValues,
  namedSecretValues,
  redactedClientRun,
} from '../clientSecrets.js';
import {
  expandWorkerConnectors,
  writeTokenFile,
  type WorkerConnectors,
} from '../connectorServers.js';
import {
  isConnectorServer,
  variantEvalConfig,
  variantToolMetadata,
  type ConnectorServerConfig,
  type EvalServerConfig,
} from '../evalConfig.js';
import { isInfrastructure } from '../trialEnding.js';
import { collectClientBatch } from '../desktopBatch.js';
import {
  batchName,
  proxiedBatch,
  type ProxiedBatch,
} from '../prepareClientBatch.js';
import {
  checkReadOnlyCalls,
  readinessRetryDelaysMs,
  readyBatch,
} from '../readinessCheck.js';
import { resolveServerSecrets } from '../serverSecrets.js';
import { BatchWriteRecords, WriteRecordLedger } from '../writeRecord.js';
import { readOnlyServerLabels } from '../writeModes.js';
import { ALL_ARTIFACTS } from '../allArtifacts.js';
import { afterCopyFailed, copyArtifacts } from '../trialArtifacts.js';
import {
  usesToolSurfaceProxy,
  withoutToolVariant,
  type ToolSurfaceProxy,
} from '../toolSurfaceProxy.js';
import { startToolSurfaceProxy } from '../toolSurfaceProxyServer.js';
import { installPlugins } from '../../plugins/extensions.js';
import { settingsFor } from '../../plugins/settings.js';
import {
  loadPlugins,
  resolvePluginPackage,
} from '../../plugins/loadPlugins.js';
import type { MCPConfig } from '../../config/mcpConfig.js';
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
  type ShardBundle,
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
   * digest), `MST_PLUGIN_DIR` (where plugin packages are installed; default
   * the working directory), `MST_HEARTBEAT_MS` (default 15000) and
   * `MST_TOKEN_RENEW_MS` (how long before expiry to ask again; default 120000).
   */
  env?: Readonly<Record<string, string | undefined>>;
}

/** A promise with its resolver: the coordinator's next `tokens`. */
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

export async function writeFileAtomically(
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
 * Loads the bundle's plugins: packages from the bundle's directory, then
 * `MST_PLUGIN_DIR` (where a worker image installs them; default: the working
 * directory). Each plugin package must be the version the coordinator runs.
 */
export async function loadWorkerPlugins(
  bundle: Pick<ShardBundle, 'plugins' | 'pluginPackages'>,
  bundleDir: string,
  pluginDir: string | undefined
) {
  const options = {
    baseDir: bundleDir,
    fallbackDir: pluginDir ?? process.cwd(),
  };
  for (const specifier of bundle.plugins)
    if (path.isAbsolute(specifier) && !existsSync(specifier))
      throw new Error(
        `Plugin "${specifier}" is a file on the coordinator's machine, not on this worker. Install the plugin as a package in the worker's image.`
      );
  for (const expected of bundle.pluginPackages ?? []) {
    const found = resolvePluginPackage(expected.specifier, options);
    if (!found)
      throw new Error(
        `Plugin package ${expected.name} isn't installed on this worker (looked in ${bundleDir} and ${options.fallbackDir}). Install ${expected.name}@${expected.version} in the worker's image.`
      );
    if (found.name !== expected.name || found.version !== expected.version)
      throw new Error(
        `This worker has plugin ${found.name}@${found.version}; the run uses ${expected.name}@${expected.version}. Install the run's version in the worker's image.`
      );
  }
  return loadPlugins(bundle.plugins, options);
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
    // A trial waiting for room won't run now.
    for (const grant of grants.values()) grant();
    grants.clear();
  };
  /** Waits until the coordinator has room for this trial. */
  const acquire = async (key: TrialKey): Promise<void> => {
    if (cancelled) return;
    const granted = new Promise<void>((resolve) =>
      grants.set(grantKey(key), resolve)
    );
    send({ type: 'acquire', key });
    await granted;
  };
  // Trials waiting for room under the run's limits, by key.
  const grants = new Map<string, () => void>();
  const grantKey = (key: TrialKey) =>
    JSON.stringify([key.variant, key.caseId, key.trial]);
  // Read the coordinator's messages for as long as the shard runs.
  const reading = (async () => {
    for await (const line of options.input) {
      const message = parseCoordinatorMessage(line);
      if (message.type === 'cancel') cancel();
      else if (message.type === 'granted') {
        const grant = grants.get(grantKey(message.key));
        grants.delete(grantKey(message.key));
        grant?.();
      } else {
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
    // How a desktop client runs follows from this OS (ADR 0011).
    platform: process.platform,
    client: { name: firstRequest?.config.type ?? 'none' },
  });
  const heartbeat = setInterval(
    () => send({ type: 'heartbeat', at: new Date().toISOString() }),
    heartbeatMs
  );
  heartbeat.unref();

  // Connector servers arrive as declarations; this machine expands them.
  const declarations = new Map<string, ConnectorServerConfig>();
  for (const batch of bundle.batches)
    for (const request of batch.requests)
      for (const server of request.input.servers as EvalServerConfig[])
        if (isConnectorServer(server))
          declarations.set(server.label ?? server.connector, server);
  let connectors: WorkerConnectors | undefined;
  // Where this machine's dry-run proxies record writes (ADR 0014).
  let writesDir: string | undefined;
  // Each trial's writes, from those files. Created once the connectors are.
  let writeRecords: BatchWriteRecords | undefined;

  // Values the worker never lets out in an error: tokens and secrets.
  const secrets = new Set<string>();
  let runEnv: Record<string, string> = {};
  // Direct HTTP connectors' tokens, by the env var their server entry names.
  const connectorEnv: Record<string, string> = {};
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
      // A connector server's token goes where its expansion reads it.
      const delivery = connectors?.deliveries.get(server);
      if (delivery) {
        if (delivery.file) {
          await fs.mkdir(path.dirname(delivery.file), {
            recursive: true,
            mode: 0o700,
          });
          await writeTokenFile(delivery.file, token.accessToken);
        }
        for (const name of delivery.envNames)
          connectorEnv[name] = token.accessToken;
        continue;
      }
      await writeFileAtomically(
        path.join(tokensDir, server),
        token.accessToken,
        0o600
      );
    }
    if (tokens.env) {
      runEnv = tokens.env;
      for (const value of namedSecretValues(tokens.env)) secrets.add(value);
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
    servers: readonly MCPConfig[],
    transcript: ClientRunResult,
    previous?: { transcript: ClientRunResult; stored: ClientRunResult }
  ): Promise<ClientRunResult> {
    // Redacted, with the writes this machine's proxies recorded for the
    // trial: the coordinator can't read these files.
    const redacted: ClientRunResult = writeRecords
      ? await writeRecords.attach(`${batch}:${index}`, transcript, servers)
      : redactedClientRun(transcript, [...secrets]);
    // The client's artifacts (a Cowork session folder) are on this machine:
    // copy them beside the result, which the coordinator copies back, and
    // name them relative to the results directory.
    const relative = `${batch}/${index}.json`;
    let stored = redacted;
    if (
      redacted.artifacts &&
      previous?.transcript.artifacts?.dir === redacted.artifacts.dir
    ) {
      // An early save may have consumed temporary diagnosis files. Reuse its
      // copy, or retain its copy failure, rather than recopying missing files.
      const { artifacts: _source, ...rest } = redacted;
      // The early save had artifacts to copy and stored none: its copy
      // failed, before anything that failed the result since (the desktop's
      // cleanup), so its failure is the one that stands.
      const copyFailed = !previous.stored.artifacts;
      stored = {
        ...rest,
        ...(copyFailed
          ? {
              ending: previous.stored.ending,
              diagnostics: {
                ...rest.diagnostics,
                failureKind:
                  previous.stored.diagnostics?.failureKind ?? 'artifacts',
              },
              error: [
                ...new Set([previous.stored.error, rest.error].filter(Boolean)),
              ].join(' '),
            }
          : { artifacts: previous.stored.artifacts }),
      };
    } else if (redacted.artifacts) {
      const dir = `${batch}/${index}.artifacts`;
      const { artifacts, ...rest } = redacted;
      try {
        await copyArtifacts(artifacts, path.join(options.resultsDir, dir));
        stored = { ...rest, artifacts: { dir, include: ALL_ARTIFACTS } };
      } catch (error) {
        const message = `Couldn't copy the trial's client artifacts: ${error instanceof Error ? error.message : String(error)}`;
        stored = { ...rest, ...afterCopyFailed(rest, message) };
      }
    }
    await writeFileAtomically(
      path.join(options.resultsDir, relative),
      `${JSON.stringify({ format: SHARD_PROTOCOL, kind: 'client-result', key, result: stored })}\n`
    );
    // The runner's rule, so the worker and the coordinator agree (ADR 0010).
    const isInfra = isInfrastructure(stored);
    if (previous) {
      if (isInfrastructure(previous.stored)) infra--;
      else collected--;
    }
    if (isInfra) infra++;
    else collected++;
    send({
      type: 'trial',
      key,
      status: isInfra ? 'infra' : 'collected',
      path: relative,
    });
    return stored;
  }

  try {
    // Plugins first: their connectors expand before any token arrives.
    installPlugins(
      await loadWorkerPlugins(bundle, options.bundleDir, env.MST_PLUGIN_DIR)
    );
    if (declarations.size) {
      writesDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mst-writes-'));
      connectors = await expandWorkerConnectors([...declarations.values()], {
        tokenDirectory: path.join(tokensDir, 'connectors'),
        runId: bundle.runId,
        writes: {
          directory: writesDir,
          simulate: bundle.evalConfig.simulateWrites === true,
        },
      });
      writeRecords = new BatchWriteRecords(
        new WriteRecordLedger(connectors.writeRecordFiles),
        () => [...secrets]
      );
    }
    await receiveTokens('start');
    const runtimeEnv = {
      ...runEnv,
      ...connectorEnv,
      MST_TOKENS_DIR: tokensDir,
      // Which run a host's own telemetry belongs to (`telemetry.host`).
      MST_RUN_ID: bundle.runId,
    };
    // A malformed or retired readiness setting fails the shard before any
    // batch starts.
    readinessRetryDelaysMs(runtimeEnv);
    // Servers arrive as declared; their secrets come from this machine's
    // environment and the coordinator's `tokens`.
    const serverEnv = { ...process.env, ...runtimeEnv };
    // A resolved server's credentials are secrets by use, whatever the
    // variable that held them is named, as they are in a local run.
    const resolved = (server: MCPConfig): MCPConfig => {
      const config = resolveServerSecrets(server, serverEnv);
      for (const value of clientSecretValues(serverEnv, [config]))
        secrets.add(value);
      return config;
    };
    const serverFor = (server: unknown): MCPConfig => {
      const declared = server as EvalServerConfig;
      if (!isConnectorServer(declared)) return resolved(declared);
      const expanded = connectors?.servers.get(
        declared.label ?? declared.connector
      );
      if (!expanded)
        throw new Error(
          `Connector server "${declared.label ?? declared.connector}" wasn't expanded.`
        );
      return resolved(expanded);
    };
    for (const [batchIndex, batch] of bundle.batches.entries()) {
      if (cancelled || !batch.requests.length) continue;
      const definition = getClient(batch.requests[0]!.config.type);
      if (
        batch.requests.some(
          (request) => request.config.type !== batch.requests[0]!.config.type
        )
      )
        throw new Error('A shard batch must hold one client type.');
      const declared: ClientBatchRequest[] = batch.requests.map((request) => ({
        ...request,
        input: {
          ...request.input,
          servers: request.input.servers.map(serverFor),
          env: runtimeEnv,
        },
      }));
      const keyOf = (index: number): TrialKey => ({
        variant: batch.variant.name,
        caseId: declared[index]!.caseId,
        trial: declared[index]!.trial,
      });
      const baseContext: ClientRunContext = {
        // The variant's settings over the config's (its `coworkSetup`), as
        // a local run gives the client.
        evalConfig: variantEvalConfig(bundle.evalConfig, batch.variant),
        variant: batch.variant,
        env: runtimeEnv,
        settings: settingsFor(
          bundle.evalConfig.settings,
          batch.requests[0]!.config.type
        ),
      };
      // A variant's tool metadata reaches a proxied client through a proxy
      // on this machine, as in a local run.
      const toolMetadata = variantToolMetadata(
        bundle.evalConfig,
        batch.variant
      );
      // MST's readiness check on this machine, before the batch's first
      // trial and before the proxy starts, as in a local run. When a server
      // isn't ready, no trial of the batch runs.
      const servers = declared[0]!.input.servers;
      const ready = await readyBatch(
        definition,
        servers,
        toolMetadata && usesToolSurfaceProxy(definition)
          ? () => startToolSurfaceProxy(servers, toolMetadata)
          : undefined,
        {
          env: runtimeEnv,
          batch: batchName(batch.requests[0]!.config.type, batch),
          readOnly: readOnlyServerLabels(servers, bundle.evalConfig.writes),
        }
      );
      if (ready.notReady) {
        for (const index of declared.keys())
          await save(
            batchIndex,
            index,
            keyOf(index),
            servers,
            ready.notReady()
          );
        continue;
      }
      const proxy: ToolSurfaceProxy | undefined = ready.proxy;
      const proxied: ProxiedBatch | undefined =
        proxy && toolMetadata
          ? proxiedBatch(definition, declared, proxy, servers, toolMetadata.id)
          : undefined;
      const requests = proxied?.requests ?? declared;
      const context = proxied ? withoutToolVariant(baseContext) : baseContext;
      // A transcript under the tools' original names (`final`: its request
      // is over), its calls on `read-only` servers checked against the tools
      // they listed.
      const settled = (
        index: number,
        result: ClientRunResult,
        final: boolean
      ) =>
        checkReadOnlyCalls(
          proxied ? proxied.settle(index, result, final) : result,
          ready.readOnlyTools,
          servers
        );
      try {
        const reported = new Map<
          number,
          { transcript: ClientRunResult; stored: ClientRunResult }
        >();
        const results = await collectClientBatch(
          definition,
          requests,
          {
            ...context,
            acquire: async (index) => {
              if (!requests[index]) return;
              await acquire(keyOf(index));
              await writeRecords?.begin(`${batchIndex}:${index}`);
            },
            reportResult: async (index, result) => {
              if (reported.has(index) || !requests[index]) return;
              const transcript = settled(index, result, false);
              // The batch's scope stays open for the requests still running.
              const stored = await save(
                batchIndex,
                index,
                keyOf(index),
                servers,
                transcript
              );
              // Cleanup can mutate the live result after this early save.
              reported.set(index, {
                transcript: structuredClone(transcript),
                stored: structuredClone(stored),
              });
            },
          },
          [...secrets],
          () => cancelled
        );
        // Finalize every result: close can add a cleanup failure, lifecycle
        // timings can change, and the proxy must settle its final scope.
        for (const [index, result] of results.entries()) {
          if (!result || !requests[index]) continue;
          const transcript = settled(index, result, true);
          const previous = reported.get(index);
          if (
            JSON.stringify(transcript) !== JSON.stringify(previous?.transcript)
          )
            await save(
              batchIndex,
              index,
              keyOf(index),
              servers,
              transcript,
              previous
            );
        }
      } finally {
        proxied?.endChecks();
        await proxy?.close();
      }
    }
  } finally {
    clearInterval(heartbeat);
    clearTimeout(renewal);
    if (writesDir) await fs.rm(writesDir, { recursive: true, force: true });
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
