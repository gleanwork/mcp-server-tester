import type { MCPConfig } from '../config/mcpConfig.js';

const SECRET_ENV_NAME = /token|key|secret|password|authorization/i;
/** Shorter values are not credentials and would garble every message. */
const MIN_SECRET_LENGTH = 4;
const REDACTED = '[REDACTED]';

/**
 * Values a desktop client must never surface in errors: credential-like
 * environment values, resolved MCP credentials, and any `extra` values the
 * client resolved itself (e.g. plugin tokens).
 */
export function clientSecretValues(
  env: Record<string, string | undefined>,
  servers: readonly MCPConfig[],
  extra: Iterable<string> = []
): string[] {
  const secrets = new Set<string>();
  const add = (value: string | undefined) => {
    if (value && value.length >= MIN_SECRET_LENGTH) secrets.add(value);
  };
  for (const [name, value] of Object.entries(env))
    if (SECRET_ENV_NAME.test(name)) add(value);
  for (const server of servers)
    if (server.transport !== 'stdio') {
      add(server.auth?.accessToken);
      for (const value of Object.values(server.headers ?? {})) add(value);
    } else if (server.auth?.accessTokenEnv) {
      add(env[server.auth.accessTokenEnv]);
    }
  for (const value of extra) add(value);
  return [...secrets];
}

/** Replace every occurrence of every secret, longest first. */
export function redactClientSecrets(
  text: string,
  secrets: readonly string[]
): string {
  let redacted = text;
  for (const secret of [...secrets].sort((a, b) => b.length - a.length))
    redacted = redacted.split(secret).join(REDACTED);
  return redacted;
}

/** A redacted message for `error`, or `fallback` for non-Error values. */
export function redactClientError(
  error: unknown,
  secrets: readonly string[],
  fallback: string
): string {
  return redactClientSecrets(
    error instanceof Error ? error.message : fallback,
    secrets
  );
}

/** A copy of `error` with message and stack redacted. Non-Errors get `fallback`. */
export function redactedClientError(
  error: unknown,
  secrets: readonly string[],
  fallback: string
): Error {
  const safe = new Error(redactClientError(error, secrets, fallback));
  if (error instanceof Error) {
    safe.name = error.name;
    safe.stack = error.stack ? redactClientSecrets(error.stack, secrets) : '';
  }
  return safe;
}
