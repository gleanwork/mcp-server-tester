/**
 * The OAuth HTTP calls grants need, on plain `fetch`. Vendors differ from the
 * specs in small ways (Slack answers 200 with `{ "ok": false }`, GitHub
 * answers device-flow polls 200 with `{ "error": ... }`, Google publishes no
 * protected-resource metadata), so these are lenient where a strict client
 * would fail, and strict where it matters: https endpoints only.
 */
import { MCP_PROTOCOL_VERSION } from '../discovery.js';

/** A fetch implementation (for tests). */
export type FetchFn = (
  input: string | URL | Request,
  init?: RequestInit
) => Promise<Response>;

const USER_AGENT = '@gleanwork/mcp-server-tester';
const TIMEOUT_MS = 30_000;

/** What MST needs from an authorization server's metadata. */
export interface AuthorizationServer {
  issuer: string;
  authorizationEndpoint?: string;
  tokenEndpoint: string;
  registrationEndpoint?: string;
  deviceAuthorizationEndpoint?: string;
  revocationEndpoint?: string;
  scopesSupported?: string[];
}

/** A token endpoint response, normalized. */
export interface TokenResponse {
  accessToken: string;
  refreshToken?: string;
  /** Seconds. */
  expiresIn?: number;
  scope?: string;
}

export class OAuthHttpError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly oauthError?: string
  ) {
    super(message);
    this.name = 'OAuthHttpError';
  }
}

function isLoopback(url: URL): boolean {
  return ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
}

/** Endpoints must be https (http only on loopback, for tests and local servers). */
export function checkEndpoint(value: unknown, field: string): string {
  if (typeof value !== 'string') throw new OAuthHttpError(`Missing ${field}.`);
  const url = new URL(value);
  if (
    url.protocol !== 'https:' &&
    !(url.protocol === 'http:' && isLoopback(url))
  )
    throw new OAuthHttpError(`${field} must be https: ${url.origin}`);
  return url.toString();
}

