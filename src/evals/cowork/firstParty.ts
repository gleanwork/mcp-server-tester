import { mcpServerLabel, type MCPConfig } from '../../config/mcpConfig.js';
import {
  CloudConnectorsSchema,
  planCloudConnectors,
  type CloudConnectorConfig,
  type CloudConnectorSnapshot,
} from './claudeAiConnectors.js';

/** This mode selects account-owned endpoints; it never launches a transport. */
export function isFirstPartyCowork(config: {
  type?: string;
  mode?: unknown;
}): boolean {
  return (
    (config.type === 'cowork' || config.type === 'mst/client/cowork') &&
    config.mode === 'first-party'
  );
}
function endpoint(value: string): string {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || url.hash)
    throw new Error(
      'First-party serverUrl must be HTTPS without embedded credentials or a fragment.'
    );
  return url.href;
}
export function assertFirstPartyServers(
  servers: readonly MCPConfig[],
  input?: CloudConnectorConfig
): void {
  const labels = new Set<string>();
  for (const [index, server] of servers.entries()) {
    const label = mcpServerLabel(server, index);
    if (labels.has(label))
      throw new Error(`Duplicate first-party server label ${label}.`);
    labels.add(label);
    if (server.transport !== 'http')
      throw new Error(
        `First-party server ${label} must be an existing account HTTP connector; stdio is unsupported.`
      );
    const unsupported = Object.keys(server).filter(
      (key) =>
        !['transport', 'label', 'serverUrl'].includes(key) &&
        server[key as keyof typeof server] !== undefined
    );
    if (unsupported.length)
      throw new Error(
        `First-party server ${label} cannot apply ${unsupported.join(', ')}; authentication and transport settings belong to the Claude account.`
      );
    endpoint(server.serverUrl);
  }
  const config = CloudConnectorsSchema.parse(input ?? {});
  if (config.default !== 'block')
    throw new Error(
      'First-party mode requires connectors.default: block so unselected servers stay excluded.'
    );
  for (const [label, policy] of Object.entries(config.servers)) {
    if (!labels.has(label))
      throw new Error(
        `Connector policy ${label} names no selected server label. Put policies on the variant that selects that server.`
      );
    if (
      policy.policy === 'inherit' ||
      Object.values(policy.tools).includes('inherit')
    )
      throw new Error(
        'First-party server selection requires explicit policies; inherit is unsupported.'
      );
  }
}

/** Match only existing connected endpoints. Neither create connectors nor copy credentials. */
export function bindFirstPartyServers(
  snapshot: CloudConnectorSnapshot,
  servers: readonly MCPConfig[],
  input?: CloudConnectorConfig,
  writes: Readonly<Record<string, 'unguarded' | 'live'>> = {}
) {
  assertFirstPartyServers(servers, input);
  const requested = CloudConnectorsSchema.parse(input ?? {});
  const configured: zServerPolicies = {};
  const labels: Record<string, string> = {};
  for (const [index, server] of servers.entries()) {
    if (server.transport !== 'http')
      throw new Error('First-party mode requires HTTP servers.');
    const label = mcpServerLabel(server, index);
    const url = endpoint(server.serverUrl);
    const matches = snapshot.servers.filter((candidate) => {
      if (candidate.connectionState !== 'connected' || !candidate.url)
        return false;
      try {
        return endpoint(candidate.url) === url;
      } catch {
        return false;
      }
    });
    if (matches.length !== 1)
      throw new Error(
        `First-party server ${label} must match exactly one connected account connector by URL (found ${matches.length}). Complete its sign-in or remove the ambiguity first.`
      );
    const account = matches[0]!;
    if (configured[account.id])
      throw new Error(
        `Two selected server labels resolve to the same account connector (${label}).`
      );
    configured[account.id] = requested.servers[label] ?? {
      policy: 'read-only',
      tools: {},
    };
    labels[account.nativeName] = label;
  }
  const config: CloudConnectorConfig = {
    default: 'block',
    failOnApproval: requested.failOnApproval,
    servers: configured,
  };
  const plan = planCloudConnectors(snapshot, config);
  for (const account of snapshot.servers) {
    const label = labels[account.nativeName];
    if (!label || writes[label]) continue;
    const writable = account.tools.filter(
      (tool) => plan.patch[tool.enabledKey] === true && tool.readOnly !== true
    );
    if (writable.length)
      throw new Error(
        `First-party server ${label} permits write or unknown tools. Declare writes.${label}: unguarded (or live with --allow-live-writes); account permissions are not a dry-run proxy.`
      );
  }
  return { config, labels };
}
type zServerPolicies = NonNullable<CloudConnectorConfig['servers']>;
