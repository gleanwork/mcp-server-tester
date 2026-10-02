/**
 * Where MST's LLM calls go and how they authenticate.
 *
 * Every consumer that talks to an Anthropic- or OpenAI-shaped API (the
 * `mcp_host` simulator, LLM judges) resolves its base URL and credential
 * here, so a gateway is configured once with environment variables:
 *
 * - `ANTHROPIC_BASE_URL` / `OPENAI_BASE_URL`: the endpoint override. The
 *   Anthropic one is the API root, as the official SDKs and Claude Code read
 *   it (`https://gw/anthropic`, requests go to `/v1/messages`); a trailing
 *   `/v1`, the AI SDK's form, is accepted too.
 * - `ANTHROPIC_AUTH_TOKEN`: an Anthropic gateway credential sent as
 *   `Authorization: Bearer` instead of `x-api-key`.
 * - `MST_LLM_AUTH_COMMAND`: a shell command that prints a short-lived token.
 *   Its output is cached for `MST_LLM_AUTH_COMMAND_TTL_MS` (default 5 minutes).
 *   Being MST's own setting, it wins over `ANTHROPIC_AUTH_TOKEN` and the
 *   ambient `*_API_KEY` variables.
 *
 * Gateway credentials (the command and `ANTHROPIC_AUTH_TOKEN`) are used only
 * with a base URL override, so a gateway token never reaches the provider's
 * public API.
 *
 * Base URLs are always resolved here (falling back to the public API), so an
 * SDK never reads a different `*_BASE_URL` from `process.env` on its own.
 */
import { exec } from 'node:child_process';
import { createHash } from 'node:crypto';

/** The wire API a consumer speaks. */
export type LLMApiFamily = 'anthropic' | 'openai';

/** Environment the endpoint is resolved from (`process.env` by default). */
type LLMEnvironment = Record<string, string | undefined>;

export interface LLMEndpointOptions {
  /** Defaults to `process.env`. */
  env?: LLMEnvironment;
  /**
   * Read the API key from exactly this variable. When set, no other
   * credential source is consulted (the pre-gateway behaviour).
   */
  apiKeyEnvVar?: string;
}

/**
 * A resolved endpoint, shaped like the Anthropic and OpenAI SDK options.
 * At most one of `apiKey` and `authToken` is set.
 */
export interface LLMEndpoint {
  /**
   * The base URL override, or the provider's public API. Anthropic: the API
   * root, without `/v1`. OpenAI: as configured (normally ending in `/v1`).
   */
  baseURL: string;
  /** Whether `baseURL` came from a `*_BASE_URL` override (a gateway or proxy). */
  overridden: boolean;
  /** Sent as `x-api-key` (Anthropic) or as the bearer token (OpenAI). */
  apiKey?: string;
  /** Anthropic only: sent as `Authorization: Bearer`. */
  authToken?: string;
}

const AUTH_COMMAND_ENV = 'MST_LLM_AUTH_COMMAND';
const AUTH_COMMAND_TTL_ENV = 'MST_LLM_AUTH_COMMAND_TTL_MS';
const DEFAULT_AUTH_COMMAND_TTL_MS = 5 * 60 * 1000;
const AUTH_COMMAND_TIMEOUT_MS = 30_000;

const FAMILY_ENV: Record<
  LLMApiFamily,
  {
    baseURL: string;
    publicBaseURL: string;
    apiKey: string;
    authToken?: string;
  }
> = {
  anthropic: {
    baseURL: 'ANTHROPIC_BASE_URL',
    publicBaseURL: 'https://api.anthropic.com',
    apiKey: 'ANTHROPIC_API_KEY',
    authToken: 'ANTHROPIC_AUTH_TOKEN',
  },
  openai: {
    baseURL: 'OPENAI_BASE_URL',
    publicBaseURL: 'https://api.openai.com/v1',
    apiKey: 'OPENAI_API_KEY',
  },
};

/** Where a credential comes from, before any command runs. */
type CredentialSource =
  | { kind: 'env'; envVar: string; field: 'apiKey' | 'authToken' }
  | { kind: 'command'; command: string };

function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function credentialSource(
  family: LLMApiFamily,
  env: LLMEnvironment,
  apiKeyEnvVar: string | undefined
): CredentialSource | undefined {
  if (apiKeyEnvVar !== undefined)
    return nonEmpty(env[apiKeyEnvVar])
      ? { kind: 'env', envVar: apiKeyEnvVar, field: 'apiKey' }
      : undefined;
  const names = FAMILY_ENV[family];
  // Gateway credentials go only to a base URL override.
  if (nonEmpty(env[names.baseURL])) {
    const command = nonEmpty(env[AUTH_COMMAND_ENV]);
    if (command) return { kind: 'command', command };
    if (names.authToken && nonEmpty(env[names.authToken]))
      return { kind: 'env', envVar: names.authToken, field: 'authToken' };
  }
  if (nonEmpty(env[names.apiKey]))
    return { kind: 'env', envVar: names.apiKey, field: 'apiKey' };
  return undefined;
}

