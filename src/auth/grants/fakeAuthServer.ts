/**
 * A fake OAuth authorization server for tests, reachable as a `fetch`
 * function. It implements what grants use (RFC 8414 metadata, RFC 9728
 * protected-resource metadata, DCR, authorization code with PKCE, device
 * code, refresh with rotation, client credentials, revocation) and records
 * every token request, so tests can check that a refresh token was redeemed
 * once.
 */
import { createHash, randomUUID } from 'node:crypto';

export interface FakeAuthServerOptions {
  origin?: string;
  /** Issue a new refresh token on every refresh, invalidating the old one. */
  rotate?: boolean;
  /** Seconds an access token lasts. */
  expiresIn?: number;
  /** Answer token errors as 200 `{ ok: false }`, as Slack does. */
  slackStyleErrors?: boolean;
  /** Device-code polls that answer `authorization_pending` before success. */
  pendingPolls?: number;
  /** Issue no refresh token (GitHub-style long-lived token). */
  noRefreshToken?: boolean;
  /** Require this client secret at the token endpoint. */
  clientSecret?: string;
  /** Publish protected-resource metadata. Default true. */
  resourceMetadata?: boolean;
}

export interface FakeAuthServer {
  origin: string;
  fetch: (
    input: string | URL | Request,
    init?: RequestInit
  ) => Promise<Response>;
  /** Grants the token endpoint has seen, in order. */
  tokenRequests: Array<Record<string, string>>;
  /** Tokens the revocation endpoint has seen. */
  revoked: string[];
  /** Registered client IDs. */
  registered: string[];
  /** The authorization request the "browser" made, if any. */
  lastAuthorization?: URL;
  /** Act as the person approving: follow the authorization URL to the redirect. */
  approve(authorizationUrl: string): Promise<void>;
  /** The access tokens issued and still valid. */
  validAccessTokens: Set<string>;
  /** Revoke every refresh token now (as a provider does when consent is withdrawn). */
  revokeAll(): void;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

export function fakeAuthServer(
  options: FakeAuthServerOptions = {}
): FakeAuthServer {
  const origin = options.origin ?? 'https://auth.example';
  const codes = new Map<
    string,
    { clientId: string; challenge: string; redirectUri: string; scope: string }
  >();
  const refreshTokens = new Set<string>();
  const devices = new Map<string, { polls: number }>();
  const validAccessTokens = new Set<string>();
  const server: FakeAuthServer = {
    origin,
    tokenRequests: [],
    revoked: [],
    registered: [],
    validAccessTokens,
    revokeAll() {
      refreshTokens.clear();
    },
    async approve(authorizationUrl) {
      const url = new URL(authorizationUrl);
      server.lastAuthorization = url;
      const code = randomUUID();
      codes.set(code, {
        clientId: url.searchParams.get('client_id') ?? '',
        challenge: url.searchParams.get('code_challenge') ?? '',
        redirectUri: url.searchParams.get('redirect_uri') ?? '',
        scope: url.searchParams.get('scope') ?? '',
      });
      const redirect = new URL(url.searchParams.get('redirect_uri')!);
      redirect.searchParams.set('code', code);
      redirect.searchParams.set('state', url.searchParams.get('state') ?? '');
      // The redirect goes to the real loopback callback server.
      redirect.hostname = '127.0.0.1';
      await fetch(redirect);
    },
    fetch: async (input, init) => {
      const request = new Request(input, init);
      const url = new URL(request.url);
      if (
        url.origin !== origin &&
        !url.pathname.startsWith('/.well-known/oauth-protected-resource')
      )
        return new Response('not found', { status: 404 });
      const error = (code: string, status = 400) =>
        options.slackStyleErrors
          ? json({ ok: false, error: code })
          : json({ error: code }, status);

      if (url.pathname.startsWith('/.well-known/oauth-protected-resource')) {
        if (options.resourceMetadata === false)
          return new Response('', { status: 404 });
        return json({
          resource: `${url.origin}/mcp`,
          authorization_servers: [origin],
          scopes_supported: ['read', 'write'],
        });
      }
      if (request.method === 'POST' && url.pathname === '/mcp')
        return new Response('', { status: 401 });
      if (url.pathname === '/.well-known/oauth-authorization-server')
        return json({
          issuer: origin,
          authorization_endpoint: `${origin}/authorize`,
          token_endpoint: `${origin}/token`,
          registration_endpoint: `${origin}/register`,
          device_authorization_endpoint: `${origin}/device`,
          revocation_endpoint: `${origin}/revoke`,
          scopes_supported: ['read', 'write', 'offline_access'],
        });
      if (url.pathname === '/register') {
        const clientId = `client-${server.registered.length + 1}`;
        server.registered.push(clientId);
        return json({ client_id: clientId }, 201);
      }
      const form = Object.fromEntries(
        new URLSearchParams(await request.text())
      );
      if (url.pathname === '/device') {
        const deviceCode = randomUUID();
        devices.set(deviceCode, { polls: 0 });
        return json({
          device_code: deviceCode,
          user_code: 'ABCD-1234',
          verification_uri: `${origin}/activate`,
          interval: 0,
          expires_in: 60,
        });
      }
      if (url.pathname === '/revoke') {
        server.revoked.push(form.token ?? '');
        refreshTokens.delete(form.token ?? '');
        return new Response('', { status: 200 });
      }
      if (url.pathname !== '/token')
        return new Response('not found', { status: 404 });
      server.tokenRequests.push(form);
      if (
        options.clientSecret &&
        form.grant_type !== 'client_credentials' &&
        form.client_secret !== options.clientSecret
      )
        return error('invalid_client', 401);
      const issue = (scope?: string) => {
        const accessToken = `access-${randomUUID()}`;
        validAccessTokens.add(accessToken);
        const refresh = options.noRefreshToken
          ? undefined
          : `refresh-${randomUUID()}`;
        if (refresh) refreshTokens.add(refresh);
        return json({
          access_token: accessToken,
          token_type: 'Bearer',
          ...(options.noRefreshToken
            ? {}
            : { expires_in: options.expiresIn ?? 3600 }),
          ...(refresh ? { refresh_token: refresh } : {}),
          ...(scope ? { scope } : {}),
        });
      };
      switch (form.grant_type) {
        case 'authorization_code': {
          const code = codes.get(form.code ?? '');
          codes.delete(form.code ?? '');
          if (
            !code ||
            code.clientId !== form.client_id ||
            code.redirectUri !== form.redirect_uri
          )
            return error('invalid_grant');
          const challenge = createHash('sha256')
            .update(form.code_verifier ?? '')
            .digest('base64url');
          if (challenge !== code.challenge) return error('invalid_grant');
          return issue(code.scope);
        }
        case 'refresh_token': {
          if (!refreshTokens.has(form.refresh_token ?? ''))
            return error('invalid_grant');
          if (options.rotate) refreshTokens.delete(form.refresh_token!);
          const accessToken = `access-${randomUUID()}`;
          validAccessTokens.add(accessToken);
          const next = options.rotate ? `refresh-${randomUUID()}` : undefined;
          if (next) refreshTokens.add(next);
          return json({
            access_token: accessToken,
            token_type: 'Bearer',
            expires_in: options.expiresIn ?? 3600,
            ...(next ? { refresh_token: next } : {}),
          });
        }
        case 'urn:ietf:params:oauth:grant-type:device_code': {
          const device = devices.get(form.device_code ?? '');
          if (!device) return error('expired_token');
          if (device.polls++ < (options.pendingPolls ?? 0))
            // GitHub answers pending polls with 200.
            return json({ error: 'authorization_pending' });
          return issue();
        }
        case 'client_credentials':
          if (form.client_secret !== 'cc-secret')
            return error('invalid_client', 401);
          return json({
            access_token: `cc-${randomUUID()}`,
            token_type: 'Bearer',
            expires_in: 600,
          });
        default:
          return error('unsupported_grant_type');
      }
    },
  };
  return server;
}
