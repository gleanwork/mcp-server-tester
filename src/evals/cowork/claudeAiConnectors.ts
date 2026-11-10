import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { link, mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import { dirname } from 'node:path';
import { describeError } from '../../utils/describeError.js';
import { surfacedTools } from '../claudeCodeEvents.js';

const ToolPolicySchema = z.enum(['allow', 'ask', 'block', 'inherit']);
export const CloudConnectorsSchema = z
  .object({
    default: z.enum(['block', 'inherit']).default('block'),
    servers: z
      .record(
        z.string(),
        z
          .object({
            policy: z
              .enum(['read-only', 'allow-all', 'ask', 'block', 'inherit'])
              .default('read-only'),
            tools: z.record(z.string(), ToolPolicySchema).default({}),
          })
          .strict()
      )
      .default({}),
    failOnApproval: z.boolean().default(true),
  })
  .strict();
export type CloudConnectorConfig = z.input<typeof CloudConnectorsSchema>;
export type PermissionPatch = Record<string, boolean | null>;
export const CloudPermissionStateSchema = z.object({
  accountId: z.string().min(1),
  organizationId: z.string().min(1),
  permissions: z.record(z.string(), z.boolean()),
});
export type CloudPermissionState = z.infer<typeof CloudPermissionStateSchema>;
export const CloudConnectorSnapshotSchema = CloudPermissionStateSchema.extend({
  servers: z.array(
    z.object({
      id: z.string().min(1),
      name: z.string().min(1),
      nativeName: z.string().min(1),
      url: z.string().optional(),
      connectionState: z.string().nullable(),
      toolDiscoveryError: z.string().optional(),
      tools: z.array(
        z.object({
          name: z.string().min(1),
          enabledKey: z.string().min(1),
          approvalKey: z.string().min(1),
          readOnly: z.boolean().optional(),
          maxPermission: z.string().nullable().optional(),
          defaultPermission: z.string().nullable().optional(),
        })
      ),
    })
  ),
});
export type CloudConnectorSnapshot = z.infer<
  typeof CloudConnectorSnapshotSchema
>;
export interface CloudConnectorPlan {
  accountId: string;
  organizationId: string;
  patch: PermissionPatch;
  allowedTools: string[];
  blockedTools: string[];
  managedServers: string[];
  serverDisplayNames: Record<string, string>;
  failOnApproval: boolean;
}

/** Resolve names once; every permission is set with the server's actual keys. */
export function planCloudConnectors(
  snapshot: CloudConnectorSnapshot,
  input: CloudConnectorConfig
): CloudConnectorPlan {
  const config = CloudConnectorsSchema.parse(input);
  const selections = new Map<
    string,
    z.output<typeof CloudConnectorsSchema>['servers'][string]
  >();
  for (const [selector, settings] of Object.entries(config.servers)) {
    const matches = snapshot.servers.filter(
      (s) => s.id === selector || s.name === selector
    );
    if (matches.length !== 1)
      throw new Error(
        `Connector ${selector} is unknown or ambiguous; use its exact ID.`
      );
    const server = matches[0]!;
    if (selections.has(server.id))
      throw new Error(`Connector ${server.name} was selected twice.`);
    if (
      !['block', 'inherit'].includes(settings.policy) &&
      server.connectionState !== 'connected'
    )
      throw new Error(
        `Connector ${server.name} is not connected; complete its sign-in first.`
      );
    if (
      !['block', 'inherit'].includes(settings.policy) &&
      server.toolDiscoveryError
    )
      throw new Error(
        `Cannot configure ${server.name}: ${server.toolDiscoveryError}`
      );
    for (const tool of Object.keys(settings.tools)) {
      if (!server.tools.some((t) => t.name === tool))
        throw new Error(`Unknown tool ${server.name}/${tool}.`);
    }
    selections.set(server.id, settings);
  }
  const patch: PermissionPatch = {};
  const allowedTools: string[] = [];
  const blockedTools: string[] = [];
  const managedServers: string[] = [];
  const nativeNames = new Set<string>();
  for (const server of snapshot.servers) {
    if (server.connectionState === 'connected') {
      if (nativeNames.has(server.nativeName))
        throw new Error(
          `Ambiguous native connector name ${server.nativeName}.`
        );
      nativeNames.add(server.nativeName);
    }
    const selected = selections.get(server.id);
    const policy = selected?.policy ?? config.default;
    if (
      policy === 'block' &&
      server.connectionState === 'connected' &&
      server.toolDiscoveryError !== undefined
    )
      throw new Error(
        `Cannot configure ${server.name}: ${server.toolDiscoveryError}. Cannot safely block this connected connector without its tool inventory; restore connector access and retry.`
      );
    if (policy !== 'inherit') managedServers.push(server.nativeName);
    // Also block stale keys for excluded servers, including old tool versions.
    if (policy === 'block') {
      for (const key of Object.keys(snapshot.permissions)) {
        if (key.startsWith(`${server.id}:`)) patch[key] = false;
      }
    }
    for (const tool of server.tools) {
      if (
        !tool.enabledKey.startsWith(`${server.id}:`) ||
        !tool.approvalKey.startsWith(`${server.id}:`) ||
        tool.enabledKey === tool.approvalKey
      )
        throw new Error(
          `Invalid permission keys for ${server.name}/${tool.name}.`
        );
      const mode =
        selected?.tools[tool.name] ??
        (policy === 'read-only'
          ? tool.readOnly === true
            ? 'allow'
            : 'block'
          : policy === 'allow-all'
            ? 'allow'
            : policy);
      if (mode === 'inherit') continue;
      if (mode !== 'block' && server.connectionState !== 'connected')
        throw new Error(`Connector ${server.name} is not connected.`);
      if (mode !== 'block' && tool.maxPermission != null) {
        const max = tool.maxPermission;
        const permitted =
          mode === 'ask'
            ? ['ask', 'allow', 'always_allow'].includes(max)
            : ['allow', 'always_allow'].includes(max);
        if (!permitted)
          throw new Error(
            `Organization policy prevents ${mode} for ${server.name}/${tool.name}.`
          );
      }
      if (mode === 'ask' && config.failOnApproval)
        throw new Error('An ask policy requires failOnApproval: false.');
      patch[tool.enabledKey] = mode !== 'block';
      patch[tool.approvalKey] = mode === 'allow';
      const native = `mcp__${server.nativeName}__${tool.name}`;
      if (mode === 'block') blockedTools.push(native);
      else allowedTools.push(native);
    }
  }
  return {
    accountId: snapshot.accountId,
    organizationId: snapshot.organizationId,
    patch,
    allowedTools: allowedTools.sort(),
    blockedTools: blockedTools.sort(),
    managedServers,
    serverDisplayNames: Object.fromEntries(
      snapshot.servers.map((server) => [server.nativeName, server.name])
    ),
    failOnApproval: config.failOnApproval,
  };
}

/** One submitted cloud task. An unbound task cannot be proved complete. */
export interface CloudConnectorTask {
  startedAt: string;
  sessionId?: string;
}

/** Use only when the adapter proves rejection BEFORE permission PATCH dispatch. */
export class CloudPermissionWriteNotSentError extends Error {
  override name = 'CloudPermissionWriteNotSentError';
}

export interface CloudConnectorIO {
  inspect(): Promise<CloudConnectorSnapshot>;
  read(): Promise<CloudPermissionState>;
  patch(
    identity: Pick<CloudPermissionState, 'accountId' | 'organizationId'>,
    patch: PermissionPatch,
    expected: PermissionPatch
  ): Promise<void>;
  /** Provider evidence must prove this exact bound task is no longer running. */
  assertTaskComplete?(task: CloudConnectorTask): Promise<void>;
}

const PermissionPatchSchema = z.record(z.string(), z.boolean().nullable());
const CloudSessionIdSchema = z.string().regex(/^cse_[0-9A-Za-z_]+$/);
/** v2 retains immutable restoration facts alongside unresolved writes/tasks. */
const JournalSchema = z
  .object({
    version: z.literal(2),
    accountId: z.string().min(1),
    organizationId: z.string().min(1),
    original: PermissionPatchSchema,
    applied: PermissionPatchSchema,
    pendingWrite: z
      .object({
        purpose: z.enum(['configure', 'restore']),
        patch: PermissionPatchSchema,
        expected: PermissionPatchSchema,
      })
      .strict()
      .optional(),
    pendingTask: z
      .object({
        startedAt: z.string().datetime(),
        sessionId: CloudSessionIdSchema.optional(),
      })
      .strict()
      .optional(),
  })
  .strict();
type Journal = z.infer<typeof JournalSchema>;

async function syncJournalDirectory(path: string): Promise<void> {
  const directory = await open(dirname(path), 'r');
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}

/** Publish complete, synced, owner-only replacements; never truncate the journal. */
async function writeJournal(
  path: string,
  journal: Journal,
  create = false
): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    const file = await open(temporary, 'wx', 0o600);
    try {
      await file.writeFile(JSON.stringify(journal));
      await file.sync();
    } finally {
      await file.close();
    }
    // Exclusive publication prevents even an unexpected existing journal from
    // becoming a fresh baseline. Later replacements are atomic under the lease.
    if (create) await link(temporary, path);
    else await rename(temporary, path);
    await syncJournalDirectory(path);
  } finally {
    await rm(temporary, { force: true });
  }
}

