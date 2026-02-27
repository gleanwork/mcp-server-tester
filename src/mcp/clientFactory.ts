import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import type { OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js';
import type { MCPConfig } from '../config/mcpConfig.js';
import {
  validateMCPConfig,
  isStdioConfig,
  isHttpConfig,
} from '../config/mcpConfig.js';
import { debugClient, debugHttp } from '../debug.js';
import { ProxyAgent } from 'undici';

/**
 * Extracts the Retry-After delay in milliseconds from an error response, if present.
 * Returns null if no Retry-After header is found or parseable.
 */
function getRetryAfterDelayMs(err: unknown): number | null {
  const response = (err as Record<string, unknown>)?.response as
    | Response
    | undefined;
  const retryAfter = response?.headers?.get?.('Retry-After');
  if (retryAfter) {
    const seconds = parseInt(retryAfter, 10);
    if (!isNaN(seconds)) return seconds * 1000;
  }
  return null;
}

/**
 * Returns true if the error is a 429 rate limit response
 */
function isRateLimitError(err: unknown): boolean {
  const response = (err as Record<string, unknown>)?.response as
    | Response
    | undefined;
  return response?.status === 429;
}

/**
 * Returns true if the error is a transient network error that may succeed on retry
 */
function isTransientNetworkError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const msg = err.message.toLowerCase();
  return (
    msg.includes('econnreset') ||
    msg.includes('econnrefused') ||
    msg.includes('etimedout') ||
    msg.includes('enotfound') ||
    msg.includes('network') ||
    msg.includes('socket hang up') ||
    msg.includes('fetch failed')
  );
}

/**
 * Returns true if the error should be retried
 */
function isRetryableError(err: unknown): boolean {
  return isTransientNetworkError(err) || isRateLimitError(err);
}

/**
 * Retries an async operation with exponential backoff.
 * Respects Retry-After headers for 429 rate limit responses.
 */
async function retryWithBackoff<T>(
  fn: () => Promise<T>,
  maxAttempts: number
): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (attempt < maxAttempts && isRetryableError(err)) {
        const retryAfterMs = getRetryAfterDelayMs(err);
        const delayMs =
          retryAfterMs !== null
            ? retryAfterMs
            : Math.min(1000 * 2 ** attempt, 30000);
        debugClient(
          'Retryable error on attempt %d/%d, retrying in %dms: %s',
          attempt + 1,
          maxAttempts + 1,
          delayMs,
          (err as Error).message
        );
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      } else {
        throw err;
      }
    }
  }
  throw lastErr;
}

/**
 * Options for creating an MCP client
 */
export interface CreateMCPClientOptions {
  /**
   * Client information (name and version)
   */
  clientInfo?: {
    name?: string;
    version?: string;
  };

  /**
   * OAuth client provider for authentication
   *
   * When provided, the MCP SDK handles OAuth flow automatically.
   * This takes precedence over static token auth in config.auth.accessToken.
   */
  authProvider?: OAuthClientProvider;
}

/**
 * Creates and connects an MCP client based on the provided configuration
 *
 * @param config - MCP configuration (will be validated)
 * @param options - Optional client options including auth provider
 * @returns Connected MCP Client instance
 * @throws {Error} If config is invalid or connection fails
 *
 * @example
 * // Stdio transport
 * const client = await createMCPClientForConfig({
 *   transport: 'stdio',
 *   command: 'node',
 *   args: ['server.js']
 * });
 *
 * @example
 * // HTTP transport with static token auth
 * const client = await createMCPClientForConfig({
 *   transport: 'http',
 *   serverUrl: 'http://localhost:3000/mcp',
 *   auth: { accessToken: 'your-token' }
 * });
 *
 * @example
 * // HTTP transport with OAuth provider
 * const client = await createMCPClientForConfig(
 *   { transport: 'http', serverUrl: 'http://localhost:3000/mcp' },
 *   { authProvider: myOAuthProvider }
 * );
 */
