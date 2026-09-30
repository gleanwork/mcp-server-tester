/**
 * What MST knows about a client it created: the requested protocol, where it
 * connected, its wire record and the dispatcher it owns. One record per SDK
 * `Client`, set in `createMCPClientForConfig` and read everywhere else, in
 * place of a side table per fact.
 *
 * A client created outside MST has no record; readers treat every field as
 * unknown (for example, conformance probes skip).
 */
import type { Client, OAuthClientProvider } from '@modelcontextprotocol/client';
import type { ProtocolSetting } from '../types/index.js';
import type { WireTap } from './wireTap.js';

/**
 * Where a client connected, so conformance probes can send raw requests to
 * the same server over a separate connection (bypassing the SDK client).
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

/** Something the connection owns and must close with it. */
export interface Closable {
  close(): Promise<void>;
}

export interface MCPConnection {
  /** The protocol setting the client was created with. */
  readonly requestedProtocol: ProtocolSetting;
  /** Set once connected. */
  target?: ConnectionTarget;
  /** Set once connected; frames exchanged during the handshake aren't recorded. */
  wire?: WireTap;
  /** An undici agent (TLS or proxy) the connection opened, closed with it. */
  dispatcher?: Closable;
}

const connections = new WeakMap<Client, MCPConnection>();

/** Starts the record for a client MST is creating. */
export function beginConnection(
  client: Client,
  requestedProtocol: ProtocolSetting
): MCPConnection {
  const connection: MCPConnection = { requestedProtocol };
  connections.set(client, connection);
  return connection;
}

/** The record for a client MST created, if any. */
export function connectionOf(client: Client): MCPConnection | undefined {
  return connections.get(client);
}

/** Closes and forgets what the connection owns, after the client closed. */
export async function releaseConnection(
  client: Client,
  onError: (error: unknown) => void
): Promise<void> {
  const connection = connections.get(client);
  const dispatcher = connection?.dispatcher;
  if (!connection || !dispatcher) return;
  delete connection.dispatcher;
  try {
    await dispatcher.close();
  } catch (error) {
    onError(error);
  }
}
