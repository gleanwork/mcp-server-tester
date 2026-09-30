import type { Client, OAuthClientProvider } from '@modelcontextprotocol/client';

/**
 * Where a client connected, recorded so conformance probes can send raw
 * requests to the same server (bypassing the SDK client).
 */
export type ConnectionTarget =
  | {
      transport: 'http';
      url: string;
      /** Headers MST sent, including a static bearer token if configured. */
      headers: Record<string, string>;
      /** undici dispatcher for proxy/TLS settings, if configured. */
      dispatcher?: unknown;
      authProvider?: OAuthClientProvider;
    }
  | {
      transport: 'stdio';
      command: string;
      args: string[];
      cwd?: string;
      env?: Record<string, string>;
    };

const targets = new WeakMap<Client, ConnectionTarget>();

export function setConnectionTarget(
  client: Client,
  target: ConnectionTarget
): void {
  targets.set(client, target);
}

/** Returns the recorded target for a client created by MST, if any. */
export function getConnectionTarget(
  client: Client
): ConnectionTarget | undefined {
  return targets.get(client);
}
