import { z } from 'zod';

/**
 * OAuth configuration for MCP authentication
 */
export interface MCPOAuthConfig {
  /**
   * OAuth authorization server metadata URL
   * (e.g., https://auth.example.com/.well-known/oauth-authorization-server)
   */
  serverUrl: string;

  /**
   * Scopes to request during authorization
   */
  scopes?: Array<string>;

  /**
   * Resource indicator (RFC 8707, required by MCP 2025-06-18 spec)
   */
  resource?: string;

  /**
   * Path to Playwright auth state file
   * (e.g., playwright/.auth/oauth-state.json)
   */
  authStatePath?: string;

  /**
   * Client ID (if pre-registered; otherwise uses Dynamic Client Registration)
   */
  clientId?: string;

  /**
   * Client secret (for confidential clients)
   */
  clientSecret?: string;

  /**
   * Redirect URI for OAuth callback
   */
  redirectUri?: string;
}

/**
 * OAuth 2.1 client credentials configuration for machine-to-machine (CI/CD) authentication.
 * Credentials can be provided here or via MCP_CLIENT_ID/MCP_CLIENT_SECRET environment variables.
 */
export interface MCPClientCredentialsConfig {
  /**
   * OAuth client ID (falls back to MCP_CLIENT_ID env var)
   */
  clientId?: string;

  /**
   * OAuth client secret (falls back to MCP_CLIENT_SECRET env var)
   */
  clientSecret?: string;

  /**
   * Token endpoint URL (required)
   */
  tokenEndpoint?: string;

  /**
   * Scopes to request
   */
  scopes?: string[];
}

/**
 * Authentication configuration for MCP connections
 */
export interface MCPAuthConfig {
  /**
   * Pre-acquired access token (simplest authentication mode)
   */
  accessToken?: string;

  /**
   * Full OAuth configuration for browser-based authentication
   */
  oauth?: MCPOAuthConfig;

  /**
   * OAuth 2.1 client credentials grant for machine-to-machine authentication
   */
  clientCredentials?: MCPClientCredentialsConfig;
}

/**
 * MCP host capabilities that can be registered with the server
 */
export interface MCPHostCapabilities {
  /**
   * Sampling capabilities (for LLM sampling)
   */
  sampling?: Record<string, unknown>;

  /**
   * Roots capabilities (for file system roots)
   */
  roots?: {
    /**
     * Whether the client can notify the server when roots change
     */
    listChanged: boolean;
  };
}

/**
 * Configuration for MCP client connection via stdio transport (local process)
 */
export interface StdioMCPConfig {
  /**
   * Transport type discriminant
   */
  transport: 'stdio';

  /**
   * Command to execute (required for stdio transport)
   */
  command: string;

  /**
   * Command arguments
   */
  args?: Array<string>;

  /**
   * Working directory for the command
   */
  cwd?: string;

  /**
   * Environment variables to pass to the subprocess.
   * Merged with the current process environment.
   */
  env?: Record<string, string>;

  /**
   * Suppress stderr output from the server process.
   * When true, server stderr is ignored instead of inherited.
   */
  quiet?: boolean;

  /**
   * Host capabilities to register with the server
   */
  capabilities?: MCPHostCapabilities;

  /**
   * Connection timeout in milliseconds
   */
  connectTimeoutMs?: number;

  /**
   * Request timeout in milliseconds
   */
  requestTimeoutMs?: number;

  /**
   * Timeout in milliseconds for MCP tool/list operations. Default: 30000
   */
  callTimeoutMs?: number;
}

/**
 * Configuration for MCP client connection via HTTP transport (remote server)
 */
export interface HttpMCPConfig {
  /**
   * Transport type discriminant
   */
  transport: 'http';

  /**
   * Server URL (required for http transport)
   */
  serverUrl: string;

  /**
   * HTTP headers (e.g., Authorization)
   */
  headers?: Record<string, string>;

  /**
   * Authentication configuration
   */
  auth?: MCPAuthConfig;

  /**
   * Host capabilities to register with the server
   */
  capabilities?: MCPHostCapabilities;

  /**
   * Connection timeout in milliseconds
   */
  connectTimeoutMs?: number;

  /**
   * Request timeout in milliseconds
   */
  requestTimeoutMs?: number;

  /**
   * Timeout in milliseconds for MCP tool/list operations. Default: 30000
   */
  callTimeoutMs?: number;

  /**
   * HTTP proxy configuration. Falls back to HTTPS_PROXY/HTTP_PROXY environment variables.
   */
  proxy?: {
    /**
     * Proxy URL. Credentials can be embedded directly if required:
     * `http://user:pass@proxy.example.com:8080`
     */
    url: string;
  };

  /**
   * Number of retry attempts for transient connection failures and 429 rate limit responses.
   * Uses exponential backoff with Retry-After header awareness. Defaults to 0 (no retries).
   */
  retryAttempts?: number;

