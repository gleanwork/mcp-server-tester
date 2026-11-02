import type { MCPConfig } from '../config/mcpConfig.js';

const SECRET_ENV_NAME = /token|key|secret|password|authorization/i;
/** Shorter values are not credentials and would garble every message. */
const MIN_SECRET_LENGTH = 4;
/**
 * An environment value is a secret by its name alone only when it is at
 * least this long: a short one (`true`, `main`, a port) would garble the
 * traces graders read.
 */
const MIN_ENV_SECRET_LENGTH = 8;
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
    if (
      SECRET_ENV_NAME.test(name) &&
      (value?.length ?? 0) >= MIN_ENV_SECRET_LENGTH
    )
      add(value);
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

/** The secrets long enough to be credentials, longest first. */
function credentials(secrets: readonly string[]): string[] {
  return [...new Set(secrets)]
    .filter((secret) => secret.length >= MIN_SECRET_LENGTH)
    .sort((a, b) => b.length - a.length);
}

function replaceAll(text: string, secrets: readonly string[]): string {
  let redacted = text;
  for (const secret of secrets)
    redacted = redacted.split(secret).join(REDACTED);
  return redacted;
}

/** Replace every occurrence of every secret, longest first. */
export function redactClientSecrets(
  text: string,
  secrets: readonly string[]
): string {
  return replaceAll(text, credentials(secrets));
}

function redactStrings(value: unknown, secrets: readonly string[]): unknown {
  if (typeof value === 'string') return replaceAll(value, secrets);
  if (Array.isArray(value))
    return value.map((item) => redactStrings(item, secrets));
  if (
    typeof value === 'object' &&
    value !== null &&
    Object.getPrototypeOf(value) === Object.prototype
  )
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        redactStrings(item, secrets),
      ])
    );
  return value;
}

/**
 * A client's result with every secret replaced, wherever it is: the answer,
 * events, model calls, telemetry, `error` and the ending's `reason`. MST does
 * this to every result a client returns, before it is graded or stored.
 */
export function redactedClientRun<T>(result: T, secrets: readonly string[]): T {
  const list = credentials(secrets);
  return list.length ? (redactStrings(result, list) as T) : result;
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
