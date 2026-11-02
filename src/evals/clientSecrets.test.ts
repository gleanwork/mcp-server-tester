import { describe, expect, it } from 'vitest';
import {
  clientSecretValues,
  isCredentialName,
  namedSecretValues,
  redactClientError,
  redactClientSecrets,
  redactedClientRun,
} from './clientSecrets.js';

describe('clientSecretValues', () => {
  it('collects credential-like env values and resolved MCP credentials', () => {
    const secrets = clientSecretValues(
      {
        OPENAI_API_KEY: 'env-api-key',
        ACME_TOKEN: 'stdio-token',
        HOME: '/Users/someone',
      },
      [
        {
          transport: 'http',
          serverUrl: 'https://example.test/mcp',
          auth: { accessToken: 'http-token' },
          headers: {
            'X-Api-Key': 'header-value',
            Cookie: 'session=cookie-value',
            // Not credentials: rewriting them would garble every trace.
            Accept: 'application/json',
            'X-Tenant': 'acme-production',
          },
        },
        {
          transport: 'stdio',
          command: 'server',
          auth: { accessTokenEnv: 'ACME_TOKEN' },
        },
      ],
      ['extra-secret']
    );
    expect(new Set(secrets)).toEqual(
      new Set([
        'env-api-key',
        'stdio-token',
        'http-token',
        'header-value',
        'session=cookie-value',
        'extra-secret',
      ])
    );
  });

  it('counts a value as a secret by a credential name, from 8 characters', () => {
    expect(
      namedSecretValues({
        ACME_PAT: 'pat-12345678',
        GLEAN_AUTH: 'auth-12345678',
        'X-Session-Cookie': 'cookie-12345678',
        SERVICE_CREDENTIALS: 'cred-12345678',
        // Settings: their values stay in the traces graders read.
        OPENAI_BASE_URL: 'https://gateway.example.test',
        GLEAN_INSTANCE: 'acme-prod',
        PATH: '/usr/local/bin:/usr/bin',
        // Named as a credential, but too short to tell from a setting.
        MODE_KEY: 'enabled',
      })
    ).toEqual([
      'pat-12345678',
      'auth-12345678',
      'cookie-12345678',
      'cred-12345678',
    ]);
  });

  it('ignores empty and short values that would garble messages', () => {
    expect(
      clientSecretValues(
        { SOME_TOKEN: '', FLAG_KEY: '1', MODE_KEY: 'true', PORT_KEY: '8080' },
        [],
        ['ab']
      )
    ).toEqual([]);
  });

  it('keeps a short credential it is given, but not a short env value it guesses at', () => {
    expect(
      clientSecretValues({ MODE_KEY: 'enabled' }, [], ['tok-123'])
    ).toEqual(['tok-123']);
  });
});

describe('isCredentialName', () => {
  it.each([
    'ACME_API_KEY',
    'GITHUB_TOKEN',
    'GITHUB_PAT',
    'GLEAN_AUTH',
    'NPM_AUTH_TOKEN',
    'DB_PASSWORD',
    'SESSION_COOKIE',
    'GOOGLE_APPLICATION_CREDENTIALS',
    'APIKEY',
    'Authorization',
    'X-Api-Key',
    'accessToken',
    'OAuthToken',
  ])('%s names a credential', (name) => {
    expect(isCredentialName(name)).toBe(true);
  });

  it.each([
    'OPENAI_BASE_URL',
    'MCP_OAUTH_SERVER_URL',
    'GIT_AUTHOR_NAME',
    'AUTH0_DOMAIN',
    'KEYCLOAK_URL',
    'MST_TOKENS_DIR',
    'MONKEY_NAME',
    'ACME_INSTANCE',
    'PATH',
    'Accept',
    // One word: name a credential with its own part, such as GITHUB_TOKEN.
    'GITHUBTOKEN',
  ])('%s names a setting', (name) => {
    expect(isCredentialName(name)).toBe(false);
  });
});

describe('redactClientSecrets', () => {
  it('replaces every occurrence, longest secret first', () => {
    expect(
      redactClientSecrets('a abcdefghij b abcdefgh c abcdefghij', [
        'abcdefgh',
        'abcdefghij',
      ])
    ).toBe('a [REDACTED] b [REDACTED] c [REDACTED]');
  });

  it('leaves values shorter than a credential alone', () => {
    expect(redactClientSecrets('a b c', ['a', 'abc'])).toBe('a b c');
  });
});