  /**
   * TLS/mTLS configuration for custom certificates or disabling cert validation.
   * File paths should point to PEM-encoded certificate files.
   */
  tls?: {
    /**
     * Path to CA certificate PEM file (for custom/self-signed CAs)
     */
    ca?: string;

    /**
     * Path to client certificate PEM file (for mutual TLS)
     */
    cert?: string;

    /**
     * Path to client private key PEM file (for mutual TLS)
     */
    key?: string;

    /**
     * Whether to reject unauthorized certificates. Defaults to true.
     * Set to false to disable certificate validation (not recommended for production).
     */
    rejectUnauthorized?: boolean;
  };
}

/**
 * Configuration for MCP client connection.
 *
 * This is a discriminated union — narrow with `isStdioConfig()` or `isHttpConfig()`
 * before accessing transport-specific fields.
 *
 * Supports both stdio (local) and HTTP (remote) transports.
 */
export type MCPConfig = StdioMCPConfig | HttpMCPConfig;

/**
 * Zod schema for MCPHostCapabilities
 */
const MCPHostCapabilitiesSchema = z.object({
  sampling: z.record(z.unknown()).optional(),
  roots: z
    .object({
      listChanged: z.boolean(),
    })
    .optional(),
});

/**
 * Zod schema for MCPOAuthConfig
 */
const MCPOAuthConfigSchema = z.object({
  serverUrl: z.string().url('serverUrl must be a valid URL'),
  scopes: z.array(z.string()).optional(),
  resource: z.string().url().optional(),
  authStatePath: z.string().optional(),
  clientId: z.string().optional(),
  clientSecret: z.string().optional(),
  redirectUri: z.string().url().optional(),
});

/**
 * Zod schema for MCPClientCredentialsConfig
 */
const MCPClientCredentialsConfigSchema = z.object({
  clientId: z.string().optional(),
  clientSecret: z.string().optional(),
  tokenEndpoint: z.string().url('tokenEndpoint must be a valid URL').optional(),
  scopes: z.array(z.string()).optional(),
});

/**
 * Zod schema for MCPAuthConfig
 */
const MCPAuthConfigSchema = z
  .object({
    accessToken: z.string().optional(),
    oauth: MCPOAuthConfigSchema.optional(),
    clientCredentials: MCPClientCredentialsConfigSchema.optional(),
  })
  .refine(
    (data) => !(data.accessToken && data.oauth),
    'Cannot specify both accessToken and oauth configuration'
  );

/**
 * Zod schema for stdio transport config
 */
const StdioConfigSchema = z.object({
  transport: z.literal('stdio'),
  command: z.string().min(1, 'command is required for stdio transport'),
  args: z.array(z.string()).optional(),
  cwd: z.string().optional(),
  env: z.record(z.string(), z.string()).optional(),
  capabilities: MCPHostCapabilitiesSchema.optional(),
  connectTimeoutMs: z.number().positive().optional(),
  requestTimeoutMs: z.number().positive().optional(),
  callTimeoutMs: z.number().positive().optional(),
  quiet: z.boolean().optional(),
});

/**
 * Returns true if the hostname refers to the loopback interface
 */
function isLocalhost(hostname: string): boolean {
  return (
    hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1'
  );
}

/**
 * Zod schema for HTTP transport config
 */
const HttpConfigSchema = z.object({
  transport: z.literal('http'),
  serverUrl: z
    .string()
    .url('serverUrl must be a valid URL')
    .refine((url) => {
      let parsed: URL;
      try {
        parsed = new URL(url);
      } catch {
        return true;
      }
      if (parsed.protocol === 'http:' && !isLocalhost(parsed.hostname)) {
        console.warn(
          `[mcp-server-tester] serverUrl uses http:// for non-localhost address "${parsed.hostname}". ` +
            `This transmits tokens unencrypted. Use https:// for remote servers.`
        );
      }
      return true;
    }),
  headers: z.record(z.string()).optional(),
  capabilities: MCPHostCapabilitiesSchema.optional(),
  connectTimeoutMs: z.number().positive().optional(),
  requestTimeoutMs: z.number().positive().optional(),
  callTimeoutMs: z.number().positive().optional(),
  auth: MCPAuthConfigSchema.optional(),
  proxy: z
    .object({
      url: z.string().url('proxy.url must be a valid URL'),
    })
    .optional(),
  retryAttempts: z.number().int().min(0).optional(),
  tls: z
    .object({
      ca: z.string().optional(),
      cert: z.string().optional(),
      key: z.string().optional(),
      rejectUnauthorized: z.boolean().optional(),
    })
    .optional(),
});

/**
 * Union schema for MCPConfig (validates based on transport type)
 */
export const MCPConfigSchema = z.discriminatedUnion('transport', [
  StdioConfigSchema,
  HttpConfigSchema,
]);

/**
 * Validates an MCPConfig object
 *
 * @param config - The config to validate
 * @returns The validated config
 * @throws {z.ZodError} If validation fails
 */
export function validateMCPConfig(config: unknown): MCPConfig {
  return MCPConfigSchema.parse(config);
}

/**
 * Type guard to check if a config is for stdio transport
 */
export function isStdioConfig(config: MCPConfig): config is StdioMCPConfig {
  return config.transport === 'stdio';
}

/**
 * Type guard to check if a config is for HTTP transport
 */
export function isHttpConfig(config: MCPConfig): config is HttpMCPConfig {
  return config.transport === 'http';
}
