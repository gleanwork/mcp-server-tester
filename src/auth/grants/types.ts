/**
 * Connectors and grants: how MST signs in to the MCP servers an eval uses.
 *
 * A connector (a plugin extension, `<namespace>/connector/<name>`) holds what MST needs to
 * know about one vendor's MCP server: its URL, how to sign in, and how a client
 * reaches it. A grant is what signing in leaves behind: a refresh token (or a
 * long-lived token) in a credential store. Connectors with the same `grant`
 * share one sign-in.
 *
 * See docs/design/auth-and-connectors.md.
 */
import type { MCPConfig } from '../../config/mcpConfig.js';

/** A registered OAuth client. `clientSecret` only when the provider requires it. */
export interface OAuthClient {
  clientId: string;
  clientSecret?: string;
}

/** How a connector signs in. */
export type ConnectorAuth =
  | { type: 'none' }
  /** A long-lived token the plugin supplies at call time. */
  | { type: 'static'; token(): Promise<string> }
  /** OAuth client credentials: no user, no consent. */
  | {
      type: 'client-credentials';
      tokenEndpoint: string;
      scopes?: readonly string[];
      client(): Promise<OAuthClient>;
    }
  /** OAuth with a user: browser redirect (authorization code + PKCE) or device code. */
  | {
      type: 'oauth';
      flow?: 'authorization-code' | 'device';
      /** Empty: what the server advertises. */
      scopes?: readonly string[];
      /** When the server does not publish where its authorization server is. */
      issuer?: string;
      /** The registered client. Omit to register one (DCR). */
      client?(): Promise<OAuthClient>;
      /** When the vendor pre-registers the redirect URI `http://localhost:<port>/callback`. */
      redirectPort?: number;
      /**
       * The scope that asks for a refresh token. Default `offline_access`;
       * `null` asks for none (Slack, Google and GitHub return one without it,
       * or don't use one).
       */
      refreshScope?: string | null;
      /** Extra authorization request parameters, e.g. Google's `access_type`. */
      authorizationParams?: Readonly<Record<string, string>>;
    };

/** What a connector's `launch` gets. */
export interface ConnectorLaunchContext {
  /** The server's endpoint: the connector's `url`, or the eval config's override. */
  url: string;
  /** The server's label in the eval config. */
  label: string;
  /**
   * A private file MST keeps current while the run lasts:
   * `{ "version": 1, "accessToken": "..." }`. Absent for `auth: { type: 'none' }`.
   */
  tokenFile?: string;
  platform: NodeJS.Platform;
}

/**
 * A connector: one vendor MCP server as an organization uses it. A plugin
 * provides it under `connectors`; an eval config uses it as
 * `{ "connector": "<namespace>/connector/<name>" }`.
 */
export interface ConnectorDefinition {
  /** Default endpoint (streamable HTTP). An eval config may override it. */
  url: string;
  /** Connectors with the same grant share one sign-in. Default: the connector's name. */
  grant?: string;
  auth: ConnectorAuth;
  /**
   * How the client reaches the server. Default: the client connects to `url`
   * directly with the access token. Return, for example, `dryRunProxyServer()`
   * to block writes.
   */
  launch?(context: ConnectorLaunchContext): MCPConfig | Promise<MCPConfig>;
  /** Fewest tools a working sign-in must expose; catches under-scoped grants. Default 1. */
  minTools?: number;
  /** Shown when signing in fails, and in `mst auth status`. */
  notes?: string;
}

/** A grant as a credential store keeps it. */
export interface StoredGrant {
  version: 1;
  /** `oauth`: refreshable. `token`: a long-lived token with no refresh (GitHub device flow). */
  type: 'oauth' | 'token';
  /** The authorization server's token endpoint. */
  tokenEndpoint?: string;
  revocationEndpoint?: string;
  /** The client the grant belongs to. Never a client secret. */
  clientId?: string;
  refreshToken?: string;
  /** The latest access token, reused until shortly before it expires. */
  accessToken?: string;
  /** ISO 8601; absent when the token does not expire. */
  accessTokenExpiresAt?: string;
  /** Scopes as granted (or requested, when the server doesn't say). */
  scopes: string[];
  /** The server it was signed in for, for `mst auth status`. */
  resource: string;
  /** ISO 8601. */
  signedInAt: string;
}

/** Where grants are kept. */
export interface CredentialStore {
  get(key: string): Promise<StoredGrant | undefined>;
  put(key: string, grant: StoredGrant): Promise<void>;
  delete(key: string): Promise<void>;
  /** Runs `fn` while holding the grant's lock, across processes. */
  withLock<T>(key: string, fn: () => Promise<T>): Promise<T>;
  /** Where the store is, for messages. */
  describe(): string;
}
