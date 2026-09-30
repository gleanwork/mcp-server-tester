import {
  Client,
  SdkError,
  SdkErrorCode,
  SSEClientTransport,
  StreamableHTTPClientTransport,
  UnsupportedProtocolVersionError,
} from '@modelcontextprotocol/client';
import type { OAuthClientProvider } from '@modelcontextprotocol/client';
import {
  StdioClientTransport,
  getDefaultEnvironment,
} from '@modelcontextprotocol/client/stdio';
import type { HttpMCPConfig, MCPConfig } from '../config/mcpConfig.js';
import {
  validateMCPConfig,
  isStdioConfig,
  isHttpConfig,
  usesHostResolvedFields,
} from '../config/mcpConfig.js';
import { debugClient, debugHttp } from '../debug.js';
import type { ProtocolSetting } from '../types/index.js';
import {
  DEFAULT_PROTOCOL_SETTING,
  isProtocolRevision,
  createTesterResponseCache,
  resolveProtocolClientOptions,
} from './protocol.js';
import {
  beginConnection,
  releaseConnection,
  type MCPConnection,
} from './connection.js';
import { attachWireTap } from './wireTap.js';
import { ProxyAgent, Agent as UndiciAgent } from 'undici';
import { readFileSync } from 'node:fs';
import packageJson from '../../package.json' with { type: 'json' };
import { configuredCredentials } from '../auth/credentials.js';
import {
  MCPHttpConnectionError,
  formatMCPConnectionFailure,
} from './connectionDiagnostics.js';

/**
 * Extracts the Retry-After delay in milliseconds from an error response, if present.
 * Returns null if no Retry-After header is found or parseable.
 */