function authCommandTtl(env: LLMEnvironment): number {
  const raw = nonEmpty(env[AUTH_COMMAND_TTL_ENV]);
  if (raw === undefined) return DEFAULT_AUTH_COMMAND_TTL_MS;
  const ttl = Number(raw);
  if (!Number.isInteger(ttl) || ttl < 0)
    throw new Error(
      `${AUTH_COMMAND_TTL_ENV} must be a non-negative integer number of milliseconds.`
    );
  return ttl;
}

/**
 * Whether a credential is configured for `family`, without running the auth
 * command. Lets a consumer fail fast at construction time.
 */
export function hasLLMCredential(
  family: LLMApiFamily,
  options: LLMEndpointOptions = {}
): boolean {
  const env = options.env ?? process.env;
  return credentialSource(family, env, options.apiKeyEnvVar) !== undefined;
}

/**
 * Resolves the base URL and credential for `family`. Runs the auth command
 * when it is the credential source (cached for its TTL). Returns no
 * credential when none is configured; the provider SDK then reports it.
 */
export async function resolveLLMEndpoint(
  family: LLMApiFamily,
  options: LLMEndpointOptions = {}
): Promise<LLMEndpoint> {
  const env = options.env ?? process.env;
  const names = FAMILY_ENV[family];
  const override = nonEmpty(env[names.baseURL]);
  const configured = override ?? names.publicBaseURL;
  const baseURL =
    family === 'anthropic' ? anthropicApiRoot(configured) : configured;
  const source = credentialSource(family, env, options.apiKeyEnvVar);
  const endpoint: LLMEndpoint = { baseURL, overridden: override !== undefined };
  if (!source) return endpoint;
  if (source.kind === 'env')
    return { ...endpoint, [source.field]: nonEmpty(env[source.envVar]) };
  const token = await authCommandToken(
    source.command,
    authCommandTtl(env),
    env
  );
  // OpenAI SDKs already send the API key as a bearer token.
  return family === 'anthropic'
    ? { ...endpoint, authToken: token }
    : { ...endpoint, apiKey: token };
}

/** `https://gw/anthropic/v1/` and `https://gw/anthropic` both become the latter. */
function anthropicApiRoot(url: string): string {
  return url.replace(/\/+$/, '').replace(/\/v1$/, '');
}

interface CachedToken {
  value: string;
  expiresAt: number;
}

const tokenCache = new Map<string, CachedToken>();
const pendingTokens = new Map<string, Promise<string>>();

/**
 * A token belongs to the command and the environment it ran in: a case's
 * `mcpHostConfig.env` can change what the command prints.
 */
function tokenKey(command: string, env: LLMEnvironment): string {
  const entries = Object.entries(env)
    .filter(([, value]) => value !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return createHash('sha256')
    .update(JSON.stringify([command, entries]))
    .digest('hex');
}

async function authCommandToken(
  command: string,
  ttlMs: number,
  env: LLMEnvironment
): Promise<string> {
  const key = tokenKey(command, env);
  const cached = tokenCache.get(key);
  if (cached && Date.now() < cached.expiresAt) return cached.value;
  const pending = pendingTokens.get(key);
  if (pending) return pending;
  const run = runAuthCommand(command, env)
    .then((value) => {
      tokenCache.set(key, { value, expiresAt: Date.now() + ttlMs });
      return value;
    })
    .finally(() => pendingTokens.delete(key));
  pendingTokens.set(key, run);
  return run;
}

/**
 * Runs the auth command. Errors carry only the exit status: stdout is the
 * token, and a helper's stderr can echo it too (`set -x`), while errors end
 * up in case results and reports.
 */
function runAuthCommand(command: string, env: LLMEnvironment): Promise<string> {
  return new Promise((resolve, reject) => {
    exec(
      command,
      {
        env: { ...process.env, ...env },
        timeout: AUTH_COMMAND_TIMEOUT_MS,
        maxBuffer: 64 * 1024,
        windowsHide: true,
      },
      (error, stdout) => {
        if (error) {
          const status = error.killed
            ? 'timed out'
            : `exit ${String(error.code ?? 'unknown')}`;
          reject(
            new Error(
              `${AUTH_COMMAND_ENV} failed (${status}). Run it in a terminal to see its output.`
            )
          );
          return;
        }
        const token = stdout.trim();
        if (!token) {
          reject(new Error(`${AUTH_COMMAND_ENV} printed no token.`));
          return;
        }
        resolve(token);
      }
    );
  });
}
