import type { MCPConfig } from '../config/mcpConfig.js';

/**
 * The words of a name that say its value is a credential. A whole word must
 * match, so `GIT_AUTHOR_NAME`, `MCP_OAUTH_SERVER_URL`, `KEYCLOAK_URL` and
 * `MST_TOKENS_DIR` are settings.
 */
const CREDENTIAL_WORDS = new Set([
  'token',
  'key',
  'apikey',
  'secret',
  'password',
  'passwd',
  'auth',
  'authorization',
  'cookie',
  'credential',
  'credentials',
  'pat',
]);
/** Shorter values are not credentials and would garble every message. */
const MIN_SECRET_LENGTH = 4;
/**
 * A value is a secret by its name alone only when it is at least this long:
 * a short one (`true`, `main`, a port) would garble the transcripts graders read.
 */
const MIN_NAMED_SECRET_LENGTH = 8;
const REDACTED = '[REDACTED]';

/**
 * Values with a credential's name ({@link isCredentialName}), at least
 * {@link MIN_NAMED_SECRET_LENGTH} long: environment variables, a secrets
 * file's entries, a server's headers. Settings beside them, such as a base
 * URL or an instance name, are kept, so transcripts that quote them grade as
 * they should.
 */
export function namedSecretValues(
  values: Readonly<Record<string, string | undefined>>
): string[] {
  return Object.entries(values).flatMap(([name, value]) =>
    value !== undefined &&
    value.length >= MIN_NAMED_SECRET_LENGTH &&
    isCredentialName(name)
      ? [value]
      : []
  );
}

/**
 * Whether a name says its value is a credential, for an environment
 * variable, a secrets file entry or a header alike: one of its words, split
 * at `_`, `-`, `.`, camelCase (an acronym too, as in `APIToken`) and the
 * digits that end it, is a {@link CREDENTIAL_WORDS} word. `ACME_API_KEY`,
 * `Authorization`, `GITHUB_PAT`, `accessToken`, `JWTSecret` and
 * `GITHUB_TOKEN2` are; `OPENAI_BASE_URL`, `AUTH0_DOMAIN`, `Accept` and `PATH`
 * are not.
 */
export function isCredentialName(name: string): boolean {
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/([A-Z])([A-Z][a-z])/g, '$1_$2')
    .replace(/([A-Za-z])([0-9]+)$/, '$1_$2')
    .split(/[^A-Za-z0-9]+/)
    .some((word) => CREDENTIAL_WORDS.has(word.toLowerCase()));
}

/**
 * Every secret MST knows for a client: values named as credentials
 * ({@link namedSecretValues}) in the environment and the servers' headers,
 * the credentials the servers use (an access token, the variable an
 * `accessTokenEnv` names), and any `extra` values the client resolved
 * itself (e.g. plugin tokens).
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
  for (const value of namedSecretValues(env)) add(value);
  for (const server of servers)
    if (server.transport !== 'stdio') {
      add(server.auth?.accessToken);
      for (const value of namedSecretValues(server.headers ?? {})) add(value);
    } else {
      if (server.auth?.accessTokenEnv) add(env[server.auth.accessTokenEnv]);
      // A stdio server's own environment, named like the run's.
      for (const value of namedSecretValues(server.env ?? {})) add(value);
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

/**
 * Where a result names files on this machine (a Cowork session folder): a
 * path, not content, and rewriting it would lose the files.
 */
const FILE_PATHS = new Set(['artifacts', 'response.artifacts']);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null) return false;
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function redactStrings(
  value: unknown,
  secrets: readonly string[],
  path: string
): unknown {
  if (typeof value === 'string') return replaceAll(value, secrets);
  if (Array.isArray(value))
    return value.map((item) => redactStrings(item, secrets, `${path}[]`));
  // An object with its own `toJSON` is stored as what that returns, so it
  // is redacted in that form, even when it is a plain object.
  if (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { toJSON?: unknown }).toJSON === 'function'
  )
    return redactedJsonForm(value, secrets, path);
  if (isPlainObject(value)) {
    const entries: Array<[string, unknown]> = [];
    const names = new Set<string>();
    for (const [key, item] of Object.entries(value)) {
      const at = path ? `${path}.${key}` : key;
      // A key can be a secret too (a map of tokens). Two keys that redact
      // alike are numbered, so neither value is lost.
      const redacted = replaceAll(key, secrets);
      let name = redacted;
      for (let n = 2; names.has(name); n++) name = `${redacted} ${n}`;
      names.add(name);
      entries.push([
        name,
        FILE_PATHS.has(at) ? item : redactStrings(item, secrets, at),
      ]);
    }
    return Object.fromEntries(entries);
  }
  if (typeof value === 'object' && value !== null)
    return redactedJsonForm(value, secrets, path);
  return value;
}

/**
 * Any other object (a `URL`, a class instance) is stored as its JSON form,
 * which can hold a secret. When it does, the redacted JSON form replaces it;
 * otherwise the object stays as it is (a `Date` stays a `Date`).
 */
function redactedJsonForm(
  value: object,
  secrets: readonly string[],
  path: string
): unknown {
  let json: string | undefined;
  try {
    json = JSON.stringify(value);
  } catch {
    // Circular or a BigInt: it can't be stored either.
    return value;
  }
  if (json === undefined) return value;
  // Compare parsed strings, not the JSON text, where a secret with a quote
  // or a newline in it is escaped.
  const redacted = redactStrings(JSON.parse(json) as unknown, secrets, path);
  return JSON.stringify(redacted) === json ? value : redacted;
}

/**
 * A client's result with every secret replaced, wherever it is: the answer,
 * events, model calls, telemetry, `error` and the ending's `reason`. Its
 * `artifacts` are paths to files, kept as they are. MST does this to every
 * result a client returns, before it is graded or stored.
 */
export function redactedClientRun<T>(result: T, secrets: readonly string[]): T {
  const list = credentials(secrets);
  return list.length ? (redactStrings(result, list, '') as T) : result;
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