function getRetryAfterDelayMs(err: unknown): number | null {
  if (err instanceof MCPHttpConnectionError) return err.retryAfterMs;
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
  if (err instanceof MCPHttpConnectionError) return err.retryable;
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
          formatMCPConnectionFailure(err)
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
 * The undici dispatcher an HTTP connection needs: a TLS agent when TLS is
 * configured (it takes precedence over a proxy, as it always has), otherwise
 * a proxy agent. Only the dispatcher that is used gets created.
 */
function createHttpDispatcher(
  tls: HttpMCPConfig['tls'],
  proxyUrl: string | undefined
): UndiciAgent | ProxyAgent | undefined {
  if (tls) {
    if (proxyUrl)
      debugClient('Proxy ignored: TLS configuration takes precedence');
    try {
      const agent = new UndiciAgent({
        connect: {
          ...(tls.ca && { ca: readFileSync(tls.ca) }),
          ...(tls.cert && { cert: readFileSync(tls.cert) }),
          ...(tls.key && { key: readFileSync(tls.key) }),
          rejectUnauthorized: tls.rejectUnauthorized ?? true,
        },
      });
      debugClient('TLS configuration applied');
      return agent;
    } catch (error) {
      const filePath = tls.ca ?? tls.cert ?? tls.key;
      const fileType = tls.ca
        ? 'CA certificate'
        : tls.cert
          ? 'client certificate'
          : 'client key';
      throw new Error(
        `Failed to load TLS ${fileType} from ${filePath}: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }
  if (!proxyUrl) return undefined;
  try {
    const sanitized = new URL(proxyUrl);
    debugClient(
      'Using proxy: %s://%s:%s',
      sanitized.protocol.slice(0, -1),
      sanitized.hostname,
      sanitized.port
    );
  } catch {
    debugClient('Using proxy (unparseable URL)');
  }
  return new ProxyAgent(proxyUrl);
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

  /**
   * Sampling handler callback for LLM sampling requests from the server.
   *
   * When provided, the client will advertise sampling capability to the server.
   * When absent, sampling is removed from declared capabilities so the client
   * does not falsely advertise support it cannot fulfill.
   */
  samplingHandler?: (...args: unknown[]) => unknown;

  /**
   * Overrides `config.protocol` (used by the `mcpProtocol` fixture option).
   */
  protocol?: ProtocolSetting;
}

/**
 * Rewrites the SDK's era-negotiation failure into an actionable message.
 */
function describeProtocolFailure(
  error: unknown,
  protocol: ProtocolSetting
): unknown {
  if (
    error instanceof SdkError &&
    error.code === SdkErrorCode.EraNegotiationFailed
  ) {
    return new Error(
      `MCP server did not accept protocol "${protocol}": ${error.message}. ` +
        `Use protocol: 'legacy' (initialize handshake) or 'auto' (probe and fall back) for servers that do not support it.`,
      { cause: error }
    );
  }
  // A pinned legacy revision the server answered with a different one.
  if (
    error instanceof Error &&
    error.message.startsWith("Server's protocol version is not supported")
  ) {
    return new Error(
      `MCP server answered initialize with a different protocol revision than the pinned "${protocol}" (${error.message}). ` +
        `Pin the revision the server supports, or use 'legacy' to accept its choice.`,
      { cause: error }
    );
  }
  if (error instanceof UnsupportedProtocolVersionError) {
    const data = error.data as
      | { supported?: string[]; requested?: string }
      | undefined;
    const supported = data?.supported ?? [];
    return new Error(
      `MCP server does not support protocol "${data?.requested ?? protocol}" ` +
        `(it supports: ${supported.length > 0 ? supported.join(', ') : 'unknown'}). ` +
        `Set protocol to one of those revisions, or use 'auto'.`,
      { cause: error }
    );
  }
  return error;
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
  const protocol =
    options?.protocol ?? validatedConfig.protocol ?? DEFAULT_PROTOCOL_SETTING;

  // Create client with info
  const client = new Client(
    {
      name: options?.clientInfo?.name ?? '@gleanwork/mcp-server-tester',
      version: options?.clientInfo?.version ?? packageJson.version,
    },
    {
      capabilities: {
        ...(validatedConfig.capabilities ?? {}),
        // Only advertise sampling if a handler has been registered;
        // declaring sampling capability without a handler violates the MCP spec
        sampling: options?.samplingHandler
          ? (validatedConfig.capabilities?.sampling ?? {})
          : undefined,
      },
      ...resolveProtocolClientOptions(protocol, validatedConfig.protocolProbe),
      // A tester wants every call on the wire, so cached 2026-07-28
      // list/read results are never served (see createTesterResponseCache).
      responseCacheStore: createTesterResponseCache(),
    }
  );
  const connection = beginConnection(client, protocol);
  try {
    await connect(client, connection, validatedConfig, options);
  } catch (error) {
    // A failed connect never returns the client, so close what it opened.
    await releaseConnection(client);
    throw error;
  }
  debugClient('Connected successfully');
  const serverInfo = client.getServerVersion();
  if (serverInfo) {
    debugClient('Server info: %O', serverInfo);
  }

  return client;
}

/** Opens the transport for a config and connects the client over it. */
async function connect(
  client: Client,
  connection: MCPConnection,
  validatedConfig: MCPConfig,
  options: CreateMCPClientOptions | undefined
): Promise<void> {
  const protocol = connection.requestedProtocol;
  // The HTTP+SSE transport only speaks 2024-11-05, so a pin to any other
  // revision has nothing to fall back to.
  const pinsRevisionWithoutSse =
    isProtocolRevision(protocol) && protocol !== '2024-11-05';
  // Create appropriate transport and connect
  if (isStdioConfig(validatedConfig)) {
    // Unresolved `${...}` placeholders, `files`, or `auth` belong to a host.
    if (usesHostResolvedFields(validatedConfig))
      throw new Error(
        'This stdio MCP server declares host-resolved eval fields (url, auth, files, or ${url}/${dataDir}/${pluginRoot:...}); only a host that supports them (Linux Cowork) can launch it.'
      );
    const inherit = validatedConfig.inheritEnv !== false;
    const env = validatedConfig.env
      ? Object.fromEntries(
          Object.entries({
            ...(inherit ? process.env : {}),
            ...validatedConfig.env,
          }).filter(
            (entry): entry is [string, string] => entry[1] !== undefined
          )
        )
      : undefined;
    const transport = new StdioClientTransport({
      command: validatedConfig.command,
      args: validatedConfig.args ?? [],
      ...(validatedConfig.cwd && { cwd: validatedConfig.cwd }),
      // Suppress server stderr when quiet mode is enabled
      ...(validatedConfig.quiet && { stderr: 'ignore' as const }),
      ...(env && { env }),
    });

    debugClient('Connecting via stdio: %O', {
      command: validatedConfig.command,
      args: validatedConfig.args,
      cwd: validatedConfig.cwd,
    });

    try {
      await client.connect(
        transport,
        validatedConfig.connectTimeoutMs !== undefined
          ? { timeout: validatedConfig.connectTimeoutMs }
          : undefined
      );
    } catch (error) {
      throw describeProtocolFailure(error, protocol);
    }
    connection.target = {
      transport: 'stdio',
      command: validatedConfig.command,
      args: validatedConfig.args ?? [],
      ...(validatedConfig.cwd ? { cwd: validatedConfig.cwd } : {}),
      // What StdioClientTransport spawns with, so probes start the same server.
      env: { ...getDefaultEnvironment(), ...env },
    };
  } else if (isHttpConfig(validatedConfig)) {
    // Build headers, including static token auth if configured and no authProvider.
    // User-provided headers take precedence over defaults (spread order).
    const headers: Record<string, string> = {
      'User-Agent': `@gleanwork/mcp-server-tester/${packageJson.version}`,
      ...validatedConfig.headers,
    };

    // The credentials the config declares, unless the caller supplies a
    // provider (precedence: see configuredCredentials).
    const authProvider =
      options?.authProvider ??
      (await configuredCredentials(validatedConfig)).authProvider;
    if (!authProvider && validatedConfig.auth?.accessToken) {
      headers.Authorization = `Bearer ${validatedConfig.auth.accessToken}`;
    }

    const url = new URL(validatedConfig.serverUrl);
    let requestInit: RequestInit | undefined =
      Object.keys(headers).length > 0 ? { headers } : undefined;

    // Proxy (configured or from the environment) or TLS settings need an
    // undici dispatcher, which the connection owns and closes.
    const proxyUrl =
      validatedConfig.proxy?.url ??
      process.env['HTTPS_PROXY'] ??
      process.env['HTTP_PROXY'];
    const dispatcher = createHttpDispatcher(validatedConfig.tls, proxyUrl);
    if (dispatcher) {
      connection.dispatcher = dispatcher;
      requestInit = { ...requestInit, dispatcher } as unknown as RequestInit;
    }

    debugClient('Connecting via HTTP: %O', {
      serverUrl: validatedConfig.serverUrl,
      headers:
        Object.keys(headers).length > 0 ? Object.keys(headers) : undefined,
      hasAuthProvider: !!authProvider,
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
          ...(authProvider ? { authProvider } : {}),
        });
        await client.connect(streamableTransport, connectOptions);
        debugClient('Connected via Streamable HTTP');
        debugHttp('Connection established via streamableHttp');
      } catch (err) {
        // HTTP+SSE is a legacy-only transport, so a pinned modern revision
        // (or a failed era negotiation) has nothing to fall back to.
        if (
          pinsRevisionWithoutSse ||
          err instanceof UnsupportedProtocolVersionError ||
          (err instanceof SdkError &&
            err.code === SdkErrorCode.EraNegotiationFailed)
        ) {
          throw describeProtocolFailure(err, protocol);
        }
        debugHttp(
          'streamableHttp failed (%s), falling back to SSE',
          formatMCPConnectionFailure(err)
        );
        debugClient('Streamable HTTP failed, falling back to SSE transport');
        debugHttp('Attempting transport: sse');
        try {
          const sseTransport = new SSEClientTransport(url, {
            requestInit,
            ...(authProvider ? { authProvider } : {}),
          });
          await client.connect(sseTransport, connectOptions);
        } catch (sseError) {
          throw new MCPHttpConnectionError(
            err,
            sseError,
            isRetryableError(err) || isRetryableError(sseError),
            getRetryAfterDelayMs(err) ?? getRetryAfterDelayMs(sseError)
          );
        }
        debugClient('Connected via SSE');
        debugHttp('Connection established via sse');
      }
    }, retryAttempts);
    connection.target = {
      transport: 'http',
      url: url.toString(),
      headers,
      ...(dispatcher ? { dispatcher } : {}),
      ...(authProvider ? { authProvider } : {}),
    };
  }

  connection.wire = attachWireTap(client);
}

/**
 * Safely closes an MCP client connection
 *
 * @param client - The client to close
 */
export async function closeMCPClient(client: Client): Promise<void> {
  // notifications/cancelled requires a specific requestId to be useful — without one
  // the server cannot identify which request to abort. The MCP SDK does not expose
  // outstanding request IDs as a public API, so we close directly and let the
  // transport teardown signal disconnection to the server.
  try {
    // Terminate the MCP session before closing so stateful servers can clean up.
    // Sessions only exist on legacy-era (initialize-handshake) connections; the
    // 2026-07-28 revision removed them, so modern connections just close.
    const transport = client.transport;
    if (
      transport instanceof StreamableHTTPClientTransport &&
      client.getProtocolEra() !== 'modern'
    ) {
      try {
        await transport.terminateSession();
      } catch (sessionError) {
        debugClient(
          'Error terminating session: %s',
          sessionError instanceof Error
            ? sessionError.message
            : String(sessionError)
        );
      }
    }

    await client.close();
  } catch (error) {
    debugClient(
      'Error closing client: %s',
      error instanceof Error ? error.message : String(error)
    );
    throw error;
  } finally {
    // Close the pooled undici agent (TLS or proxy) the connection opened.
    await releaseConnection(client);
  }
}
