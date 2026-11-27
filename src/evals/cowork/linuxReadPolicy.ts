import { mcpServerLabel, type MCPConfig } from '../../config/mcpConfig.js';
import { checkMcpServers, describeNotReady } from '../mcpReadiness.js';
import { coworkReadinessServer } from './readinessServer.js';

/** An owned worker's variant-local policies. Ask keeps other tools visible. */
export type LinuxReadPolicies = ReadonlyMap<
  string,
  Record<string, 'ask' | 'allow'>
>;

/** A launch can treat an annotated read as a write, or dispatch by argument. */
function writeOverrides(server: MCPConfig): Set<string> {
  const names = new Set<string>();
  const args = server.transport === 'stdio' ? (server.args ?? []) : [];
  for (const [i, arg] of args.entries()) {
    const flag = /^(--always-write|--dispatcher)(?:=(.*))?$/.exec(arg);
    if (!flag) continue;
    const value = flag[2] ?? args[i + 1];
    if (value) names.add(value.split('=')[0]!);
  }
  return names;
}

/** List, never call, the tools behind the exact launch Desktop will use. No
 * catalog failure may yield a partial allowlist. The regular batch readiness
 * and upstream write checks are independent of these Desktop permissions. */
export async function linuxReadPolicies(
  servers: readonly MCPConfig[],
  env: Record<string, string | undefined>,
  stdio: Parameters<typeof coworkReadinessServer>[2],
  base: Record<string, unknown>,
  namedHelpers: ReadonlyMap<string, string>,
  toolMetadataProxy = false
): Promise<LinuxReadPolicies> {
  const policies = new Map<string, Record<string, 'ask' | 'allow'>>();
  const selected = servers.map((s, i) => ({
    ...s,
    label: mcpServerLabel(s, i),
  }));
  const labels = new Set<string>();
  const imageEntries = Array.isArray(base.managedMcpServers)
    ? (base.managedMcpServers as Array<Record<string, unknown> | null>)
    : [];
  const toList = selected.filter((s) => {
    const label = s.label.toLowerCase();
    if (labels.has(label))
      throw new Error(
        'Ambiguous managed MCP server name; no read permissions installed.'
      );
    labels.add(label);
    const prior = imageEntries.filter(
      (entry): entry is Record<string, unknown> =>
        typeof entry?.name === 'string' &&
        (entry.name.toLowerCase() === label ||
          (s.transport === 'http' && entry.url === s.serverUrl))
    );
    // Never overwrite an image owner's explicit restrictions with exact grants.
    if (prior.some((entry) => entry.toolPolicy !== undefined))
      throw new Error(
        `Cannot replace the image's existing MCP tool policy for ${s.label}; no read permissions installed.`
      );
    policies.set(s.label, { '*': 'ask' });
    // Only the image knows what identity its own helper supplies. A catalog
    // listed anonymously is not evidence for granting that identity's tools.
    // A metadata variant may rename the underlying tool. Don't infer its
    // write overrides from the alias or touch the model's recording scope.
    return (
      !toolMetadataProxy &&
      !(
        s.transport === 'http' &&
        !namedHelpers.has(s.label) &&
        prior.some((entry) => entry.url === s.serverUrl && entry.headersHelper)
      )
    );
  });
  const catalogs = await checkMcpServers(toList, (s) =>
    coworkReadinessServer(s, env, stdio)
  );
  for (const [i, catalog] of catalogs.entries()) {
    const { label, tools } = catalog;
    if (catalog.status !== 'connected' || catalog.error || !tools?.length)
      throw new Error(
        `Cannot prepare read permissions: ${describeNotReady(catalog)}.`
      );
    const writes = new Set([
      ...(catalog.writeTools ?? []),
      ...writeOverrides(toList[i]!),
    ]);
    const seen = new Set<string>();
    for (const name of tools) {
      // A server-supplied wildcard must never become a permission pattern.
      // Also refuse case collisions rather than depend on Desktop's casing.
      if (
        !name.length ||
        name.length > 128 ||
        /[^A-Za-z0-9._-]/.test(name) ||
        Object.hasOwn(Object.prototype, name) ||
        seen.has(name.toLowerCase())
      )
        throw new Error(
          `Cannot prepare read permissions for ${label}: ambiguous or invalid MCP tool name.`
        );
      seen.add(name.toLowerCase());
    }
    for (const name of [...tools].sort())
      if (!writes.has(name)) policies.get(label)![name] = 'allow';
  }
  return policies;
}