async function readJournal(path: string): Promise<Journal | undefined> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
  const value: unknown = JSON.parse(text);
  if (
    value !== null &&
    typeof value === 'object' &&
    'version' in value &&
    value.version === 1
  )
    throw new Error(
      `Connector journal version 1 cannot prove permission write outcomes or task completion. Journal retained at ${path}; manual resolution is required: establish provider-side write quiescence and task completion, then restore the recorded original permissions with account support. Do not delete the journal or start another run before resolution.`
    );
  return JournalSchema.parse(value);
}

function assertNoPendingWrite(journal: Journal, path: string): void {
  if (journal.pendingWrite)
    throw new Error(
      `The ${journal.pendingWrite.purpose} permission write outcome is unknown. Journal retained at ${path}; automatic rollback, recovery and new configuration are refused even when a read matches the original permissions. Manual resolution is required: establish provider-side write quiescence and restore the recorded original permissions with account support. Do not delete the journal or start another run before resolution.`
    );
}

async function requireJournal(path: string): Promise<Journal> {
  const journal = await readJournal(path);
  if (!journal)
    throw new Error(
      `Connector recovery journal is missing at ${path}; refusing task changes.`
    );
  assertNoPendingWrite(journal, path);
  return journal;
}

/** A persisted marker survives every uncertain outcome, including failed reads. */
async function writePermissions(
  io: CloudConnectorIO,
  path: string,
  journal: Journal,
  purpose: 'configure' | 'restore',
  patch: PermissionPatch,
  expected: PermissionPatch
): Promise<void> {
  assertNoPendingWrite(journal, path);
  await writeJournal(path, {
    ...journal,
    pendingWrite: { purpose, patch, expected },
  });
  function unresolved(error: unknown): Error {
    return new Error(
      `The ${purpose} permission write failed (${describeError(error)}); its outcome is unknown. Journal retained at ${path}; automatic rollback and recovery are refused. Manual resolution requires provider-side write quiescence before restoring the recorded original permissions.`,
      { cause: error }
    );
  }
  try {
    await io.patch(journal, patch, expected);
  } catch (error) {
    if (error instanceof CloudPermissionWriteNotSentError) {
      try {
        await writeJournal(path, journal);
      } catch (journalError) {
        throw new AggregateError(
          [error, journalError],
          `Permission write was not sent (${describeError(error)}), but recording that outcome failed (${describeError(journalError)}); journal retained at ${path}.`
        );
      }
      throw error;
    }
    throw unresolved(error);
  }
  try {
    await verifyPatch(io, journal, patch);
    await writeJournal(path, journal);
  } catch (error) {
    throw unresolved(error);
  }
}

