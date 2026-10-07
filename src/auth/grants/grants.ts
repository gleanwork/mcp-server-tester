/**
 * Grants: signing in once, then a fresh access token for every run.
 *
 * `signIn` runs the interactive flow (browser redirect with PKCE, or device
 * code) and stores the grant. `accessToken` returns a token for a run: the
 * cached one while it lasts, else a refresh under the store's lock (a
 * rotating refresh token is redeemed once, and the rotated one saved).
 * `client-credentials` and `static` connectors have nothing to store.
 */
import { createHash, randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  OAuthHttpError,
  checkEndpoint,
  discoverAuthorizationServer,
  discoverResource,
  postForm,
  registerClient,
  tokenResponse,
  type AuthorizationServer,
  type FetchFn,
  type TokenResponse,
} from './oauthHttp.js';
import type {
  ConnectorAuth,
  CredentialStore,
  OAuthClient,
  StoredGrant,
} from './types.js';

/** Re-use a cached access token only while it has this long left. */
const DEFAULT_MIN_VALIDITY_MS = 5 * 60_000;
const CALLBACK_TIMEOUT_MS = 5 * 60_000;
const DEVICE_GRANT = 'urn:ietf:params:oauth:grant-type:device_code';

/**
 * One grant: the store key, the servers that share it, and how to sign in.
 * Built from one connector, or several with the same `grant`.
 */
export interface GrantTarget {
  /** The credential store key, e.g. `acme.google`. */
  key: string;
  /** For messages, e.g. `acme/google`. */
  name: string;
  auth: ConnectorAuth;
  /** The servers' endpoints (one for most grants; several for a shared one). */
  urls: readonly string[];
}

/** How a sign-in talks to the person signing in. */
export interface SignInIO {
  /** Show a line of output. Never receives a token. */
  print(line: string): void;
  /** Open a URL in a browser. */
  openUrl(url: string): Promise<void>;
}

export interface GrantOptions {
  fetch?: FetchFn;
  now?: () => number;
}

export type GrantState =
  | { state: 'none' }
  | { state: 'missing' }
  | { state: 'valid'; grant: StoredGrant; refreshable: boolean }
  | { state: 'plugin' };

function base64url(bytes: Buffer): string {
  return bytes.toString('base64url');
}

function scopesOf(
  auth: ConnectorAuth & { type: 'oauth' },
  advertised?: string[]
): string[] {
  const scopes = auth.scopes?.length
    ? [...auth.scopes]
    : [...(advertised ?? [])];
  const refresh =
    auth.refreshScope === undefined ? 'offline_access' : auth.refreshScope;
  if (refresh && !scopes.includes(refresh)) scopes.push(refresh);
  return scopes;
}

function expiresAt(now: number, token: TokenResponse): string | undefined {
  return token.expiresIn === undefined
    ? undefined
    : new Date(now + token.expiresIn * 1000).toISOString();
}

async function authorizationServer(
  target: GrantTarget,
  auth: ConnectorAuth & { type: 'oauth' },
  fetchFn: FetchFn
): Promise<{
  server: AuthorizationServer;
  advertised?: string[];
  resource?: string;
}> {
  const url = target.urls[0]!;
  const discovered = auth.issuer ? {} : await discoverResource(url, fetchFn);
  const issuer =
    auth.issuer ?? discovered.authorizationServer ?? new URL(url).origin;
  const server = await discoverAuthorizationServer(issuer, fetchFn);
  return {
    server,
    advertised: discovered.scopesSupported ?? server.scopesSupported,
    // A shared grant spans several servers: no single resource indicator.
    resource: target.urls.length === 1 ? url : undefined,
  };
}

/** A loopback callback server for the authorization-code redirect. */
async function callbackServer(
  port: number,
  state: string,
  timeoutMs: number
): Promise<{ redirectUri: string; code: Promise<string>; close(): void }> {
  let resolveCode!: (code: string) => void;
  let rejectCode!: (error: Error) => void;
  const code = new Promise<string>((resolve, reject) => {
    resolveCode = resolve;
    rejectCode = reject;
  });
  const server: Server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://localhost');
    if (url.pathname !== '/callback') {
      response.writeHead(404).end();
      return;
    }
    const ok =
      url.searchParams.get('state') === state && url.searchParams.has('code');
    response.writeHead(ok ? 200 : 400, { 'Content-Type': 'text/html' });
    response.end(
      ok
        ? '<html><body><h3>Signed in. You can close this tab.</h3></body></html>'
        : '<html><body><h3>Sign-in failed. Check the terminal.</h3></body></html>'
    );
    if (url.searchParams.get('state') !== state)
      rejectCode(new Error('OAuth state mismatch; sign-in aborted.'));
    else if (!url.searchParams.has('code'))
      rejectCode(
        new Error(
          `Sign-in failed: ${url.searchParams.get('error_description') ?? url.searchParams.get('error') ?? 'no code'}`
        )
      );
    else resolveCode(url.searchParams.get('code')!);
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve());
  });
  const timer = setTimeout(
    () => rejectCode(new Error('No sign-in callback within 5 minutes.')),
    timeoutMs
  );
  const actual = (server.address() as AddressInfo).port;
  return {
    // `localhost`, not 127.0.0.1: providers that pre-register the redirect URI
    // (Slack, Google) string-match it.
    redirectUri: `http://localhost:${actual}/callback`,
    code,
    close() {
      clearTimeout(timer);
      server.closeAllConnections();
      server.close();
    },
  };
}

