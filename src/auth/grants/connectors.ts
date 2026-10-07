/**
 * Connector lookup and grant grouping: which grants an eval config's servers
 * need, and which servers share each one.
 */
import { extensionLookup } from '../../plugins/extensions.js';
import { parseExtensionReference } from '../../plugins/plugin.js';
import type { GrantTarget } from './grants.js';
import type { ConnectorDefinition } from './types.js';

const connectors = extensionLookup('connectors', () => ({}));

/** The connector `reference` (`<namespace>/connector/<name>`) names, from a loaded plugin. */
export function getConnector(reference: string): ConnectorDefinition {
  if (!reference.includes('/'))
    throw new Error(
      `Connector "${reference}" must be namespaced: "<plugin namespace>/connector/${reference}".`
    );
  return connectors.get(reference);
}

/** One server that uses a connector. */
export interface ConnectorUse {
  /** The server's label in the eval config. */
  label: string;
  /** `<namespace>/connector/<name>`. */
  reference: string;
  connector: ConnectorDefinition;
  /** The endpoint: the eval config's `url`, else the connector's. */
  url: string;
}

/** The store key and display name of a connector's grant. */
export function grantIdentity(
  use: Pick<ConnectorUse, 'reference' | 'connector'>
): {
  key: string;
  name: string;
} {
  const { namespace, name } = parseExtensionReference(use.reference);
  const grant = use.connector.grant ?? name;
  const scope = (namespace ?? 'mst').replace(/^@/, '').replace(/\//g, '.');
  return { key: `${scope}.${grant}`, name: `${namespace}/${grant}` };
}

/** Group servers by grant. Connectors that share a grant get one sign-in with all their scopes. */
export function grantTargets(
  uses: readonly ConnectorUse[]
): Array<GrantTarget & { servers: ConnectorUse[] }> {
  const groups = new Map<string, GrantTarget & { servers: ConnectorUse[] }>();
  for (const use of uses) {
    const identity = grantIdentity(use);
    const existing = groups.get(identity.key);
    if (!existing) {
      groups.set(identity.key, {
        ...identity,
        auth: use.connector.auth,
        urls: [use.url],
        servers: [use],
      });
      continue;
    }
    existing.servers.push(use);
    if (!existing.urls.includes(use.url))
      existing.urls = [...existing.urls, use.url];
    const a = existing.auth;
    const b = use.connector.auth;
    if (a.type !== b.type)
      throw new Error(
        `${identity.name}: connectors that share a grant must use the same auth type.`
      );
    if (a.type === 'oauth' && b.type === 'oauth') {
      const scopes = [...new Set([...(a.scopes ?? []), ...(b.scopes ?? [])])];
      existing.auth = { ...a, scopes };
    }
  }
  return [...groups.values()];
}
