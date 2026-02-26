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
 * Zod schema for MCPAuthConfig
 */
const MCPAuthConfigSchema = z
  .object({
    accessToken: z.string().optional(),
    oauth: MCPOAuthConfigSchema.optional(),
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
  capabilities: MCPHostCapabilitiesSchema.optional(),
  connectTimeoutMs: z.number().positive().optional(),
  requestTimeoutMs: z.number().positive().optional(),
  quiet: z.boolean().optional(),
});

/**
 * Zod schema for HTTP transport config
 */
const HttpConfigSchema = z.object({
  transport: z.literal('http'),
  serverUrl: z.string().url('serverUrl must be a valid URL'),
  headers: z.record(z.string()).optional(),
  capabilities: MCPHostCapabilitiesSchema.optional(),
  connectTimeoutMs: z.number().positive().optional(),
  requestTimeoutMs: z.number().positive().optional(),
  auth: MCPAuthConfigSchema.optional(),
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