async function authorizationCodeSignIn(
  target: GrantTarget,
  auth: ConnectorAuth & { type: 'oauth' },
  io: SignInIO,
  fetchFn: FetchFn,
  timeoutMs: number
): Promise<{
  token: TokenResponse;
  client: OAuthClient;
  server: AuthorizationServer;
  scopes: string[];
}> {
  const { server, advertised, resource } = await authorizationServer(
    target,
    auth,
    fetchFn
  );
  if (!server.authorizationEndpoint)
    throw new OAuthHttpError(
      `${target.name}: the authorization server has no authorization_endpoint.`
    );
  const state = base64url(randomBytes(24));
  const callback = await callbackServer(
    auth.redirectPort ?? 0,
    state,
    timeoutMs
  );
  try {
    let client: OAuthClient;
    if (auth.client) client = await auth.client();
    else if (server.registrationEndpoint)
      client = {
        clientId: await registerClient(
          server.registrationEndpoint,
          callback.redirectUri,
          fetchFn
        ),
      };
    else
      throw new OAuthHttpError(
        `${target.name}: the server offers no client registration, so the connector must provide a client.`
      );
    const verifier = base64url(randomBytes(64));
    const challenge = base64url(createHash('sha256').update(verifier).digest());
    const scopes = scopesOf(auth, advertised);
    const url = new URL(server.authorizationEndpoint);
    const params: Record<string, string | undefined> = {
      response_type: 'code',
      client_id: client.clientId,
      redirect_uri: callback.redirectUri,
      state,
      code_challenge: challenge,
      code_challenge_method: 'S256',
      resource,
      scope: scopes.length ? scopes.join(' ') : undefined,
      ...auth.authorizationParams,
    };
    for (const [name, value] of Object.entries(params))
      if (value !== undefined) url.searchParams.set(name, value);
    io.print(`${target.name}: opening the browser to sign in…`);
    io.print(`  If it does not open, visit: ${url.toString()}`);
    await io.openUrl(url.toString()).catch(() => {});
    const code = await callback.code;
    const token = tokenResponse(
      await postForm(
        server.tokenEndpoint,
        {
          grant_type: 'authorization_code',
          code,
          redirect_uri: callback.redirectUri,
          client_id: client.clientId,
          client_secret: client.clientSecret,
          code_verifier: verifier,
          resource,
        },
        fetchFn
      ),
      new URL(server.tokenEndpoint).origin
    );
    return { token, client, server, scopes };
  } finally {
    callback.close();
  }
}