async function getJson(
  url: string,
  fetchFn: FetchFn
): Promise<Record<string, unknown> | undefined> {
  try {
    const response = await fetchFn(url, {
      headers: {
        Accept: 'application/json',
        'MCP-Protocol-Version': MCP_PROTOCOL_VERSION,
        'User-Agent': USER_AGENT,
      },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!response.ok) return undefined;
    const body: unknown = await response.json();
    return body && typeof body === 'object' && !Array.isArray(body)
      ? (body as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * RFC 9728 protected-resource metadata candidates for an MCP endpoint, the
 * one its 401 advertises first.
 */
async function resourceMetadataUrls(
  mcpUrl: string,
  fetchFn: FetchFn
): Promise<string[]> {
  const candidates: string[] = [];
  try {
    const probe = await fetchFn(mcpUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'User-Agent': USER_AGENT },
      body: '{}',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const advertised = /resource_metadata="([^"]+)"/.exec(
      probe.headers.get('www-authenticate') ?? ''
    );
    if (advertised?.[1]) candidates.push(advertised[1]);
  } catch {
    // Unreachable without auth is fine; fall back to well-known paths.
  }
  const url = new URL(mcpUrl);
  const path = url.pathname.replace(/\/$/, '');
  if (path)
    candidates.push(
      `${url.origin}/.well-known/oauth-protected-resource${path}`
    );
  candidates.push(`${url.origin}/.well-known/oauth-protected-resource`);
  return candidates;
}

/** The protected resource's metadata: its authorization server and scopes. */
export async function discoverResource(
  mcpUrl: string,
  fetchFn: FetchFn = fetch
): Promise<{
  authorizationServer?: string;
  scopesSupported?: string[];
  resource?: string;
}> {
  for (const url of await resourceMetadataUrls(mcpUrl, fetchFn)) {
    const metadata = await getJson(url, fetchFn);
    const servers = metadata?.authorization_servers;
    if (Array.isArray(servers) && typeof servers[0] === 'string')
      return {
        authorizationServer: servers[0],
        scopesSupported: Array.isArray(metadata?.scopes_supported)
          ? (metadata.scopes_supported as unknown[]).filter(
              (scope): scope is string => typeof scope === 'string'
            )
          : undefined,
        resource:
          typeof metadata?.resource === 'string'
            ? metadata.resource
            : undefined,
      };
  }
  return {};
}

/** RFC 8414 (or OpenID Connect) metadata for an issuer. */
export async function discoverAuthorizationServer(
  issuer: string,
  fetchFn: FetchFn = fetch
): Promise<AuthorizationServer> {
  const url = new URL(issuer);
  const path = url.pathname.replace(/\/$/, '');
  const candidates = [
    `${url.origin}/.well-known/oauth-authorization-server${path}`,
    `${url.origin}/.well-known/oauth-authorization-server`,
    `${issuer.replace(/\/$/, '')}/.well-known/openid-configuration`,
  ];
  for (const candidate of [...new Set(candidates)]) {
    const metadata = await getJson(candidate, fetchFn);
    if (metadata?.token_endpoint) {
      const optional = (field: string) =>
        metadata[field] === undefined
          ? undefined
          : checkEndpoint(metadata[field], field);
      return {
        issuer,
        tokenEndpoint: checkEndpoint(metadata.token_endpoint, 'token_endpoint'),
        authorizationEndpoint: optional('authorization_endpoint'),
        registrationEndpoint: optional('registration_endpoint'),
        deviceAuthorizationEndpoint: optional('device_authorization_endpoint'),
        revocationEndpoint: optional('revocation_endpoint'),
        scopesSupported: Array.isArray(metadata.scopes_supported)
          ? (metadata.scopes_supported as unknown[]).filter(
              (scope): scope is string => typeof scope === 'string'
            )
          : undefined,
      };
    }
  }
  throw new OAuthHttpError(
    `No OAuth authorization server metadata for ${url.origin}.`
  );
}

/** POST a form to a token-style endpoint and return the JSON object. */
export async function postForm(
  endpoint: string,
  form: Record<string, string | undefined>,
  fetchFn: FetchFn = fetch
): Promise<Record<string, unknown>> {
  const body = new URLSearchParams();
  for (const [name, value] of Object.entries(form))
    if (value !== undefined) body.set(name, value);
  let response: Response;
  try {
    response = await fetchFn(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
        'User-Agent': USER_AGENT,
      },
      body,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch {
    throw new OAuthHttpError(`Cannot reach ${new URL(endpoint).origin}.`);
  }
  let parsed: unknown;
  try {
    parsed = await response.json();
  } catch {
    parsed = undefined;
  }
  const object =
    parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  if (!response.ok) {
    const error = typeof object.error === 'string' ? object.error : undefined;
    const description =
      typeof object.error_description === 'string'
        ? object.error_description
        : undefined;
    // Never include the response body: it can echo a token.
    throw new OAuthHttpError(
      `${new URL(endpoint).origin} answered ${response.status}${error ? `: ${error}` : ''}${description ? ` (${description})` : ''}`,
      response.status,
      error
    );
  }
  return object;
}

/** Read a token response, including vendors' 200-with-error replies. */
export function tokenResponse(
  body: Record<string, unknown>,
  origin: string
): TokenResponse {
  // Slack answers 200 with { ok: false, error }.
  if (body.ok === false)
    throw new OAuthHttpError(
      `${origin} rejected the request: ${typeof body.error === 'string' ? body.error : 'unknown error'}`,
      undefined,
      typeof body.error === 'string' ? body.error : undefined
    );
  if (typeof body.error === 'string')
    throw new OAuthHttpError(
      `${origin} rejected the request: ${body.error}`,
      undefined,
      body.error
    );
  if (typeof body.access_token !== 'string' || !body.access_token)
    throw new OAuthHttpError(`${origin} returned no access_token.`);
  return {
    accessToken: body.access_token,
    refreshToken:
      typeof body.refresh_token === 'string' && body.refresh_token
        ? body.refresh_token
        : undefined,
    expiresIn:
      typeof body.expires_in === 'number'
        ? body.expires_in
        : typeof body.expires_in === 'string' && /^\d+$/.test(body.expires_in)
          ? Number(body.expires_in)
          : undefined,
    scope: typeof body.scope === 'string' ? body.scope : undefined,
  };
}

/** RFC 7591: register a public PKCE client for one redirect URI. */
export async function registerClient(
  registrationEndpoint: string,
  redirectUri: string,
  fetchFn: FetchFn = fetch
): Promise<string> {
  let response: Response;
  try {
    response = await fetchFn(registrationEndpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'MCP-Protocol-Version': MCP_PROTOCOL_VERSION,
        'User-Agent': USER_AGENT,
      },
      body: JSON.stringify({
        client_name: USER_AGENT,
        redirect_uris: [redirectUri],
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        token_endpoint_auth_method: 'none',
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch {
    throw new OAuthHttpError(
      `Cannot reach ${new URL(registrationEndpoint).origin} to register a client.`
    );
  }
  if (!response.ok)
    throw new OAuthHttpError(
      `Client registration at ${new URL(registrationEndpoint).origin} failed: ${response.status}`,
      response.status
    );
  const body = (await response.json().catch(() => ({}))) as {
    client_id?: unknown;
  };
  if (typeof body.client_id !== 'string' || !body.client_id)
    throw new OAuthHttpError('Client registration returned no client_id.');
  return body.client_id;
}