async function completePendingTask(
  io: CloudConnectorIO,
  path: string,
  journal: Journal
): Promise<Journal> {
  assertNoPendingWrite(journal, path);
  if (!journal.pendingTask) return journal;
  sameIdentity(await io.read(), journal);
  if (!journal.pendingTask.sessionId)
    throw new Error(
      `The pending cloud task is unbound; completion cannot be proved. Journal retained at ${path}; manual resolution is required to identify the submitted task and establish completion before restoring permissions.`
    );
  if (!io.assertTaskComplete)
    throw new Error(
      `Cloud task completion proof is unavailable. Journal retained at ${path}; manual resolution is required to establish completion before restoring permissions.`
    );
  await io.assertTaskComplete({ ...journal.pendingTask });
  sameIdentity(await io.read(), journal);
  const completed = { ...journal };
  delete completed.pendingTask;
  await writeJournal(path, completed);
  return completed;
}
function valueAt(state: CloudPermissionState, key: string): boolean | null {
  return Object.hasOwn(state.permissions, key) ? state.permissions[key]! : null;
}
function sameIdentity(
  state: CloudPermissionState,
  identity: Pick<CloudPermissionState, 'accountId' | 'organizationId'>
): void {
  if (
    state.accountId !== identity.accountId ||
    state.organizationId !== identity.organizationId
  )
    throw new Error(
      'Claude account or organization changed; refusing a permission write.'
    );
}
async function verifyPatch(
  io: CloudConnectorIO,
  identity: Pick<CloudPermissionState, 'accountId' | 'organizationId'>,
  patch: PermissionPatch
): Promise<void> {
  for (let attempt = 0; attempt < 10; attempt++) {
    const current = await io.read();
    sameIdentity(current, identity);
    if (
      Object.entries(patch).every(
        ([key, value]) => valueAt(current, key) === value
      )
    )
      return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(
    'Claude did not persist the requested connector permissions.'
  );
}

/**
 * Restore only our own values, after exact task-completion proof. Unknown
 * writes and legacy journals require manual resolution, never compensating
 * writes or a matching read. The caller holds the desktop/account lease.
 */
export async function recoverCloudConnectorSettings(
  io: CloudConnectorIO,
  journalPath: string
): Promise<boolean> {
  const saved = await readJournal(journalPath);
  if (!saved) return false;
  assertNoPendingWrite(saved, journalPath);
  const journal = await completePendingTask(io, journalPath, saved);
  const current = await io.read();
  sameIdentity(current, journal);
  const patch: PermissionPatch = {};
  const expected: PermissionPatch = {};
  const conflicts: string[] = [];
  for (const [key, original] of Object.entries(journal.original)) {
    const live = valueAt(current, key);
    if (live === original) continue;
    if (live !== journal.applied[key]) {
      conflicts.push(key);
      continue;
    }
    patch[key] = original;
    expected[key] = live;
  }
  if (Object.keys(patch).length)
    await writePermissions(
      io,
      journalPath,
      journal,
      'restore',
      patch,
      expected
    );
  if (conflicts.length)
    throw new Error(
      `Connector restore found ${conflicts.length} concurrent edits. Recovery journal retained at ${journalPath}.`
    );
  await verifyPatch(io, journal, journal.original);
  await rm(journalPath);
  await syncJournalDirectory(journalPath);
  return true;
}

/** The caller holds the desktop/account lease throughout this transaction. */
export async function configureCloudConnectors(
  io: CloudConnectorIO,
  config:
    | CloudConnectorConfig
    | ((snapshot: CloudConnectorSnapshot) => CloudConnectorConfig),
  journalPath: string
) {
  await recoverCloudConnectorSettings(io, journalPath);
  const snapshot = await io.inspect();
  const plan = planCloudConnectors(
    snapshot,
    typeof config === 'function' ? config(snapshot) : config
  );
  const applied: PermissionPatch = {};
  const original: PermissionPatch = {};
  for (const [key, value] of Object.entries(plan.patch)) {
    const before = valueAt(snapshot, key);
    if (before === value) continue;
    applied[key] = value;
    original[key] = before;
  }
  const journal: Journal = {
    version: 2,
    accountId: snapshot.accountId,
    organizationId: snapshot.organizationId,
    original,
    applied,
  };
  await mkdir(dirname(journalPath), { recursive: true, mode: 0o700 });
  await writeJournal(journalPath, journal, true);
  try {
    if (Object.keys(applied).length)
      await writePermissions(
        io,
        journalPath,
        journal,
        'configure',
        applied,
        original
      );
    await verifyPatch(io, snapshot, plan.patch);
  } catch (error) {
    try {
      await recoverCloudConnectorSettings(io, journalPath);
    } catch (restoreError) {
      throw new AggregateError(
        [error, restoreError],
        `Configuration failed (${describeError(error)}) and rollback failed (${describeError(restoreError)}); inspect ${journalPath}.`
      );
    }
    throw error;
  }
  // The desktop lease excludes other runs. Serialize this session's async
  // mirror/task callbacks with restoration so no stale update loses task state.
  let changes = Promise.resolve();
  function exclusive<T>(change: () => Promise<T>): Promise<T> {
    const result = changes.then(change);
    changes = result.then(
      () => undefined,
      () => undefined
    );
    return result;
  }
  return {
    plan,
    async verify() {
      await verifyPatch(io, snapshot, plan.patch);
    },
    async restore() {
      await exclusive(async () => {
        await recoverCloudConnectorSettings(io, journalPath);
      });
    },
    /** Durably record possible submission BEFORE invoking the UI. */
    async beginTask(): Promise<void> {
      await exclusive(async () => {
        const current = await requireJournal(journalPath);
        if (current.pendingTask)
          throw new Error(
            `A pending task already owns connector permissions; journal retained at ${journalPath}. Confirm its completion before submitting another task.`
          );
        sameIdentity(await io.read(), current);
        await writeJournal(journalPath, {
          ...current,
          pendingTask: { startedAt: new Date().toISOString() },
        });
      });
    },
    /** Bind exactly once; an unbound or substituted session cannot prove completion. */
    async bindTask(sessionId: string): Promise<void> {
      await exclusive(async () => {
        if (!CloudSessionIdSchema.safeParse(sessionId).success)
          throw new Error(
            'Invalid cloud session identity; expected an exact cse_ session ID.'
          );
        const current = await requireJournal(journalPath);
        if (!current.pendingTask)
          throw new Error(
            'There is no pending task to bind; begin the task before submission.'
          );
        if (current.pendingTask.sessionId !== undefined)
          throw new Error(
            'The pending task is already bound; refusing to rebind its session identity.'
          );
        sameIdentity(await io.read(), current);
        await writeJournal(journalPath, {
          ...current,
          pendingTask: { ...current.pendingTask, sessionId },
        });
      });
    },
    /** Clear ownership only after the adapter proves the exact task completed. */
    async confirmTaskComplete(): Promise<void> {
      await exclusive(async () => {
        await completePendingTask(
          io,
          journalPath,
          await requireJournal(journalPath)
        );
      });
    },
  };
}

function records(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) return [];
  return (value as unknown[]).filter(
    (item): item is Record<string, unknown> =>
      item !== null && typeof item === 'object' && !Array.isArray(item)
  );
}