async function deviceSignIn(
  target: GrantTarget,
  auth: ConnectorAuth & { type: 'oauth' },
  io: SignInIO,
  fetchFn: FetchFn,
  sleep: (ms: number) => Promise<void>
): Promise<{
  token: TokenResponse;
  client: OAuthClient;
  server: AuthorizationServer;
  scopes: string[];
}> {
  const { server } = await authorizationServer(target, auth, fetchFn);
  if (!server.deviceAuthorizationEndpoint)
    throw new OAuthHttpError(
      `${target.name}: the authorization server has no device_authorization_endpoint.`
    );
  if (!auth.client)
    throw new OAuthHttpError(
      `${target.name}: device sign-in needs a registered client.`
    );
  const client = await auth.client();
  const scopes = scopesOf(auth);
  const device = await postForm(
    server.deviceAuthorizationEndpoint,
    {
      client_id: client.clientId,
      scope: scopes.length ? scopes.join(' ') : undefined,
    },
    fetchFn
  );
  const userCode = typeof device.user_code === 'string' ? device.user_code : '';
  const verification = checkEndpoint(
    device.verification_uri_complete ?? device.verification_uri,
    'verification_uri'
  );
  if (typeof device.device_code !== 'string' || !userCode)
    throw new OAuthHttpError(
      `${target.name}: the device authorization response is incomplete.`
    );
  io.print(
    `${target.name}: visit ${typeof device.verification_uri === 'string' ? device.verification_uri : verification} and enter code ${userCode}`
  );
  await io.openUrl(verification).catch(() => {});
  let interval = Number(device.interval ?? 5) * 1000;
  const deadline = Date.now() + Number(device.expires_in ?? 900) * 1000;
  while (Date.now() < deadline) {
    await sleep(interval);
    const body = await postForm(
      server.tokenEndpoint,
      {
        grant_type: DEVICE_GRANT,
        device_code: device.device_code,
        client_id: client.clientId,
        client_secret: client.clientSecret,
      },
      fetchFn
    ).catch((error: unknown) => {
      // RFC 8628 errors come as 400s; GitHub sends them as 200s.
      if (error instanceof OAuthHttpError && error.oauthError)
        return { error: error.oauthError } as Record<string, unknown>;
      throw error;
    });
    if (body.error === 'authorization_pending') continue;
    if (body.error === 'slow_down') {
      interval += 5000;
      continue;
    }
    return {
      token: tokenResponse(body, new URL(server.tokenEndpoint).origin),
      client,
      server,
      scopes,
    };
  }
  throw new OAuthHttpError(
    `${target.name}: the device code expired before sign-in finished.`
  );
}

/** Sign in interactively and store the grant. Replaces (and revokes) an older one. */
export async function signIn(
  target: GrantTarget,
  store: CredentialStore,
  io: SignInIO,
  options: GrantOptions & {
    callbackTimeoutMs?: number;
    sleep?: (ms: number) => Promise<void>;
  } = {}
): Promise<StoredGrant> {
  const auth = target.auth;
  if (auth.type !== 'oauth')
    throw new Error(`${target.name}: ${auth.type} connectors do not sign in.`);
  const fetchFn = options.fetch ?? fetch;
  const now = options.now ?? Date.now;
  const result =
    auth.flow === 'device'
      ? await deviceSignIn(
          target,
          auth,
          io,
          fetchFn,
          options.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)))
        )
      : await authorizationCodeSignIn(
          target,
          auth,
          io,
          fetchFn,
          options.callbackTimeoutMs ?? CALLBACK_TIMEOUT_MS
        );
  const { token, client, server, scopes } = result;
  const grant: StoredGrant = {
    version: 1,
    type: token.refreshToken ? 'oauth' : 'token',
    tokenEndpoint: server.tokenEndpoint,
    revocationEndpoint: server.revocationEndpoint,
    clientId: client.clientId,
    refreshToken: token.refreshToken,
    accessToken: token.accessToken,
    accessTokenExpiresAt: expiresAt(now(), token),
    scopes: token.scope ? token.scope.split(/[\s,]+/).filter(Boolean) : scopes,
    resource: target.urls.join(' '),
    signedInAt: new Date(now()).toISOString(),
  };
  if (grant.type === 'token' && grant.accessTokenExpiresAt)
    throw new OAuthHttpError(
      `${target.name}: the server issued a token that expires, but no refresh token. Check the connector's refresh scope.`
    );
  await store.withLock(target.key, async () => {
    const previous = await store.get(target.key);
    await store.put(target.key, grant);
    if (previous)
      await revokeStored(previous, target.auth, fetchFn).catch(() => {});
  });
  return grant;
}

/** What the store holds for a grant, without network calls. */
export async function grantState(
  target: GrantTarget,
  store: CredentialStore,
  options: GrantOptions = {}
): Promise<GrantState> {
  const auth = target.auth;
  if (auth.type === 'none') return { state: 'none' };
  if (auth.type !== 'oauth') return { state: 'plugin' };
  const grant = await store.get(target.key);
  if (!grant) return { state: 'missing' };
  if (grant.type === 'token') {
    const expired =
      grant.accessTokenExpiresAt !== undefined &&
      Date.parse(grant.accessTokenExpiresAt) <= (options.now ?? Date.now)();
    return expired
      ? { state: 'missing' }
      : { state: 'valid', grant, refreshable: false };
  }
  return { state: 'valid', grant, refreshable: true };
}

