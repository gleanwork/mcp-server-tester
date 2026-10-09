import {
  isHttpConfig,
  usesClientResolvedFields,
  type MCPConfig,
} from '../config/mcpConfig.js';

/**
 * A server as a client connects to it, with `env`'s secrets in place: a
 * stdio server gets the environment, and an HTTP server's `accessTokenEnv`
 * becomes its token. The result holds secrets, so it never goes into a shard
 * bundle; a worker resolves its servers itself.
 */
export function resolveServerSecrets(
  server: MCPConfig,
  env: Record<string, string | undefined>
): MCPConfig {
  // A client resolves these; merging process.env here would copy secrets.
  if (usesClientResolvedFields(server)) return server;
  if (server.transport === 'stdio')
    return {
      ...server,
      env: Object.fromEntries(
        Object.entries({ ...env, ...server.env }).filter(
          (entry): entry is [string, string] => typeof entry[1] === 'string'
        )
      ),
    };
  if (!isHttpConfig(server) || !server.auth?.accessTokenEnv) return server;
  const envName = server.auth.accessTokenEnv;
  const token = env[envName];
  if (!token) {
    throw new Error(
      `MCP access token environment variable "${envName}" is not set.`
    );
  }
  const { accessTokenEnv: _accessTokenEnv, ...auth } = server.auth;
  return { ...server, auth: { ...auth, accessToken: token } };
}
