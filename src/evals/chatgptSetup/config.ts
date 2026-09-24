import {
  usesHostResolvedFields,
  type MCPConfig,
} from '../../config/mcpConfig.js';
import type { CodexMcpServerConfig } from '../codexSetup/config.js';
import { isChatgptBuiltinServer } from '../externalHost/builtins/chatgptTrace.js';

/** Adapt resolved V2 servers without writing HTTP credentials into config.toml. */
export function chatgptServers(
  servers: MCPConfig[],
  env: Record<string, string | undefined>
): {
  servers: CodexMcpServerConfig[];
  environment: Record<string, string>;
} {
  const environment: Record<string, string> = {};
  const labels = new Set<string>();
  return {
    environment,
    servers: servers.map((server, index) => {
      const label = server.label ?? `server_${index + 1}`;
      if (!/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(label) || labels.has(label))
        throw new Error(
          'ChatGPT MCP server labels must be unique config-safe identifiers.'
        );
      if (isChatgptBuiltinServer(label))
        throw new Error(
          `ChatGPT MCP server label ${label} is reserved for a built-in host tool.`
        );
      labels.add(label);
      // Codex cannot resolve host placeholders or write private files.
      if (
        server.transport === 'stdio' &&
        (usesHostResolvedFields(server) || server.minTools !== undefined)
      )
        throw new Error(
          `ChatGPT does not support host-resolved stdio eval servers (${label}: url, auth, files, minTools, or \${...} placeholders). Use plugins[].mcp to point a plugin's own server at the eval endpoint.`
        );
      if (server.transport === 'stdio')
        return {
          transport: 'stdio',
          label,
          command: server.command,
          args: server.args,
          cwd: server.cwd,
          env: server.env,
        };
      if (
        server.transport !== 'http' ||
        Object.keys(server.headers ?? {}).length ||
        server.auth?.oauth ||
        server.auth?.clientCredentials
      )
        throw new Error(
          'ChatGPT supports stdio or HTTP MCP with a resolved bearer token; custom headers and interactive MCP auth are not supported.'
        );
      const url = new URL(server.serverUrl);
      if (url.username || url.password)
        throw new Error('ChatGPT MCP URLs must not contain credentials.');
      const token =
        server.auth?.accessToken ??
        (server.auth?.accessTokenEnv
          ? env[server.auth.accessTokenEnv]
          : undefined);
      if (
        (server.auth?.accessTokenEnv ||
          server.auth?.accessToken !== undefined) &&
        (!token || /[\r\n]/.test(token))
      )
        throw new Error(
          `ChatGPT MCP credential is missing or invalid for ${label}.`
        );
      const key = `MST_CHATGPT_MCP_TOKEN_${index}`;
      if (token) environment[key] = token;
      return {
        transport: 'http',
        label,
        url: server.serverUrl,
        ...(token ? { bearerTokenEnvVar: key } : {}),
      };
    }),
  };
}
