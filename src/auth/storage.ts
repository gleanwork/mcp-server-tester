/**
 * OAuth token storage with environment variable support for CI/CD
 *
 * Provides file-based storage for OAuth state per MCP server, with support
 * for token injection via environment variables for automated testing.
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { homedir } from 'node:os';
import type { StoredTokens, StoredClientInfo } from './types.js';
import type { AuthServerMetadata } from './oauthFlow.js';
import type { ProtectedResourceMetadata } from './discovery.js';

/**
 * Combined server metadata (auth server + protected resource)
 */
export interface StoredServerMetadata {
  /**
   * Authorization server metadata
   */
  authServer: AuthServerMetadata;

  /**
   * Protected resource metadata
   */
  protectedResource: ProtectedResourceMetadata;

  /**
   * Timestamp when metadata was discovered
   */
  discoveredAt: number;
}

/**
 * Interface for OAuth storage operations
 */
export interface OAuthStorage {
  /**
   * Load combined server metadata
   */
  loadServerMetadata(): Promise<StoredServerMetadata | null>;

  /**
   * Save combined server metadata
   */
  saveServerMetadata(metadata: StoredServerMetadata): Promise<void>;

  /**
   * Load registered client information
   */
  loadClient(): Promise<StoredClientInfo | null>;

  /**
   * Save registered client information
   */
  saveClient(client: StoredClientInfo): Promise<void>;

  /**
   * Load stored tokens
   */
  loadTokens(): Promise<StoredTokens | null>;

  /**
   * Save tokens
   */
  saveTokens(tokens: StoredTokens): Promise<void>;

  /**
   * Delete stored tokens
   */
  deleteTokens(): Promise<void>;

  /**
   * Check if valid (non-expired) token exists
   * @param bufferMs - Buffer time in milliseconds before expiration (default: 60000)
   */
  hasValidToken(bufferMs?: number): Promise<boolean>;
}

/**
 * Configuration for file-based OAuth storage
 */
export interface FileOAuthStorageConfig {
  /**
   * MCP server URL (used to generate storage key)
   */
  serverUrl: string;

  /**
   * Custom state directory (overrides default)
   */
  stateDir?: string;
}

/**
 * Environment variable names for CI/CD token injection
 */
export const ENV_VAR_NAMES = {
  accessToken: 'MCP_ACCESS_TOKEN',
  refreshToken: 'MCP_REFRESH_TOKEN',
  tokenType: 'MCP_TOKEN_TYPE',
  expiresAt: 'MCP_TOKEN_EXPIRES_AT',
} as const;

/**
 * Default buffer time before token expiration (60 seconds)
 */
const DEFAULT_EXPIRY_BUFFER_MS = 60_000;

/**
 * Generates a filesystem-safe key from a server URL
 *
 * @param serverUrl - The MCP server URL
 * @returns A filesystem-safe key string
 *
 * @example
 * generateServerKey('https://api.example.com:8080/mcp')
 * // Returns: 'api.example.com_8080_mcp'
 */
