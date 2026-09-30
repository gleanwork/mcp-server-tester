import type { TestInfo } from '@playwright/test';
import type {
  Client,
  Prompt,
  Resource,
  ServerCapabilities,
  Tool,
} from '@modelcontextprotocol/client';
import type { MCPConfig } from '../config/mcpConfig.js';
import {
  closeMCPClient,
  createMCPClientForConfig,
  type CreateMCPClientOptions,
} from '../mcp/clientFactory.js';
import {
  FIRST_MODERN_PROTOCOL_VERSION,
  getProtocolInfo,
} from '../mcp/protocol.js';
import type { MCPProtocolInfo, ProtocolSetting } from '../types/index.js';
import type { MCPConformanceCheck } from '../types/reporter.js';
import { conformancePasses } from './registry.js';
import { errorMessage } from '../utils/errorMessage.js';
import { getSkillsExtension, listSkills } from '../skills/skillsClient.js';
import type { SkillEntry } from '../skills/skillsTypes.js';

/** Options for {@link runCrossEraChecks}. */
export interface CrossEraOptions {
  /**
   * Protocols to compare. Default: `['legacy', '2026-07-28']`.
   */
  protocols?: readonly ProtocolSetting[];
  /**
   * Also connect with `protocol: 'auto'` and check that it lands on the
   * modern era when any modern protocol connected.
   * @default true
   */
  checkAuto?: boolean;
  /** Passed to every `createMCPClientForConfig()` call (e.g. authProvider). */
  clientOptions?: Omit<CreateMCPClientOptions, 'protocol'>;
}

/** What one connection in a cross-era run saw. */
export interface CrossEraConnection {
  protocol: ProtocolSetting;
  connected: boolean;
  /** Why the connection failed (when `connected` is false). */
  error?: string;
  /** Why listing tools, resources, or prompts failed after connecting. */
  listError?: string;
  info?: MCPProtocolInfo;
  capabilities?: ServerCapabilities | null;
  tools?: Tool[];
  resources?: Resource[] | null;
  prompts?: Prompt[] | null;
  /** skills/list entries, when the server declares the skills extension. */
  skills?: SkillEntry[] | null;
}

/** Result of {@link runCrossEraChecks}. */
export interface MCPCrossEraResult {
  /** Whether every 'must' check passed. */
  pass: boolean;
  checks: MCPConformanceCheck[];
  connections: CrossEraConnection[];
}

// The spec allows modern-only servers and defines no rule that eras serve
// the same surface, so these are MST parity checks without a specRef.

/** The parts of a tool that must not differ between eras. */
function toolShape(tool: Tool): unknown {
  return {
    name: tool.name,
    title: tool.title,
    description: tool.description,
    inputSchema: tool.inputSchema,
    outputSchema: tool.outputSchema,
    annotations: tool.annotations,
  };
}

function stableStringify(value: unknown): string {
  return JSON.stringify(value, (_key, inner: unknown) =>
    inner && typeof inner === 'object' && !Array.isArray(inner)
      ? Object.fromEntries(
          Object.entries(inner as Record<string, unknown>).sort(([a], [b]) =>
            a.localeCompare(b)
          )
        )
      : inner
  );
}

function identifiers(
  items: ReadonlyArray<{ name?: string; uri?: string }>
): string[] {
  return items.map((item) => item.uri ?? item.name ?? '').sort();
}

/** Capability keys, ignoring flags that legitimately differ by era. */
function capabilityKeys(capabilities: ServerCapabilities | null | undefined) {
  const keys = Object.keys(capabilities ?? {}).filter(
    (key) => key !== 'extensions' && key !== 'experimental'
  );
  const extensions = Object.keys(
    (capabilities as { extensions?: Record<string, unknown> } | null)
      ?.extensions ?? {}
  ).map((id) => `extensions.${id}`);
  return [...keys, ...extensions].sort();
}

async function connect(
  config: MCPConfig,
  protocol: ProtocolSetting,
  clientOptions: CrossEraOptions['clientOptions']
): Promise<CrossEraConnection> {
  let client: Client;
  try {
    client = await createMCPClientForConfig(config, {
      ...clientOptions,
      protocol,
    });
  } catch (error) {
    return { protocol, connected: false, error: errorMessage(error) };
  }
  const capabilities = client.getServerCapabilities() ?? null;
  const connection: CrossEraConnection = {
    protocol,
    connected: true,
    info: getProtocolInfo(client),
    capabilities,
  };
  try {
    connection.tools = (await client.listTools()).tools;
    connection.resources = capabilities?.resources
      ? (await client.listResources()).resources
      : null;
    connection.prompts = capabilities?.prompts
      ? (await client.listPrompts()).prompts
      : null;
    connection.skills = getSkillsExtension(client)
      ? await listSkills(client)
      : null;
  } catch (error) {
    connection.listError = errorMessage(error);
  } finally {
    await closeMCPClient(client).catch(() => undefined);
  }
  return connection;
}

function compareLists(
  name: string,
  label: string,
  connections: CrossEraConnection[],
  pick: (connection: CrossEraConnection) => string[] | null
): MCPConformanceCheck | null {
  const lists = connections.map((c) => ({ c, list: pick(c) }));
  if (lists.every(({ list }) => list === null)) return null;
  const [first, ...rest] = lists;
  const differing = rest.filter(
    ({ list }) => stableStringify(list) !== stableStringify(first!.list)
  );
  return {
    name,
    severity: 'must',
    pass: differing.length === 0,
    message:
      differing.length === 0
        ? `Same ${label} in every era (${first!.list?.length ?? 0})`
        : differing
            .map(
              ({ c, list }) =>
                `${c.protocol}: ${JSON.stringify(list)} vs ${first!.c.protocol}: ${JSON.stringify(first!.list)}`
            )
            .join('; '),
  };
}