export async function createMCPClientForConfig(
  config: MCPConfig,
  options?: CreateMCPClientOptions
): Promise<Client> {
  // Validate config
  const validatedConfig = validateMCPConfig(config);

  // Create client with info
  const client = new Client(
    {
      name: options?.clientInfo?.name ?? '@gleanwork/mcp-server-tester',
      version: options?.clientInfo?.version ?? '0.1.0',
    },
    {
      capabilities: validatedConfig.capabilities ?? {},
    }
  );

  // Create appropriate transport and connect
  if (isStdioConfig(validatedConfig)) {
    const transport = new StdioClientTransport({
      command: validatedConfig.command,
      args: validatedConfig.args ?? [],
      ...(validatedConfig.cwd && { cwd: validatedConfig.cwd }),
      // Suppress server stderr when quiet mode is enabled
      ...(validatedConfig.quiet && { stderr: 'ignore' as const }),
    });

    debugClient('Connecting via stdio: %O', {
      command: validatedConfig.command,
      args: validatedConfig.args,
      cwd: validatedConfig.cwd,
    });

    await client.connect(
      transport,
      validatedConfig.connectTimeoutMs !== undefined
        ? { timeout: validatedConfig.connectTimeoutMs }
        : undefined
    );
  } else if (isHttpConfig(validatedConfig)) {
    // Build headers, including static token auth if configured and no authProvider
    const headers: Record<string, string> = { ...validatedConfig.headers };

    // If using static token auth (no authProvider), add Authorization header
    if (validatedConfig.auth?.accessToken && !options?.authProvider) {
      headers.Authorization = `Bearer ${validatedConfig.auth.accessToken}`;
    }

    const url = new URL(validatedConfig.serverUrl);
    let requestInit: RequestInit | undefined =
      Object.keys(headers).length > 0 ? { headers } : undefined;

    // Apply proxy if configured or available from environment
    const proxyUrl =
      validatedConfig.proxy?.url ??
      process.env['HTTPS_PROXY'] ??
      process.env['HTTP_PROXY'];

    if (proxyUrl) {
      const proxyAgent = new ProxyAgent(proxyUrl);
      debugClient('Using proxy: %s', proxyUrl);
      requestInit = {
        ...requestInit,
        dispatcher: proxyAgent,
      } as unknown as RequestInit;
    }

    debugClient('Connecting via HTTP: %O', {
      serverUrl: validatedConfig.serverUrl,
      headers:
        Object.keys(headers).length > 0 ? Object.keys(headers) : undefined,
      hasAuthProvider: !!options?.authProvider,
    });

    debugHttp('Connecting to %s', validatedConfig.serverUrl);
    if (Object.keys(headers).length > 0) {
      debugHttp('Request header names: %O', Object.keys(headers));
    }

    const retryAttempts = validatedConfig.retryAttempts ?? 0;
    const connectOptions =
      validatedConfig.connectTimeoutMs !== undefined
        ? { timeout: validatedConfig.connectTimeoutMs }
        : undefined;

    // Try Streamable HTTP first (MCP spec 2025-03-26), fall back to SSE (2024-11-05)
    await retryWithBackoff(async () => {
      try {
        debugHttp('Attempting transport: streamableHttp');
        const streamableTransport = new StreamableHTTPClientTransport(url, {
          requestInit,
          authProvider: options?.authProvider,
        });
        await client.connect(streamableTransport, connectOptions);
        debugClient('Connected via Streamable HTTP');
        debugHttp('Connection established via streamableHttp');
      } catch (err) {
        debugHttp(
          'streamableHttp failed (%s), falling back to SSE',
          (err as Error).message
        );
        debugClient('Streamable HTTP failed, falling back to SSE transport');
        debugHttp('Attempting transport: sse');
        const sseTransport = new SSEClientTransport(url, {
          requestInit,
          authProvider: options?.authProvider,
        });
        await client.connect(sseTransport, connectOptions);
        debugClient('Connected via SSE');
        debugHttp('Connection established via sse');
      }
    }, retryAttempts);
  }

  debugClient('Connected successfully');
  const serverInfo = client.getServerVersion();
  if (serverInfo) {
    debugClient('Server info: %O', serverInfo);
  }

  return client;
}

/**
 * Safely closes an MCP client connection
 *
 * @param client - The client to close
 */
export async function closeMCPClient(client: Client): Promise<void> {
  try {
    await client.close();
  } catch (error) {
    console.error('[MCP] Error closing client:', error);
    throw error;
  }
}
