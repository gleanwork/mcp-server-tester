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
  error?: string;
  info?: MCPProtocolInfo;
  capabilities?: ServerCapabilities | null;
  tools?: Tool[];
  resources?: Resource[] | null;
  prompts?: Prompt[] | null;
}

/** Result of {@link runCrossEraChecks}. */
export interface MCPCrossEraResult {
  /** Whether every 'must' check passed. */
  pass: boolean;
  checks: MCPConformanceCheck[];
  connections: CrossEraConnection[];
}

const SPEC_VERSIONING =
  'https://modelcontextprotocol.io/specification/2026-07-28/basic/versioning#backward-compatibility-with-initialization-based-versions';

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

function stable(value: unknown): string {
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

function names(
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
  let client: Client | undefined;
  try {
    client = await createMCPClientForConfig(config, {
      ...clientOptions,
      protocol,
    });
    const capabilities = client.getServerCapabilities() ?? null;
    const tools = (await client.listTools()).tools;
    const resources = capabilities?.resources
      ? (await client.listResources()).resources
      : null;
    const prompts = capabilities?.prompts
      ? (await client.listPrompts()).prompts
      : null;
    return {
      protocol,
      connected: true,
      info: getProtocolInfo(client),
      capabilities,
      tools,
      resources,
      prompts,
    };
  } catch (error) {
    return {
      protocol,
      connected: false,
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    if (client) await closeMCPClient(client).catch(() => undefined);
  }
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
    ({ list }) => stable(list) !== stable(first!.list)
  );
  return {
    name,
    severity: 'must',
    specRef: SPEC_VERSIONING,
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
  const connected = connections.filter((c) => c.connected);
  const checks: MCPConformanceCheck[] = [];

  const failed = connections.filter((c) => !c.connected);
  checks.push({
    name: 'cross_era_connect',
    severity: 'must',
    specRef: SPEC_VERSIONING,
    pass: failed.length === 0,
    message:
      failed.length === 0
        ? `Connected with ${connections.map((c) => `${c.protocol} → ${c.info?.negotiated}`).join(', ')}`
        : failed.map((c) => `${c.protocol}: ${c.error}`).join('; '),
  });

  if (connected.length >= 2) {
    const toolNames = compareLists(
      'cross_era_tools_match',
      'tools',
      connected,
      (c) => names(c.tools ?? [])
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
          stable(toolShape(baseline)) !== stable(toolShape(tool))
        ) {
          schemaDiffs.push(`${tool.name} (${other.protocol})`);
        }
      }
    }
    checks.push({
      name: 'cross_era_tool_definitions_match',
      severity: 'must',
      specRef: SPEC_VERSIONING,
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
      (c) => (c.resources ? names(c.resources) : null)
    );
    if (resources) checks.push(resources);

    const prompts = compareLists(
      'cross_era_prompts_match',
      'prompts',
      connected,
      (c) => (c.prompts ? names(c.prompts) : null)
    );
    if (prompts) checks.push(prompts);

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
      specRef: SPEC_VERSIONING,
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
