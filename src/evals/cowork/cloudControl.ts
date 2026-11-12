import { readFile } from 'node:fs/promises';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { claimDesktopLease } from '../desktopBatch.js';
import { variantEvalConfig } from '../evalConfig.js';
import type { ShardBundle } from '../runners/protocol.js';
import { coworkDesktopLease } from './desktopLease.js';
import {
  claudeAiDebugPort,
  claudeAiPaths,
  cloudConnectorIO,
  cloudInitialMessage,
  cloudTrialMetadata,
  fetchCloudEvents,
  listCloudSessions,
} from './claudeAi.js';
import {
  assertFirstPartyServers,
  bindFirstPartyServers,
  isFirstPartyCowork,
} from './firstParty.js';
import {
  CloudConnectorsSchema,
  configureCloudConnectors,
  verifyCloudConnectorEvents,
  type CloudPermissionState,
} from './claudeAiConnectors.js';
import {
  COWORK_CLOUD_CONTROL_MAX_FRAME_BYTES,
  COWORK_CLOUD_CONTROL_PROTOCOL,
  CoworkCloudControlRequestSchema,
  type CoworkAccountIdentity,
  type CoworkCloudControlRequest,
  type CoworkCloudControlResponse,
  type CoworkCloudPreparation,
} from './cloudControlProtocol.js';

export interface CoworkAccountControlOptions {
  /** Actual coordinator bundle, not a worker-supplied configuration. */
  bundle: ShardBundle;
  /** Nonsecret credential-source assertion, checked against source Chrome. */
  sourceIdentity: CoworkAccountIdentity;
  authorization: {
    attached: true;
    dedicatedAccount: true;
    designatedSourceHost: true;
  };
  env?: NodeJS.ProcessEnv;
}
export interface CoworkAccountControl {
  dispatch(request: unknown): Promise<CoworkCloudControlResponse>;
  /** Lost relay never implies completion. Releases only a provably unused lease. */
  disconnect(): Promise<void>;
  /** An account transaction requires verified restoration before lease release. */
  close(): Promise<void>;
}

