/**
 * OAuth Protected Resource and Authorization Server discovery
 *
 * Implements RFC 9728 (OAuth Protected Resource Metadata) and
 * RFC 8414 (Authorization Server Metadata) for MCP servers.
 */

import * as oauth from 'oauth4webapi';
import type { AuthServerMetadata } from './oauthFlow.js';

/**
 * Returns true if the hostname refers to the loopback interface
 */
function isLocalhostUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    const h = parsed.hostname;
    return h === 'localhost' || h === '127.0.0.1' || h === '::1';
  } catch {
    return false;
  }
}

/**
 * Validates that critical OAuth endpoints returned by discovery use HTTPS.
 * Localhost URLs are exempt to support local development and testing.
 *
 * @throws Error if any endpoint uses a non-HTTPS, non-localhost scheme
 */
function validateAuthServerEndpoints(authServer: {
  authorization_endpoint?: string;
  token_endpoint?: string;
  issuer?: string;
}): void {
  const endpoints = [
    { name: 'authorization_endpoint', url: authServer.authorization_endpoint },
    { name: 'token_endpoint', url: authServer.token_endpoint },
  ];

  for (const { name, url } of endpoints) {
    if (url && !url.startsWith('https://') && !isLocalhostUrl(url)) {
      throw new Error(
        `OAuth discovery returned an insecure ${name}: "${url}". ` +
          `Only HTTPS endpoints are permitted for OAuth flows to prevent token interception.`
      );
    }
  }
}

/**
 * MCP Protocol version header value
 */
export const MCP_PROTOCOL_VERSION = '2025-06-18';

/**
 * Protected Resource Metadata (RFC 9728)
 */
export interface ProtectedResourceMetadata {
  /**
   * The protected resource URL
   */
  resource: string;

  /**
   * Array of authorization server URLs
   */
  authorization_servers?: Array<string>;

  /**
   * Scopes supported by the protected resource
   */
  scopes_supported?: Array<string>;

  /**
   * Bearer token formats supported
   */
  bearer_methods_supported?: Array<string>;

  /**
   * Resource documentation URL
   */
  resource_documentation?: string;

  /**
   * Resource signing algorithms
   */
  resource_signing_alg_values_supported?: Array<string>;
}

/**
 * Result of protected resource discovery
 */
export interface ProtectedResourceDiscoveryResult {
  /**
   * The discovered metadata
   */
  metadata: ProtectedResourceMetadata;

  /**
   * The URL where metadata was found
   */
  discoveryUrl: string;

  /**
   * Whether path-aware discovery was used (vs base discovery)
   */
  usedPathAwareDiscovery: boolean;
}

/**
 * Discovers protected resource metadata per RFC 9728
 *
 * Follows RFC 9728 Section 4.1 for path-aware discovery:
 * 1. First tries: {origin}/.well-known/oauth-protected-resource{pathname}
 * 2. Falls back to: {origin}/.well-known/oauth-protected-resource
 *
 * @param mcpServerUrl - The MCP server URL
 * @returns Protected resource discovery result
 * @throws Error if discovery fails completely
 *
 * @example
 * const result = await discoverProtectedResource('https://api.example.com/mcp/default');
 * console.log(result.metadata.authorization_servers);
 */
export async function discoverProtectedResource(
  mcpServerUrl: string
): Promise<ProtectedResourceDiscoveryResult> {
  const url = new URL(mcpServerUrl);
  const origin = url.origin;
  const pathname = url.pathname;

  // Try path-aware discovery first (RFC 9728 Section 4.1)
  const pathAwareUrl = `${origin}/.well-known/oauth-protected-resource${pathname}`;

  try {
    const metadata = await fetchProtectedResourceMetadata(pathAwareUrl);
    return {
      metadata,
      discoveryUrl: pathAwareUrl,
      usedPathAwareDiscovery: true,
    };
  } catch (error) {
    // If path-aware fails with 404, try base discovery
    if (error instanceof DiscoveryError && error.status === 404) {
      const baseUrl = `${origin}/.well-known/oauth-protected-resource`;

      // This will throw if base discovery also fails
      const metadata = await fetchProtectedResourceMetadata(baseUrl);
      return {
        metadata,
        discoveryUrl: baseUrl,
        usedPathAwareDiscovery: false,
      };
    }

    // Non-404 error from path-aware discovery
    throw error;
  }
}

/**
 * Error thrown when discovery fails
 */
export class DiscoveryError extends Error {
  constructor(
    message: string,
    public readonly status?: number,
    public readonly url?: string
  ) {
    super(message);
    this.name = 'DiscoveryError';
  }
}

/**
 * Fetches protected resource metadata from a discovery URL
 */
async function fetchProtectedResourceMetadata(
  discoveryUrl: string
): Promise<ProtectedResourceMetadata> {
  const response = await fetch(discoveryUrl, {
    method: 'GET',
    headers: {
      Accept: 'application/json',
      'MCP-Protocol-Version': MCP_PROTOCOL_VERSION,
    },
  });

  if (!response.ok) {
    throw new DiscoveryError(
      `Protected resource discovery failed: ${response.status} ${response.statusText}`,
      response.status,
      discoveryUrl
    );
  }

  const metadata = (await response.json()) as ProtectedResourceMetadata;

  // Validate required field
  if (!metadata.resource) {
    throw new DiscoveryError(
      'Invalid protected resource metadata: missing required "resource" field',
      undefined,
      discoveryUrl
    );
  }

  return metadata;
}

/**
 * Discovers OAuth Authorization Server metadata per RFC 8414
 *
 * Wraps oauth4webapi's discovery with MCP-specific headers.
 *
 * @param authServerUrl - The authorization server URL
 * @returns Authorization server metadata
 * @throws Error if discovery fails
 *
 * @example
 * const authServer = await discoverAuthorizationServer('https://auth.example.com');
 * console.log(authServer.server.token_endpoint);
 */
export async function discoverAuthorizationServer(
  authServerUrl: string
): Promise<AuthServerMetadata> {
  const issuer = new URL(authServerUrl);

  // Use oauth4webapi for discovery with custom headers
  const response = await oauth.discoveryRequest(issuer, {
    algorithm: 'oauth2',
    headers: new Headers({
      'MCP-Protocol-Version': MCP_PROTOCOL_VERSION,
    }),
  });

  const metadata = await oauth.processDiscoveryResponse(issuer, response);

  validateAuthServerEndpoints(metadata);

  return {
    server: metadata,
    issuer: authServerUrl,
  };
}
