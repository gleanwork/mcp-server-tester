# Authentication Guide

This guide covers authentication options for testing MCP servers that require authorization.

## Table of Contents

- [Overview](#overview)
- [Static Token Authentication](#static-token-authentication)
- [OAuth 2.1 Authentication](#oauth-21-authentication)
- [Client Credentials Grant](#client-credentials-grant)
- [Playwright Global Setup for OAuth](#playwright-global-setup-for-oauth)
- [GitHub Actions CI/CD](#github-actions-cicd)
- [API Reference](#api-reference)
- [Troubleshooting](#troubleshooting)

## Overview

`@gleanwork/mcp-server-tester` supports three authentication modes:

| Mode                   | Use Case                                           | Setup Complexity |
| ---------------------- | -------------------------------------------------- | ---------------- |
| **Static Token**       | Pre-acquired API tokens, service accounts          | Simple           |
| **OAuth 2.1**          | Full OAuth flow with PKCE and optional DCR         | Advanced         |
| **Client Credentials** | Machine-to-machine (CI/CD), no browser interaction | Moderate         |

Choose based on your server's authentication requirements:

- **Static Token**: Use when you have a pre-issued API key or service account token
- **OAuth 2.1**: Use when the server requires OAuth authentication with a user login step
- **Client Credentials**: Use when running in CI/CD or as a service and the server accepts OAuth 2.1 client credentials tokens

## Static Token Authentication

The simplest authentication method - pass a pre-acquired token directly.

### Basic Configuration

```typescript
// playwright.config.ts
import { defineConfig } from '@playwright/test';

export default defineConfig({
  projects: [
    {
      name: 'mcp-authenticated',
      use: {
        mcpConfig: {
          transport: 'http',
          serverUrl: 'https://api.example.com/mcp',
          auth: {
            accessToken: process.env.MCP_ACCESS_TOKEN,
          },
        },
      },
    },
  ],
});
```

### Using Headers Directly

For simple cases, you can also pass the token as a header:

```typescript
mcpConfig: {
  transport: 'http',
  serverUrl: 'https://api.example.com/mcp',
  headers: {
    Authorization: `Bearer ${process.env.MCP_ACCESS_TOKEN}`,
  },
}
```

### Token Utilities

The library provides utilities for working with tokens:

```typescript
import {
  createTokenAuthHeaders,
  validateAccessToken,
  isTokenExpired,
  isTokenExpiringSoon,
} from '@gleanwork/mcp-server-tester';

// Create auth headers
const headers = createTokenAuthHeaders(process.env.MCP_ACCESS_TOKEN);
// => { Authorization: 'Bearer eyJ...' }

// Validate token is present
validateAccessToken(process.env.MCP_ACCESS_TOKEN);
// Throws if token is missing or empty

// Check JWT expiration (best-effort)
if (isTokenExpired(token)) {
  console.log('Token has expired');
}

// Check if token expires within buffer time
if (isTokenExpiringSoon(expiresAt, 60000)) {
  console.log('Token expires within 1 minute');
}
```

### Environment Variables

Create a `.env` file for local development:

```bash
# .env
MCP_ACCESS_TOKEN=your-api-token-here
```

Load with dotenv:

```typescript
// playwright.config.ts
import * as dotenv from 'dotenv';
dotenv.config();
```

## OAuth 2.1 Authentication

For servers requiring full OAuth authentication with user login flow.

### How It Works

The OAuth flow follows Playwright's recommended auth state pattern:

1. **Global Setup** (runs once): Launches browser, completes OAuth login, saves tokens to disk
2. **Tests** (run many times): Load saved tokens from disk, authenticate automatically

```
┌─────────────────────────────────────────────────────────────────┐
│  Global Setup (once per test run)                               │
│  ┌─────────────┐    ┌──────────────┐    ┌───────────────────┐  │
│  │ Discover    │───▶│ Browser      │───▶│ Save Tokens       │  │
│  │ OAuth       │    │ Login Flow   │    │ to Disk           │  │
│  │ Metadata    │    │              │    │                   │  │
│  └─────────────┘    └──────────────┘    └───────────────────┘  │
└─────────────────────────────────────────────────────────────────┘
                                                    │
                                                    ▼
┌─────────────────────────────────────────────────────────────────┐
│  Test Execution (many tests)                                    │
│  ┌─────────────┐    ┌──────────────┐    ┌───────────────────┐  │
│  │ Load Tokens │───▶│ Create MCP   │───▶│ Run Tests         │  │
│  │ from Disk   │    │ Client       │    │                   │  │
│  └─────────────┘    └──────────────┘    └───────────────────┘  │
└─────────────────────────────────────────────────────────────────┘
```

### Configuration

```typescript
// playwright.config.ts
import { defineConfig } from '@playwright/test';

export default defineConfig({
  globalSetup: './global-setup.ts',
  projects: [
    {
      name: 'mcp-oauth',
      use: {
        mcpConfig: {
          transport: 'http',
          serverUrl: 'https://api.example.com/mcp',
          auth: {
            oauth: {
              serverUrl: 'https://auth.example.com',
              scopes: ['mcp:read', 'mcp:write'],
              authStatePath: 'playwright/.auth/mcp-oauth-state.json',
              redirectUri: 'http://localhost:3000/oauth/callback',
              // Optional: pre-registered client
              clientId: process.env.MCP_OAUTH_CLIENT_ID,
              clientSecret: process.env.MCP_OAUTH_CLIENT_SECRET,
            },
          },
        },
      },
    },
  ],
});
```

### OAuth Configuration Options

```typescript
interface MCPOAuthConfig {
  /** OAuth authorization server URL */
  serverUrl: string;

  /** Requested OAuth scopes */
  scopes?: string[];

  /** Resource indicator (RFC 8707) - required by MCP 2025-06-18 spec */
  resource?: string;

  /** Path to store auth state (tokens, client info) */
  authStatePath?: string;

  /** OAuth redirect URI for callback */
  redirectUri?: string;

  /** Pre-registered client ID (optional if using DCR) */
  clientId?: string;

  /** Pre-registered client secret (optional) */
  clientSecret?: string;
}
```

## Client Credentials Grant

The client credentials grant (OAuth 2.1, RFC 6749 §4.4) is designed for machine-to-machine communication. The library fetches a token from the authorization server's token endpoint before connecting to the MCP server, then attaches it as a `Bearer` token on every request. There is no browser, no redirect, and no user interaction.

### When to use it

- Running tests in CI/CD pipelines where no browser is available
- Authenticating as a service account or bot identity rather than a human user
- The MCP server accepts tokens issued by an OAuth authorization server, and you hold a registered client ID and secret
- You want credentials managed through environment variables without modifying `playwright.config.ts`

If you already have a token in hand (from a secrets store or a separate provisioning step), use `auth.accessToken` instead — it is simpler. If the server requires a user to log in interactively, use `auth.oauth` instead.

### Configuration

```typescript snippet=snippets/auth-client-credentials.ts
import { defineConfig } from '@playwright/test';
import type { MCPClientCredentialsConfig } from '@gleanwork/mcp-server-tester';

const clientCredentials: MCPClientCredentialsConfig = {
  // clientId and clientSecret can be omitted when MCP_CLIENT_ID / MCP_CLIENT_SECRET
  // environment variables are set. Provide them here to override the env vars.
  clientId: process.env.MCP_CLIENT_ID,
  clientSecret: process.env.MCP_CLIENT_SECRET,
  tokenEndpoint: 'https://auth.example.com/oauth/token',
  scopes: ['mcp:read', 'mcp:write'],
};

export default defineConfig({
  projects: [
    {
      name: 'mcp-client-credentials',
      use: {
        mcpConfig: {
          transport: 'http',
          serverUrl: 'https://api.example.com/mcp',
          auth: {
            clientCredentials,
          },
        },
      },
    },
  ],
});
```

### Configuration fields

| Field           | Type       | Required | Description                                                      |
| --------------- | ---------- | -------- | ---------------------------------------------------------------- |
| `tokenEndpoint` | `string`   | Yes      | Full URL of the OAuth token endpoint (e.g. `.../oauth/token`)    |
| `clientId`      | `string`   | No\*     | OAuth client ID. Falls back to `MCP_CLIENT_ID` env var           |
| `clientSecret`  | `string`   | No\*     | OAuth client secret. Falls back to `MCP_CLIENT_SECRET` env var   |
| `scopes`        | `string[]` | No       | Scopes to request. Omit to use the server's default grant scopes |

\* `clientId` and `clientSecret` are optional in the config object but **one of the two sources must supply a value at runtime** — either the config field or the corresponding environment variable. If either value is missing when the client connects, an error is thrown.

### Environment variable fallbacks

The client factory resolves credentials at connection time using this precedence:

1. Value set directly in `auth.clientCredentials` (`clientId`, `clientSecret`)
2. `MCP_CLIENT_ID` / `MCP_CLIENT_SECRET` environment variables

This means you can keep `playwright.config.ts` free of secrets and supply credentials only through environment variables:

```bash
# .env or CI environment
MCP_CLIENT_ID=my-service-client
MCP_CLIENT_SECRET=s3cr3t
```

```typescript
// playwright.config.ts — no secrets in source
auth: {
  clientCredentials: {
    tokenEndpoint: 'https://auth.example.com/oauth/token',
    scopes: ['mcp:read'],
  },
}
```

The library uses `client_secret_basic` authentication (credentials in the `Authorization: Basic` header per RFC 6749 §2.3.1) rather than placing the secret in the request body.

### Choosing between auth modes

| Scenario                                            | Recommended mode         |
| --------------------------------------------------- | ------------------------ |
| You have a pre-issued API key or bearer token       | `auth.accessToken`       |
| A human must log in via browser during test setup   | `auth.oauth`             |
| CI/CD pipeline, service account, no browser         | `auth.clientCredentials` |
| Token is managed externally and injected at runtime | `auth.accessToken`       |
| Server supports OAuth but issues long-lived tokens  | `auth.accessToken`       |
| Server issues short-lived tokens requiring refresh  | `auth.clientCredentials` |

`auth.clientCredentials` sits between the other two in terms of setup cost: it requires a registered OAuth client (client ID and secret) and a reachable token endpoint, but it needs no browser automation, no auth state file, and no global setup step.

## Playwright Global Setup for OAuth

Create a global setup file to perform the OAuth flow before tests run.

### Basic Setup

```typescript
// global-setup.ts
import { chromium } from '@playwright/test';
import {
  performOAuthSetupIfNeeded,
  type OAuthSetupConfig,
} from '@gleanwork/mcp-server-tester';

export default async function globalSetup() {
  const config: OAuthSetupConfig = {
    // OAuth server
    authServerUrl: 'https://auth.example.com',
    scopes: ['mcp:read', 'mcp:write'],
    redirectUri: 'http://localhost:3000/oauth/callback',

    // Login form selectors (customize for your IdP)
    loginSelectors: {
      usernameInput: '#username',
      passwordInput: '#password',
      submitButton: 'button[type="submit"]',
      // Optional: consent screen button
      consentButton: '#authorize-button',
    },

    // Test credentials
    credentials: {
      username: process.env.TEST_USERNAME!,
      password: process.env.TEST_PASSWORD!,
    },

    // Where to save tokens
    outputPath: 'playwright/.auth/mcp-oauth-state.json',

    // Optional: pre-registered client credentials
    clientId: process.env.MCP_OAUTH_CLIENT_ID,
    clientSecret: process.env.MCP_OAUTH_CLIENT_SECRET,

    // Optional: resource indicator
    resource: 'https://api.example.com/mcp',

    // Browser options
    headless: true,
    timeout: 30000,
  };

  await performOAuthSetupIfNeeded(config);
}
```

### Custom Login Flow

For complex login flows (MFA, custom consent screens), use `PlaywrightOAuthClientProvider` in a `globalSetup` and automate the browser interaction with Playwright. `PlaywrightOAuthClientProvider` handles PKCE, state management, token exchange, and storage — you only need to automate the IdP-specific UI steps.

```typescript snippet=snippets/auth-playwright-oauth-provider.ts
import { chromium } from '@playwright/test';
import { PlaywrightOAuthClientProvider } from '@gleanwork/mcp-server-tester';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';

export default async function globalSetup() {
  const provider = new PlaywrightOAuthClientProvider({
    storagePath: 'playwright/.auth/mcp-oauth-state.json',
    redirectUri: 'http://localhost:3000/oauth/callback',
    clientId: process.env.MCP_OAUTH_CLIENT_ID,
    clientSecret: process.env.MCP_OAUTH_CLIENT_SECRET,
  });

  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();

  // Automate your IdP's login UI to acquire OAuth tokens.
  // The provider handles PKCE, state management, token exchange, and storage.
  await page.goto('https://auth.example.com/login');
  await page.fill('#username', process.env.TEST_USERNAME!);
  await page.fill('#password', process.env.TEST_PASSWORD!);
  await page.click('#submit-button');

  if (await page.isVisible('#mfa-input')) {
    await page.fill('#mfa-input', process.env.TEST_MFA_CODE!);
    await page.click('#verify-mfa');
  }

  if (await page.isVisible('#consent-form')) {
    await page.click('#authorize-button');
  }

  await browser.close();

  // Use the provider as the authProvider for StreamableHTTPClientTransport
  const serverUrl = new URL('https://api.example.com/mcp');
  const transport = new StreamableHTTPClientTransport(serverUrl, {
    authProvider: provider,
  });

  const client = new Client({ name: 'test-client', version: '1.0.0' });
  await client.connect(transport);
  await client.close();
}
```

### Gitignore Auth State

Add the auth state file to `.gitignore`:

```bash
# .gitignore
playwright/.auth/
```

## GitHub Actions CI/CD

### Testing with Static Tokens

```yaml
# .github/workflows/test.yml
name: MCP Server Tests

on: [push, pull_request]

jobs:
  test-with-token:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - uses: actions/setup-node@v4
        with:
          node-version: '22'

      - run: npm ci
      - run: npx playwright install --with-deps

      - name: Run MCP tests
        run: npx playwright test
        env:
          MCP_ACCESS_TOKEN: ${{ secrets.MCP_ACCESS_TOKEN }}
```

### Testing with OAuth

```yaml
# .github/workflows/test-oauth.yml
name: MCP OAuth Tests

on: [push, pull_request]

jobs:
  test-with-oauth:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - uses: actions/setup-node@v4
        with:
          node-version: '22'

      - run: npm ci
      - run: npx playwright install --with-deps

      - name: Run MCP tests with OAuth
        run: npx playwright test
        env:
          # OAuth client credentials
          MCP_OAUTH_CLIENT_ID: ${{ secrets.MCP_OAUTH_CLIENT_ID }}
          MCP_OAUTH_CLIENT_SECRET: ${{ secrets.MCP_OAUTH_CLIENT_SECRET }}
          # Test user credentials for login
          TEST_USERNAME: ${{ secrets.TEST_USERNAME }}
          TEST_PASSWORD: ${{ secrets.TEST_PASSWORD }}
          # Optional: MFA code (for TOTP, use a generator action)
          # TEST_MFA_CODE: ${{ steps.totp.outputs.code }}
```

### Testing Both Modes

```yaml
# .github/workflows/test-matrix.yml
name: MCP Server Tests - All Auth Modes

on: [push, pull_request]

jobs:
  test:
    runs-on: ubuntu-latest
    strategy:
      matrix:
        auth-mode: [token, oauth]

    steps:
      - uses: actions/checkout@v4

      - uses: actions/setup-node@v4
        with:
          node-version: '22'

      - run: npm ci
      - run: npx playwright install --with-deps

      - name: Run tests with token auth
        if: matrix.auth-mode == 'token'
        run: npx playwright test --project=token-auth
        env:
          MCP_ACCESS_TOKEN: ${{ secrets.MCP_ACCESS_TOKEN }}

      - name: Run tests with OAuth
        if: matrix.auth-mode == 'oauth'
        run: npx playwright test --project=oauth-auth
        env:
          MCP_OAUTH_CLIENT_ID: ${{ secrets.MCP_OAUTH_CLIENT_ID }}
          MCP_OAUTH_CLIENT_SECRET: ${{ secrets.MCP_OAUTH_CLIENT_SECRET }}
          TEST_USERNAME: ${{ secrets.TEST_USERNAME }}
          TEST_PASSWORD: ${{ secrets.TEST_PASSWORD }}
```

### Playwright Config for Both Modes

```typescript
// playwright.config.ts
import { defineConfig } from '@playwright/test';
import * as dotenv from 'dotenv';
dotenv.config();

export default defineConfig({
  globalSetup: './global-setup.ts',
  projects: [
    // Token-based auth project
    {
      name: 'token-auth',
      use: {
        mcpConfig: {
          transport: 'http',
          serverUrl: process.env.MCP_SERVER_URL!,
          auth: {
            accessToken: process.env.MCP_ACCESS_TOKEN,
          },
        },
      },
    },

    // OAuth-based auth project
    {
      name: 'oauth-auth',
      use: {
        mcpConfig: {
          transport: 'http',
          serverUrl: process.env.MCP_SERVER_URL!,
          auth: {
            oauth: {
              serverUrl: process.env.MCP_OAUTH_SERVER_URL!,
              scopes: ['mcp:read', 'mcp:write'],
              authStatePath: 'playwright/.auth/mcp-oauth-state.json',
              clientId: process.env.MCP_OAUTH_CLIENT_ID,
              clientSecret: process.env.MCP_OAUTH_CLIENT_SECRET,
            },
          },
        },
      },
    },
  ],
});
```

## API Reference

### Auth Configuration Types

```typescript
import type {
  MCPAuthConfig,
  MCPOAuthConfig,
  StoredOAuthState,
  OAuthSetupConfig,
} from '@gleanwork/mcp-server-tester';
```

### OAuth Client Provider

```typescript snippet=snippets/auth-oauth-provider-transport.ts
import { PlaywrightOAuthClientProvider } from '@gleanwork/mcp-server-tester';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

// Create provider for MCP SDK
const provider = new PlaywrightOAuthClientProvider({
  storagePath: 'playwright/.auth/mcp-oauth-state.json',
  redirectUri: 'http://localhost:3000/oauth/callback',
  clientId: process.env.MCP_OAUTH_CLIENT_ID,
  clientSecret: process.env.MCP_OAUTH_CLIENT_SECRET,
});

// Use with StreamableHTTPClientTransport
const serverUrl = new URL('https://api.example.com/mcp');
const transport = new StreamableHTTPClientTransport(serverUrl, {
  authProvider: provider,
});

export { provider, transport };
```

### Auth Fixture

```typescript
import { test, expect } from '@gleanwork/mcp-server-tester/fixtures/mcpAuth';

test('uses auth provider from environment', async ({ mcpAuthProvider }) => {
  // mcpAuthProvider is automatically configured from env vars:
  // - MCP_ACCESS_TOKEN for static token
  // - MCP_OAUTH_* for OAuth
  expect(mcpAuthProvider).toBeDefined();
});
```

## Troubleshooting

### OAuth Discovery Fails

```
Error: Failed to fetch OAuth metadata from https://auth.example.com
```

**Solutions:**

- Verify the auth server URL is correct
- Check network connectivity
- Ensure the server exposes `/.well-known/oauth-authorization-server`

### Login Form Not Found

```
Error: Timeout waiting for selector #username
```

**Solutions:**

- Verify login selectors match your IdP's HTML
- Use browser DevTools to inspect the login page
- Check if the login page uses iframes (need to switch context)
- Enable `headless: false` to see the browser during setup

### Authorization Code Missing

```
Error: No authorization code in callback URL
```

**Solutions:**

- Check redirect URI matches exactly (including trailing slashes)
- Verify the OAuth client has the correct redirect URI registered
- Check for OAuth error in callback URL parameters

### Tokens Expired

```
Error: 401 Unauthorized - Token expired
```

**Solutions:**

- Delete `playwright/.auth/mcp-oauth-state.json` and re-run
- Implement token refresh using `refreshAccessToken()`
- Use `performOAuthSetupIfNeeded()` which checks expiration

### PKCE Verification Failed

```
Error: PKCE verification failed - invalid code_verifier
```

**Solutions:**

- Ensure the same `codeVerifier` is used for auth request and token exchange
- Check that `code_challenge_method` is set to `S256`
- Verify no URL encoding issues with the verifier

### State Mismatch

```
Error: OAuth state mismatch - possible CSRF attack
```

**Solutions:**

- Ensure the same state parameter is used throughout the flow
- Check for session/cookie issues
- Verify no browser caching problems

### Debug Logging

Enable debug logging to see MCP protocol messages:

```bash
# Enable debug logging via environment variable
DEBUG=mcp-server-tester:* npm test

# Or just OAuth logs
DEBUG=mcp-server-tester:oauth npm test

# Or just client connection logs
DEBUG=mcp-server-tester:client npm test
```

### Common IdP Selector Examples

**Okta:**

```typescript
loginSelectors: {
  usernameInput: '#okta-signin-username',
  passwordInput: '#okta-signin-password',
  submitButton: '#okta-signin-submit',
}
```

**Auth0:**

```typescript
loginSelectors: {
  usernameInput: 'input[name="email"]',
  passwordInput: 'input[name="password"]',
  submitButton: 'button[type="submit"]',
}
```

**Azure AD:**

```typescript
loginSelectors: {
  usernameInput: 'input[name="loginfmt"]',
  passwordInput: 'input[name="passwd"]',
  submitButton: 'input[type="submit"]',
}
```

**Google:**

```typescript
loginSelectors: {
  usernameInput: 'input[type="email"]',
  passwordInput: 'input[type="password"]',
  submitButton: '#passwordNext',
}
```

## Extending OAuth Test Fixtures

When you need to add custom test fixtures on top of the auth-aware `mcpAuthTest`, import it from the top-level package and extend it:

```typescript
import { mcpAuthTest as base } from '@gleanwork/mcp-server-tester';

export const test = base.extend<{ myFixture: MyType }>({
  myFixture: async ({ mcp }, use) => {
    // mcp is already auth-configured
    await use(createMyFixture(mcp));
  },
});
```

**When to use `mcpAuthTest` vs `test`:**

- Use the regular `test` (imported from `@gleanwork/mcp-server-tester`) when your server uses static token auth, no auth, or client credentials — these are configured directly in `playwright.config.ts` via the `mcpConfig.auth` field.
- Use `mcpAuthTest` when your server uses interactive OAuth (browser-based) and you need the full OAuth fixture context — it is pre-configured to load the stored OAuth state from your `authStatePath`.

## Next Steps

- See [Transport Configuration](./transports.md) for server connection options
- Check [Quick Start Guide](./quickstart.md) for basic setup
- Explore [Examples](../examples) for real-world configurations