/** Source-host only. No credentials leave Chrome or enter this interface. */
export async function createCoworkAccountControl(
  options: CoworkAccountControlOptions
): Promise<CoworkAccountControl> {
  if (process.platform !== 'darwin')
    throw new Error(
      'Cowork account control requires an attached macOS source host.'
    );
  if (
    options.authorization.attached !== true ||
    options.authorization.dedicatedAccount !== true ||
    options.authorization.designatedSourceHost !== true ||
    options.bundle.shard.count !== 1 ||
    options.bundle.shard.index !== 0
  )
    throw new Error(
      'Cowork account control requires one attached shard, a dedicated account and one designated source host.'
    );
  const identity = z
    .object({ accountId: z.string().min(1), organizationId: z.string().min(1) })
    .strict()
    .parse(options.sourceIdentity);
  // Snapshot host authority before any await; callers cannot later widen it.
  const bundle = structuredClone(options.bundle);
  const batches = bundle.batches
    .filter((batch) => batch.requests.length > 0)
    .map((batch) => {
      const first = batch.requests[0]!;
      if (
        !isFirstPartyCowork(first.config) ||
        batch.requests.some(
          (request) =>
            !isDeepStrictEqual(request.config, first.config) ||
            !isDeepStrictEqual(request.input.servers, first.input.servers)
        )
      )
        throw new Error(
          'Account control requires homogeneous first-party Cowork batches.'
        );
      const evalConfig = variantEvalConfig(bundle.evalConfig, batch.variant);
      if (
        evalConfig.simulateWrites ||
        evalConfig.tools ||
        batch.variant?.tools ||
        first.config.computerUseModel ||
        first.config.appVersion
      )
        throw new Error(
          'Linux account control does not support simulated writes, tool metadata, appVersion or computerUseModel.'
        );
      const connectors =
        first.config.connectors === undefined
          ? undefined
          : CloudConnectorsSchema.parse(first.config.connectors);
      assertFirstPartyServers(first.input.servers, connectors);
      const writes =
        evalConfig.writes === undefined
          ? undefined
          : z
              .record(z.string(), z.enum(['unguarded', 'live']))
              .parse(evalConfig.writes);
      const model =
        first.config.model === undefined
          ? undefined
          : z.string().parse(first.config.model);
      return {
        requests: batch.requests,
        servers: first.input.servers,
        connectors,
        writes,
        model,
      };
    });
  if (!batches.length)
    throw new Error('Account control requires a nonempty collect bundle.');
  const port = claudeAiDebugPort(options.env ?? process.env);
  const io = cloudConnectorIO(() => port);
  const journal = claudeAiPaths().journal;
  const lease = await claimDesktopLease({
    name: 'cowork',
    lease: coworkDesktopLease('', 'darwin'),
  });
  let leaseClosed = false;
  // Sticky once a transaction or journal uncertainty is observed, even if the
  // journal later disappears. Absence alone cannot make a dispatched write safe.
  let retainSourceState = false;
  async function release(keep: boolean): Promise<void> {
    if (leaseClosed) return;
    leaseClosed = true;
    await lease.release(keep);
  }
  async function journalExists(): Promise<boolean> {
    try {
      await readFile(journal, 'utf8');
      retainSourceState = true;
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
      retainSourceState = true;
      throw error;
    }
  }
  function sameIdentity(
    state: Pick<CloudPermissionState, 'accountId' | 'organizationId'>
  ): void {
    if (
      state.accountId !== identity.accountId ||
      state.organizationId !== identity.organizationId
    )
      throw new Error(
        'Source account or organization does not match the authorized staged session.'
      );
  }
  try {
    if (await journalExists())
      throw new Error(
        'Existing source connector recovery journal blocks a new account controller. Use existing Cowork recovery first.'
      );
    sameIdentity(await io.read());
  } catch (error) {
    await release(
      retainSourceState || (await journalExists().catch(() => true))
    );
    throw error;
  }
  let changes = Promise.resolve();
  function exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const result = changes.then(operation);
    changes = result.then(
      () => undefined,
      () => undefined
    );
    return result;
  }
  let lost = false;
  let closed = false;
  let nextBatch = 0;
  let nextPrompt = 0;
  let prepared: CoworkCloudPreparation | undefined;
  let configuration:
    | Awaited<ReturnType<typeof configureCloudConnectors>>
    | undefined;
  let currentTask:
    | { prompt: string; startedAt: number; sessionId?: string }
    | undefined;
  const readableSessions = new Set<string>();
  // The worker's native-session ledger is not source authorization. Never
  // accept a previously submitted session for a fresh permission-owned task.
  const submittedSessions = new Set<string>();
  const since = Date.now();
  async function execute(request: CoworkCloudControlRequest): Promise<unknown> {
    if (lost || closed)
      throw new Error('Account controller is disconnected or closed.');
    sameIdentity(await io.read());
    switch (request.method) {
      case 'prepare': {
        if (configuration || (await journalExists()))
          throw new Error(
            'Restore the previous batch before preparing another.'
          );
        const batch = batches[nextBatch];
        if (!batch) throw new Error('No authorized batch remains.');
        let serverLabels: Record<string, string> = {};
        let remoteServerNames: string[] = [];
        let effectiveConnectors = batch.connectors ?? {};
        configuration = await configureCloudConnectors(
          {
            ...io,
            async read() {
              // configureCloudConnectors reads through this IO only after
              // publishing a journal (or while recovering one).
              retainSourceState = true;
              return io.read();
            },
            async patch(identity, patch, expected) {
              retainSourceState = true;
              return io.patch(identity, patch, expected);
            },
            async inspect() {
              const snapshot = await io.inspect();
              sameIdentity(snapshot);
              remoteServerNames = snapshot.servers.map(
                (server) => server.nativeName
              );
              return snapshot;
            },
          },
          (snapshot) => {
            const binding = bindFirstPartyServers(
              snapshot,
              batch.servers,
              batch.connectors,
              batch.writes
            );
            serverLabels = binding.labels;
            effectiveConnectors = binding.config;
            return binding.config;
          },
          journal
        );
        prepared = {
          plan: configuration.plan,
          serverLabels,
          remoteServerNames,
          requestedConnectors: batch.connectors,
          effectiveConnectors,
          servers: batch.servers,
          writes: batch.writes,
          model: batch.model,
        };
        nextPrompt = 0;
        currentTask = undefined;
        return prepared;
      }
      case 'beginTask': {
        if (!configuration || !prepared)
          throw new Error('Prepare the authorized batch first.');
        const expected = batches[nextBatch]!.requests[nextPrompt]?.input.prompt;
        if (expected === undefined || request.prompt !== expected)
          throw new Error(
            'Prompt does not match the next source-authorized trial.'
          );
        await configuration.confirmTaskComplete();
        // A prewarmed session with setup-only events is still eligible, but a
        // prior submitted prompt cannot be rebound inside the clock tolerance.
        for (const session of (await listCloudSessions(port, 10)).slice(
          0,
          10
        )) {
          if (!/^cse_[0-9A-Za-z_]+$/.test(session.id)) continue;
          const activity = Date.parse(
            session.last_event_at ?? session.created_at ?? ''
          );
          // Only provably old history is unrelated. Recent or undated
          // sessions still require a complete read before a new submission.
          if (Number.isFinite(activity) && activity < since - 5_000) continue;
          if (
            cloudInitialMessage(await fetchCloudEvents(port, session.id)) !==
            undefined
          )
            submittedSessions.add(session.id);
        }
        sameIdentity(await io.read());
        const startedAt = Date.now();
        await configuration.beginTask();
        currentTask = { prompt: expected, startedAt };
        nextPrompt++;
        return null;
      }
      case 'bindTask': {
        if (!configuration || !currentTask || currentTask.sessionId)
          throw new Error('No unbound source-owned task.');
        if (submittedSessions.has(request.sessionId))
          throw new Error(
            'An already submitted source session cannot own a new task.'
          );
        const events = await fetchCloudEvents(port, request.sessionId);
        const metadata = cloudTrialMetadata(
          { id: request.sessionId },
          events,
          currentTask.startedAt
        );
        if (!metadata || cloudInitialMessage(events) !== currentTask.prompt)
          throw new Error(
            'Source cloud evidence does not bind this prompt and start time.'
          );
        // Recheck identity after source reads, before durable task binding.
        sameIdentity(await io.read());
        await configuration.bindTask(request.sessionId);
        currentTask.sessionId = request.sessionId;
        submittedSessions.add(request.sessionId);
        readableSessions.add(request.sessionId);
        return null;
      }
      case 'confirmTaskComplete':
        if (!configuration) throw new Error('No prepared account transaction.');
        await configuration.confirmTaskComplete();
        return null;
      case 'verify': {
        if (!configuration || !currentTask?.sessionId)
          throw new Error('No source-bound transcript to verify.');
        await configuration.confirmTaskComplete();
        await configuration.verify();
        const events = await fetchCloudEvents(port, currentTask.sessionId);
        sameIdentity(await io.read());
        return verifyCloudConnectorEvents(configuration.plan, events);
      }
      case 'restore':
        if (!configuration) throw new Error('No prepared account transaction.');
        await configuration.restore();
        configuration = undefined;
        prepared = undefined;
        currentTask = undefined;
        nextBatch++;
        return null;
      case 'listSessions': {
        const sessions = (await listCloudSessions(port, 10))
          .slice(0, 10)
          .filter(
            (session) =>
              /^cse_[0-9A-Za-z_]+$/.test(session.id) &&
              (session.id === currentTask?.sessionId ||
                Date.parse(session.last_event_at ?? session.created_at ?? '') >=
                  since - 5_000)
          );
        readableSessions.clear();
        for (const session of sessions) readableSessions.add(session.id);
        if (currentTask?.sessionId) readableSessions.add(currentTask.sessionId);
        return sessions;
      }
      case 'events':
        if (!readableSessions.has(request.sessionId))
          throw new Error(
            'Session is not source-observed or owned by this controller.'
          );
        return fetchCloudEvents(port, request.sessionId);
    }
  }
  return {
    async dispatch(value) {
      return exclusive(async () => {
        let id = 1;
        let method = 'request';
        try {
          if (
            Buffer.byteLength(JSON.stringify(value) ?? '') + 1 >
            COWORK_CLOUD_CONTROL_MAX_FRAME_BYTES
          )
            throw new Error('Oversized request.');
          const request = CoworkCloudControlRequestSchema.parse(value);
          id = request.id;
          method = request.method;
          const result = await execute(request);
          const response: CoworkCloudControlResponse = {
            protocol: COWORK_CLOUD_CONTROL_PROTOCOL,
            id,
            ok: true,
            result,
          };
          if (
            Buffer.byteLength(JSON.stringify(response)) + 1 >
            COWORK_CLOUD_CONTROL_MAX_FRAME_BYTES
          )
            throw new Error('Oversized response.');
          // A direct in-process relay must not receive mutable controller state.
          return structuredClone(response);
        } catch {
          return {
            protocol: COWORK_CLOUD_CONTROL_PROTOCOL,
            id,
            ok: false as const,
            error: `Cowork source ${method} failed; no task completion or account cleanup is implied. Inspect retained source recovery state.`,
          };
        }
      });
    },
    async disconnect() {
      lost = true;
      await exclusive(async () => {
        if (closed) return;
        // Dispatch may still be publishing a journal. Decide only after it
        // settles, never by worker/VM death or attempted automatic restoration.
        const retain =
          retainSourceState ||
          configuration !== undefined ||
          currentTask !== undefined ||
          (await journalExists().catch(() => true));
        await release(retain);
        if (!retain) closed = true;
      });
    },
    async close() {
      return exclusive(async () => {
        if (closed) return;
        if (lost)
          throw new Error(
            `Cowork relay was lost; source lease and recovery journal retained at ${journal}.`
          );
        try {
          if (configuration) await configuration.restore();
          if (await journalExists())
            throw new Error('Source recovery journal remains.');
          if (lost)
            throw new Error(
              'Relay was lost during source cleanup; retaining the source lease.'
            );
          await release(false);
          closed = true;
        } catch (error) {
          lost = true;
          await release(true);
          throw error;
        }
      });
    },
  };
}