export function generateServerKey(serverUrl: string): string {
  const url = new URL(serverUrl);

  // Start with hostname
  let key = url.hostname;

  // Add port if non-standard
  if (url.port) {
    key += `_${url.port}`;
  }

  // Add path, replacing slashes with underscores
  if (url.pathname && url.pathname !== '/') {
    const cleanPath = url.pathname
      .replace(/^\/+|\/+$/g, '') // Remove leading/trailing slashes
      .replace(/\//g, '_'); // Replace remaining slashes with underscores
    if (cleanPath) {
      key += `_${cleanPath}`;
    }
  }

  // Make filesystem-safe: replace any remaining problematic characters
  return key.replace(/[^a-zA-Z0-9_.-]/g, '_');
}

/**
 * Gets the state directory for a server
 *
 * Default locations:
 * - Linux: $XDG_STATE_HOME/mcp-tests/{serverKey}/ or ~/.local/state/mcp-tests/{serverKey}/
 * - macOS: ~/.local/state/mcp-tests/{serverKey}/
 * - Windows: %LOCALAPPDATA%\mcp-tests\{serverKey}\
 *
 * @param serverUrl - The MCP server URL
 * @param customDir - Optional custom base directory
 * @returns The state directory path
 */
export function getStateDir(serverUrl: string, customDir?: string): string {
  const serverKey = generateServerKey(serverUrl);

  if (customDir) {
    return path.join(customDir, serverKey);
  }

  // Platform-specific defaults
  if (process.platform === 'win32') {
    const localAppData = process.env.LOCALAPPDATA;
    if (localAppData) {
      return path.join(localAppData, 'mcp-tests', serverKey);
    }
    // Fallback for Windows
    return path.join(homedir(), 'AppData', 'Local', 'mcp-tests', serverKey);
  }

  // Linux: Honor XDG_STATE_HOME
  if (process.platform === 'linux' && process.env.XDG_STATE_HOME) {
    return path.join(process.env.XDG_STATE_HOME, 'mcp-tests', serverKey);
  }

  // Default for macOS and Linux
  return path.join(homedir(), '.local', 'state', 'mcp-tests', serverKey);
}

/**
 * Get the base directory for all MCP token storage
 */
function getBaseStateDir(): string {
  if (process.platform === 'win32') {
    const localAppData = process.env.LOCALAPPDATA;
    if (localAppData) {
      return path.join(localAppData, 'mcp-tests');
    }
    return path.join(homedir(), 'AppData', 'Local', 'mcp-tests');
  }

  if (process.platform === 'linux' && process.env.XDG_STATE_HOME) {
    return path.join(process.env.XDG_STATE_HOME, 'mcp-tests');
  }

  return path.join(homedir(), '.local', 'state', 'mcp-tests');
}

/**
 * Known server info
 */
export interface KnownServer {
  /** The server key (directory name) */
  key: string;
  /** Reconstructed URL (best effort) */
  url: string;
  /** Whether valid tokens exist */
  hasTokens: boolean;
}

/**
 * List all known authenticated servers from the token storage directory
 *
 * @returns Array of known servers with their URLs and token status
 */
export async function listKnownServers(): Promise<KnownServer[]> {
  const baseDir = getBaseStateDir();
  const servers: KnownServer[] = [];

  try {
    const entries = await fs.readdir(baseDir, { withFileTypes: true });

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;

      const serverKey = entry.name;
      const tokensPath = path.join(baseDir, serverKey, 'tokens.json');

      let hasTokens = false;
      try {
        await fs.access(tokensPath);
        hasTokens = true;
      } catch {
        // No tokens file
      }

      // Reconstruct URL from server key (best effort)
      // Format: hostname_port_path or hostname_path
      const parts = serverKey.split('_');
      const hostname = parts[0];
      const rest = parts.slice(1).join('/');
      const url = `https://${hostname}/${rest}`;

      servers.push({ key: serverKey, url, hasTokens });
    }
  } catch {
    // Directory doesn't exist or not readable
  }

  return servers;
}

/**
 * Reads tokens from environment variables (for CI/CD)
 *
 * @returns StoredTokens if MCP_ACCESS_TOKEN is set, null otherwise
 */
export function loadTokensFromEnv(): StoredTokens | null {
  const accessToken = process.env[ENV_VAR_NAMES.accessToken];

  if (!accessToken) {
    return null;
  }

  const expiresAtStr = process.env[ENV_VAR_NAMES.expiresAt];
  const expiresAt = expiresAtStr ? parseInt(expiresAtStr, 10) : undefined;

  return {
    accessToken,
    refreshToken: process.env[ENV_VAR_NAMES.refreshToken],
    tokenType: process.env[ENV_VAR_NAMES.tokenType] ?? 'Bearer',
    expiresAt: expiresAt && !isNaN(expiresAt) ? expiresAt : undefined,
  };
}

/**
 * Programmatically inject tokens into storage (for CI/CD setup)
 *
 * @param serverUrl - The MCP server URL
 * @param tokens - The tokens to inject
 * @param stateDir - Optional custom state directory
 */
export async function injectTokens(
  serverUrl: string,
  tokens: StoredTokens,
  stateDir?: string
): Promise<void> {
  const storage = createFileOAuthStorage({ serverUrl, stateDir });
  await storage.saveTokens(tokens);
}

/**
 * Load stored OAuth tokens for an MCP server
 *
 * Reads tokens from the standard storage location for the given server URL.
 * Tokens are stored by `mst login` or `injectTokens()`.
 *
 * @param serverUrl - The MCP server URL
 * @param stateDir - Optional custom state directory
 * @returns StoredTokens if found, null otherwise
 *
 * @example
 * ```typescript
 * // After running: npx mst login https://api.example.com/mcp
 * const tokens = await loadTokens('https://api.example.com/mcp');
 * if (tokens?.accessToken) {
 *   // Use the token — never log raw token values
 *   headers.Authorization = `Bearer ${tokens.accessToken}`;
 * }
 * ```
 */
export async function loadTokens(
  serverUrl: string,
  stateDir?: string
): Promise<StoredTokens | null> {
  const storage = createFileOAuthStorage({ serverUrl, stateDir });
  return storage.loadTokens();
}

