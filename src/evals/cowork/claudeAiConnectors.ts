import { z } from 'zod';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

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

export interface CloudConnectorIO {
  inspect(): Promise<CloudConnectorSnapshot>;
  read(): Promise<CloudPermissionState>;
  patch(
    identity: Pick<CloudPermissionState, 'accountId' | 'organizationId'>,
    patch: PermissionPatch,
    expected: PermissionPatch
  ): Promise<void>;
}
const JournalSchema = z.object({
  version: z.literal(1),
  accountId: z.string(),
  organizationId: z.string(),
  original: z.record(z.string(), z.boolean().nullable()),
  applied: z.record(z.string(), z.boolean().nullable()),
});
type Journal = z.infer<typeof JournalSchema>;
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

/** Recover only our own values. Never overwrite a concurrent account edit. */
export async function recoverCloudConnectorSettings(
  io: CloudConnectorIO,
  journalPath: string
): Promise<boolean> {
  let text: string;
  try {
    text = await readFile(journalPath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
  const journal: Journal = JournalSchema.parse(JSON.parse(text));
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
  if (Object.keys(patch).length) {
    await io.patch(journal, patch, expected);
    await verifyPatch(io, journal, patch);
  }
  if (conflicts.length)
    throw new Error(
      `Connector restore found ${conflicts.length} concurrent edits. Recovery journal retained at ${journalPath}.`
    );
  await verifyPatch(io, journal, journal.original);
  await rm(journalPath);
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
    version: 1,
    accountId: snapshot.accountId,
    organizationId: snapshot.organizationId,
    original,
    applied,
  };
  await mkdir(dirname(journalPath), { recursive: true, mode: 0o700 });
  await writeFile(journalPath, JSON.stringify(journal), {
    flag: 'wx',
    mode: 0o600,
  });
  try {
    if (Object.keys(applied).length)
      await io.patch(snapshot, applied, original);
    await verifyPatch(io, snapshot, plan.patch);
  } catch (error) {
    try {
      await recoverCloudConnectorSettings(io, journalPath);
    } catch (restoreError) {
      throw new AggregateError(
        [error, restoreError],
        `Configuration and rollback failed; inspect ${journalPath}.`
      );
    }
    throw error;
  }
  return {
    plan,
    async verify() {
      await verifyPatch(io, snapshot, plan.patch);
    },
    async restore() {
      await recoverCloudConnectorSettings(io, journalPath);
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
        searchIds.has(block.tool_use_id) &&
        Array.isArray(block.content)
      ) {
        for (const reference of records(block.content)) {
          if (
            reference.type === 'tool_reference' &&
            typeof reference.tool_name === 'string'
          )
            observed.add(reference.tool_name);
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