describe('redactedClientRun', () => {
  it('redacts every string in the result, telemetry and ending included', () => {
    const secret = 'sk-live-0123456789';
    const result = {
      finalText: `the key is ${secret}`,
      events: [{ kind: 'tool_call', name: 'get', arguments: { auth: secret } }],
      telemetry: {
        count: 3,
        content: { conversationHistory: [{ role: 'user', content: secret }] },
        warnings: [`retry with ${secret}`],
      },
      error: `401 for ${secret}`,
      ending: {
        kind: 'infrastructure',
        broke: 'provider',
        retryable: false,
        reason: `rejected ${secret}`,
      },
    };
    const redacted = redactedClientRun(result, [secret]);
    expect(JSON.stringify(redacted)).not.toContain(secret);
    expect(redacted).toEqual({
      finalText: 'the key is [REDACTED]',
      events: [
        { kind: 'tool_call', name: 'get', arguments: { auth: '[REDACTED]' } },
      ],
      telemetry: {
        count: 3,
        content: {
          conversationHistory: [{ role: 'user', content: '[REDACTED]' }],
        },
        warnings: ['retry with [REDACTED]'],
      },
      error: '401 for [REDACTED]',
      ending: {
        kind: 'infrastructure',
        broke: 'provider',
        retryable: false,
        reason: 'rejected [REDACTED]',
      },
    });
    // The client's own result is not changed.
    expect(result.finalText).toContain(secret);
  });

  it('keeps artifact paths, which name files rather than content', () => {
    const secret = 'secret-in-path';
    const result = redactedClientRun(
      {
        finalText: secret,
        artifacts: { dir: `/tmp/${secret}` },
        response: { artifacts: { dir: `/tmp/${secret}` } },
        events: [{ artifacts: secret }],
      },
      [secret]
    );
    expect(result).toEqual({
      finalText: '[REDACTED]',
      artifacts: { dir: `/tmp/${secret}` },
      response: { artifacts: { dir: `/tmp/${secret}` } },
      events: [{ artifacts: '[REDACTED]' }],
    });
  });

  it('redacts objects with no prototype, such as parsed records', () => {
    const record = Object.assign(Object.create(null) as object, {
      text: 'has secret-value-1',
    });
    expect(
      redactedClientRun({ clientTelemetry: record }, ['secret-value-1'])
    ).toEqual({ clientTelemetry: { text: 'has [REDACTED]' } });
  });

  it('redacts other objects in the JSON form they are stored in', () => {
    const secret = 'sk-live-0123456789';
    class Payload {
      constructor(readonly token: string) {}
    }
    const at = new Date(0);
    const result = redactedClientRun(
      {
        events: [
          {
            arguments: {
              url: new URL(`https://example.test/?key=${secret}`),
              payload: new Payload(secret),
              at,
            },
          },
        ],
      },
      [secret]
    );
    expect(result.events[0]!.arguments).toEqual({
      url: 'https://example.test/?key=[REDACTED]',
      payload: { token: '[REDACTED]' },
      at,
    });
    // An object with no secret in it is kept, not converted.
    expect(result.events[0]!.arguments.at).toBe(at);
  });

  it('redacts a secret used as a key, keeping both values when keys collide', () => {
    const first = 'env-credential-1';
    const second = 'env-credential-2';
    expect(
      redactedClientRun(
        { events: [{ output: { [first]: 'valid', [second]: 'revoked' } }] },
        [first, second]
      )
    ).toEqual({
      events: [
        { output: { '[REDACTED]': 'valid', '[REDACTED] 2': 'revoked' } },
      ],
    });
  });

  it('redacts a secret JSON escapes inside another object', () => {
    class Payload {
      constructor(readonly token: string) {}
    }
    for (const secret of ['secret-"12345678', 'line1\nline2-xyz']) {
      const result = redactedClientRun(
        { telemetry: { payload: new Payload(secret) } },
        [secret]
      );
      expect(JSON.stringify(result)).not.toContain(
        JSON.stringify(secret).slice(1, -1)
      );
      expect(result.telemetry.payload).toEqual({ token: '[REDACTED]' });
    }
  });

  it('returns the result itself when there is nothing to redact', () => {
    const result = { finalText: 'ok' };
    expect(redactedClientRun(result, ['abc'])).toBe(result);
  });
});

describe('redactClientError', () => {
  it('redacts Error messages and uses the fallback otherwise', () => {
    expect(
      redactClientError(new Error('bad token-value'), ['token-value'], 'x')
    ).toBe('bad [REDACTED]');
    expect(redactClientError('token-value', ['token-value'], 'fallback')).toBe(
      'fallback'
    );
  });
});