/** Validate actual exposure, not the model's claim about its own tools. */
export function verifyCloudConnectorEvents(
  plan: CloudConnectorPlan,
  events: readonly { payload?: Record<string, unknown> }[]
) {
  const init = events
    .filter((e) => e.payload?.type === 'system' && e.payload.subtype === 'init')
    .at(-1)?.payload;
  if (!init || !Array.isArray(init.tools))
    throw new Error('Cloud session has no tool inventory to verify.');
  const observed = new Set(
    init.tools.filter((tool): tool is string => typeof tool === 'string')
  );
  const pendingServers = records(init.mcp_servers)
    .filter(
      (server): server is { name: string; status: 'pending' } =>
        server?.status === 'pending' && typeof server.name === 'string'
    )
    .map((server) => server.name);
  const searchIds = new Set<string>();
  for (const event of events) {
    const payload = event.payload;
    const content = (payload?.message as { content?: unknown } | undefined)
      ?.content;
    for (const block of records(content)) {
      if (
        payload?.type === 'assistant' &&
        block.type === 'tool_use' &&
        typeof block.name === 'string'
      ) {
        observed.add(block.name);
        if (block.name === 'ToolSearch' && typeof block.id === 'string')
          searchIds.add(block.id);
      }
      if (
        payload?.type === 'user' &&
        block.type === 'tool_result' &&
        typeof block.tool_use_id === 'string' &&
        searchIds.has(block.tool_use_id)
      ) {
        // Only a matched ToolSearch result is catalog evidence; ordinary MCP
        // results can mention tool names without exposing those tools.
        const output =
          typeof block.content === 'string'
            ? block.content
            : JSON.stringify(block.content);
        for (const tool of surfacedTools(output)) {
          observed.add(
            tool.server === undefined
              ? tool.name
              : `mcp__${tool.server}__${tool.name}`
          );
        }
      }
    }
  }
  const tools = [...observed];
  const allowed = new Set(plan.allowedTools);
  const blocked = new Set(plan.blockedTools);
  const unexpected = tools.filter(
    (tool) =>
      blocked.has(tool) ||
      (plan.managedServers.some((server) =>
        tool.startsWith(`mcp__${server}__`)
      ) &&
        !allowed.has(tool))
  );
  const unobservedAllowedTools = plan.allowedTools.filter(
    (tool) => !observed.has(tool)
  );
  // Init can name a pending server by its display or canonical native name.
  // Resolve only catalogued aliases; tool permissions stay canonical.
  const pendingNativeNames = Object.entries(plan.serverDisplayNames)
    .filter(
      ([nativeName, displayName]) =>
        pendingServers.includes(nativeName) ||
        pendingServers.includes(displayName)
    )
    .map(([nativeName]) => nativeName);
  // Cowork can leave init's MCP servers pending even after ToolSearch loads them.
  // Do not claim that this partial snapshot proves the full exposed inventory.
  const missing = unobservedAllowedTools.filter(
    (tool) =>
      !pendingNativeNames.some((server) => tool.startsWith(`mcp__${server}__`))
  );
  const approvals = events.filter(
    (e) =>
      e.payload?.type === 'control_request' &&
      (e.payload.request as { subtype?: unknown } | undefined)?.subtype ===
        'can_use_tool'
  ).length;
  if (unexpected.length || missing.length)
    throw new Error(
      `Cloud connector configuration mismatch: ${unexpected.length} unexpected tools, ${missing.length} missing tools. Unexpected: ${unexpected.join(', ') || 'none'}. Missing: ${missing.join(', ') || 'none'}. The connector catalog may have changed since preparation.`
    );
  if (plan.failOnApproval && approvals)
    throw new Error(
      `Cloud requested ${approvals} tool approvals despite the always-allow policy.`
    );
  return {
    allowedTools: plan.allowedTools,
    blockedTools: plan.blockedTools,
    observedToolCount: tools.length,
    observedAllowedTools: plan.allowedTools.filter((tool) =>
      observed.has(tool)
    ),
    unobservedAllowedTools,
    pendingServers,
    catalogComplete: pendingServers.length === 0,
    approvalRequests: approvals,
  };
}