/**
 * Connects to the same server once per protocol and checks that it exposes
 * the same surface in every era: dual-era servers must serve legacy clients
 * and 2026-07-28 clients the same tools, resources, and prompts.
 *
 * @example
 * ```ts
 * test('serves legacy and 2026-07-28 identically', async ({}, testInfo) => {
 *   const result = await runCrossEraChecks(mcpConfig, {}, testInfo);
 *   expect(result.pass).toBe(true);
 * });
 * ```
 */
export async function runCrossEraChecks(
  config: MCPConfig,
  options: CrossEraOptions = {},
  testInfo?: TestInfo
): Promise<MCPCrossEraResult> {
  const protocols = options.protocols ?? [
    'legacy',
    FIRST_MODERN_PROTOCOL_VERSION,
  ];
  if (protocols.length < 2) {
    throw new Error('runCrossEraChecks() needs at least two protocols.');
  }

  const connections: CrossEraConnection[] = [];
  for (const protocol of protocols) {
    connections.push(await connect(config, protocol, options.clientOptions));
  }
  const checks: MCPConformanceCheck[] = [];

  const failed = connections.filter((c) => !c.connected);
  checks.push({
    name: 'cross_era_connect',
    severity: 'must',
    pass: failed.length === 0,
    message:
      failed.length === 0
        ? `Connected with ${connections.map((c) => `${c.protocol} → ${c.info?.negotiated}`).join(', ')}`
        : failed.map((c) => `${c.protocol}: ${c.error}`).join('; '),
  });

  const listFailed = connections.filter((c) => c.listError !== undefined);
  if (listFailed.length > 0) {
    checks.push({
      name: 'cross_era_listing_succeeds',
      severity: 'must',
      pass: false,
      message: listFailed
        .map((c) => `${c.protocol}: ${c.listError}`)
        .join('; '),
    });
  }
  // Only connections that listed successfully can be compared.
  const connected = connections.filter(
    (c) => c.connected && c.listError === undefined
  );

  if (connected.length >= 2) {
    const toolNames = compareLists(
      'cross_era_tools_match',
      'tools',
      connected,
      (c) => identifiers(c.tools ?? [])
    );
    if (toolNames) checks.push(toolNames);

    const firstTools = new Map(
      (connected[0]!.tools ?? []).map((tool) => [tool.name, tool])
    );
    const schemaDiffs: string[] = [];
    for (const other of connected.slice(1)) {
      for (const tool of other.tools ?? []) {
        const baseline = firstTools.get(tool.name);
        if (
          baseline &&
          stableStringify(toolShape(baseline)) !==
            stableStringify(toolShape(tool))
        ) {
          schemaDiffs.push(`${tool.name} (${other.protocol})`);
        }
      }
    }
    checks.push({
      name: 'cross_era_tool_definitions_match',
      severity: 'must',
      pass: schemaDiffs.length === 0,
      message:
        schemaDiffs.length === 0
          ? 'Tool titles, descriptions, schemas, and annotations match across eras'
          : `Tool definitions differ from ${connected[0]!.protocol}: ${schemaDiffs.join(', ')}`,
    });

    const resources = compareLists(
      'cross_era_resources_match',
      'resources',
      connected,
      (c) => (c.resources ? identifiers(c.resources) : null)
    );
    if (resources) checks.push(resources);

    const prompts = compareLists(
      'cross_era_prompts_match',
      'prompts',
      connected,
      (c) => (c.prompts ? identifiers(c.prompts) : null)
    );
    if (prompts) checks.push(prompts);

    // Skill entries (frontmatter + digests) must be the same in every era.
    const skills = compareLists(
      'cross_era_skills_match',
      'skills',
      connected,
      (c) =>
        c.skills ? c.skills.map((entry) => stableStringify(entry)).sort() : null
    );
    if (skills) checks.push(skills);

    const capabilities = compareLists(
      'cross_era_capabilities_match',
      'capabilities',
      connected,
      (c) => capabilityKeys(c.capabilities)
    );
    if (capabilities) checks.push({ ...capabilities, severity: 'should' });
  }

  const modernConnected = connected.some((c) => c.info?.era === 'modern');
  if ((options.checkAuto ?? true) && modernConnected) {
    const auto = await connect(config, 'auto', options.clientOptions);
    checks.push({
      name: 'auto_selects_modern',
      severity: 'should',
      pass: auto.connected && auto.info?.era === 'modern',
      message: auto.connected
        ? `protocol 'auto' negotiated ${auto.info?.negotiated} (${auto.info?.era})`
        : `protocol 'auto' failed: ${auto.error}`,
    });
  }

  const pass = conformancePasses(checks);
  const result: MCPCrossEraResult = { pass, checks, connections };

  if (testInfo) {
    await testInfo.attach('mcp-conformance-checks', {
      contentType: 'application/json',
      body: JSON.stringify(
        {
          operation: 'crossEraChecks',
          pass,
          checks,
          scope: `Cross-era: ${protocols.join(' ↔ ')}`,
          toolCount: connected[0]?.tools?.length ?? 0,
          connections: connections.map(
            ({ protocol, connected, error, info }) => ({
              protocol,
              connected,
              error,
              info,
            })
          ),
        },
        null,
        2
      ),
    });
  }

  return result;
}