/** An access token for a run: the cached one while it lasts, else a refreshed one. */
export async function accessToken(
  target: GrantTarget,
  store: CredentialStore,
  options: GrantOptions & {
    /** The token must stay valid at least this long. Default 5 minutes. */
    minValidityMs?: number;
    /** Refresh even if the cached token would do. */
    force?: boolean;
  } = {}
): Promise<{ accessToken: string; expiresAt?: number }> {
  const auth = target.auth;
  const fetchFn = options.fetch ?? fetch;
  const now = options.now ?? Date.now;
  if (auth.type === 'none') throw new Error(`${target.name} has no auth.`);
  if (auth.type === 'static') {
    const token = (await auth.token()).trim();
    if (!token)
      throw new Error(`${target.name}: the connector returned an empty token.`);
    return { accessToken: token };
  }
  if (auth.type === 'client-credentials') {
    const client = await auth.client();
    const token = tokenResponse(
      await postForm(
        checkEndpoint(auth.tokenEndpoint, 'tokenEndpoint'),
        {
          grant_type: 'client_credentials',
          client_id: client.clientId,
          client_secret: client.clientSecret,
          scope: auth.scopes?.length ? auth.scopes.join(' ') : undefined,
        },
        fetchFn
      ),
      new URL(auth.tokenEndpoint).origin
    );
    return {
      accessToken: token.accessToken,
      expiresAt:
        token.expiresIn === undefined
          ? undefined
          : now() + token.expiresIn * 1000,
    };
  }
  const minValidity = options.minValidityMs ?? DEFAULT_MIN_VALIDITY_MS;
  return store.withLock(target.key, async () => {
    const grant = await store.get(target.key);
    if (!grant) throw new MissingGrantError(target);
    const cachedUntil = grant.accessTokenExpiresAt
      ? Date.parse(grant.accessTokenExpiresAt)
      : undefined;
    if (
      grant.accessToken &&
      !options.force &&
      (cachedUntil === undefined || cachedUntil - now() > minValidity)
    )
      return { accessToken: grant.accessToken, expiresAt: cachedUntil };
    if (grant.type === 'token' || !grant.refreshToken || !grant.tokenEndpoint)
      throw new MissingGrantError(target, 'expired');
    const client = auth.client ? await auth.client() : undefined;
    let token: TokenResponse;
    try {
      token = tokenResponse(
        await postForm(
          grant.tokenEndpoint,
          {
            grant_type: 'refresh_token',
            refresh_token: grant.refreshToken,
            client_id: grant.clientId ?? client?.clientId,
            client_secret: client?.clientSecret,
          },
          fetchFn
        ),
        new URL(grant.tokenEndpoint).origin
      );
    } catch (error) {
      if (
        error instanceof OAuthHttpError &&
        error.oauthError === 'invalid_grant'
      )
        throw new MissingGrantError(target, 'revoked');
      throw error;
    }
    const next: StoredGrant = {
      ...grant,
      // Rotating providers return a new refresh token; the old one is now spent.
      refreshToken: token.refreshToken ?? grant.refreshToken,
      accessToken: token.accessToken,
      accessTokenExpiresAt: expiresAt(now(), token),
    };
    await store.put(target.key, next);
    return {
      accessToken: token.accessToken,
      expiresAt: next.accessTokenExpiresAt
        ? Date.parse(next.accessTokenExpiresAt)
        : undefined,
    };
  });
}

async function revokeStored(
  grant: StoredGrant,
  auth: ConnectorAuth,
  fetchFn: FetchFn
): Promise<void> {
  if (!grant.revocationEndpoint) return;
  const token = grant.refreshToken ?? grant.accessToken;
  if (!token) return;
  const client =
    auth.type === 'oauth' && auth.client ? await auth.client() : undefined;
  await postForm(
    grant.revocationEndpoint,
    {
      token,
      token_type_hint: grant.refreshToken ? 'refresh_token' : 'access_token',
      client_id: grant.clientId ?? client?.clientId,
      client_secret: client?.clientSecret,
    },
    fetchFn
  );
}

/** Revoke the grant at its provider (when it can be) and delete it. */
export async function revokeGrant(
  target: GrantTarget,
  store: CredentialStore,
  options: GrantOptions = {}
): Promise<boolean> {
  return store.withLock(target.key, async () => {
    const grant = await store.get(target.key);
    if (!grant) return false;
    await revokeStored(grant, target.auth, options.fetch ?? fetch).catch(
      () => {}
    );
    await store.delete(target.key);
    return true;
  });
}

/** No usable grant: the person has to sign in (again). */
export class MissingGrantError extends Error {
  constructor(
    readonly target: GrantTarget,
    readonly reason: 'missing' | 'expired' | 'revoked' = 'missing'
  ) {
    super(
      reason === 'missing'
        ? `${target.name}: not signed in.`
        : reason === 'expired'
          ? `${target.name}: the sign-in expired.`
          : `${target.name}: the provider revoked the sign-in.`
    );
    this.name = 'MissingGrantError';
  }
}