/**
 * Check if valid OAuth tokens exist for an MCP server
 *
 * Returns true if tokens exist and are not expired (with buffer).
 * Use this to check if authentication is needed before making requests.
 *
 * @param serverUrl - The MCP server URL
 * @param options - Optional configuration
 * @param options.stateDir - Custom state directory
 * @param options.bufferMs - Buffer time before expiration (default: 60000ms)
 * @returns true if valid (non-expired) tokens exist
 *
 * @example
 * ```typescript
 * if (await hasValidTokens('https://api.example.com/mcp')) {
 *   // Use stored tokens
 *   const tokens = await loadTokens('https://api.example.com/mcp');
 * } else {
 *   console.log('Run: npx mst login https://api.example.com/mcp');
 * }
 * ```
 */
export async function hasValidTokens(
  serverUrl: string,
  options?: { stateDir?: string; bufferMs?: number }
): Promise<boolean> {
  const storage = createFileOAuthStorage({
    serverUrl,
    stateDir: options?.stateDir,
  });
  return storage.hasValidToken(options?.bufferMs);
}

/**
 * Creates a file-based OAuth storage instance
 *
 * @param config - Storage configuration
 * @returns OAuthStorage instance
 */
export function createFileOAuthStorage(
  config: FileOAuthStorageConfig
): OAuthStorage {
  return new FileOAuthStorage(config);
}

/**
 * File-based OAuth storage implementation
 */
class FileOAuthStorage implements OAuthStorage {
  private readonly stateDir: string;

  constructor(config: FileOAuthStorageConfig) {
    this.stateDir = getStateDir(config.serverUrl, config.stateDir);
  }

  private get serverMetadataPath(): string {
    return path.join(this.stateDir, 'server.json');
  }

  private get clientPath(): string {
    return path.join(this.stateDir, 'client.json');
  }

  private get tokensPath(): string {
    return path.join(this.stateDir, 'tokens.json');
  }

  async loadServerMetadata(): Promise<StoredServerMetadata | null> {
    return this.loadFile<StoredServerMetadata>(this.serverMetadataPath);
  }

  async saveServerMetadata(metadata: StoredServerMetadata): Promise<void> {
    await this.atomicWrite(this.serverMetadataPath, metadata);
  }

  async loadClient(): Promise<StoredClientInfo | null> {
    return this.loadFile<StoredClientInfo>(this.clientPath);
  }

  async saveClient(client: StoredClientInfo): Promise<void> {
    await this.atomicWrite(this.clientPath, client);
  }

  async loadTokens(): Promise<StoredTokens | null> {
    return this.loadFile<StoredTokens>(this.tokensPath);
  }

  async saveTokens(tokens: StoredTokens): Promise<void> {
    await this.atomicWrite(this.tokensPath, tokens);
  }

  async deleteTokens(): Promise<void> {
    await this.deleteFile(this.tokensPath);
  }

  async hasValidToken(
    bufferMs: number = DEFAULT_EXPIRY_BUFFER_MS
  ): Promise<boolean> {
    const tokens = await this.loadTokens();

    if (!tokens?.accessToken) {
      return false;
    }

    // If no expiration, assume valid
    if (!tokens.expiresAt) {
      return true;
    }

    // Check if token is expired (with buffer)
    return tokens.expiresAt > Date.now() + bufferMs;
  }

  /**
   * Load a JSON file, returning null if not found
   */
  private async loadFile<T>(filePath: string): Promise<T | null> {
    try {
      const content = await fs.readFile(filePath, 'utf-8');
      return JSON.parse(content) as T;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return null;
      }
      throw error;
    }
  }

  /**
   * Write data atomically: write to .tmp file, then rename
   * Files are created with 0o600 permissions (user read/write only)
   */
  private async atomicWrite(filePath: string, data: unknown): Promise<void> {
    // Note: The `mode` parameter is ignored on Windows (Win32) where file
    // permissions are controlled by NTFS ACLs, not Unix permission bits.
    // On Windows, token files may be readable by other users on the system
    // depending on the directory's inherited ACL. This is a Node.js fs
    // limitation. Windows users should verify %LOCALAPPDATA% permissions manually.
    await fs.mkdir(this.stateDir, { recursive: true, mode: 0o700 });

    const tmpPath = `${filePath}.tmp`;
    const content = JSON.stringify(data, null, 2);

    // Write to temp file with restrictive permissions (user read/write only)
    await fs.writeFile(tmpPath, content, { encoding: 'utf-8', mode: 0o600 });

    // Atomic rename
    await fs.rename(tmpPath, filePath);
  }

  /**
   * Delete a file, ignoring errors if the file doesn't exist
   */
  private async deleteFile(filePath: string): Promise<void> {
    try {
      await fs.unlink(filePath);
    } catch (error) {
      // Ignore ENOENT (file doesn't exist)
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error;
      }
    }
  }
}
