import { describe, expect, it, vi } from 'vitest';
import type { HttpMCPConfig, MCPConfig } from '../../config/mcpConfig.js';
import { createCoworkMcpPlan, resolveCoworkMcpHeaders } from './config.js';

const DIRECTORY = '/opt/glean/mcp-helpers';
const CONFIG_ERROR = 'Invalid or unsupported Cowork MCP configuration.';
const HEADERS_ERROR = 'Invalid or missing Cowork MCP runtime headers.';

function http(overrides: Partial<HttpMCPConfig> = {}): HttpMCPConfig {
  return {
    transport: 'http',
    label: 'search',
    serverUrl: 'https://mcp.example.test/team/mcp/',
    ...overrides,
  };
}

function expectInvalid(servers: MCPConfig[]): void {
  expect(() => createCoworkMcpPlan(servers, DIRECTORY)).toThrow(CONFIG_ERROR);
  expect(() => resolveCoworkMcpHeaders(servers, {})).toThrow(CONFIG_ERROR);
}

describe('createCoworkMcpPlan', () => {
  // Bundle/transaction tests assert exact managed settings, server sets and
  // approval policies. Keep this suite focused on canonical validation.
  it('never reads header values, tokens, or environment references while planning', () => {
    const readSecret = vi.fn((): never => {
      throw new Error('synthetic-secret-was-read');
    });
    const headers: Record<string, string> = {};
    Object.defineProperty(headers, 'X-Secret', {
      enumerable: true,
      get: readSecret,
    });
    for (const key of ['accessToken', 'accessTokenEnv']) {
      const auth = {};
      Object.defineProperty(auth, key, { enumerable: true, get: readSecret });
      expect(
        createCoworkMcpPlan([http({ headers, auth })], DIRECTORY).servers
      ).toEqual([
        {
          label: 'search',
          url: http().serverUrl,
          helperName: 'mcp-search-headers.sh',
        },
      ]);
    }
    expect(readSecret).not.toHaveBeenCalled();
  });

  it('preserves meaningful paths, escapes and trailing slashes without requiring /eval', () => {
    const urls = [
      'https://example.test/team/mcp',
      'https://example.test/team/mcp/',
      'https://example.test/Other%2FPath/',
    ];
    expect(
      createCoworkMcpPlan(
        urls.map((serverUrl, index) =>
          http({ label: `server${index}`, serverUrl })
        ),
        DIRECTORY
      ).servers.map((server) => server.url)
    ).toEqual(urls);
  });

  it.each([
    'http://localhost:4321/mcp',
    'http://127.0.0.1:4321/mcp',
    'http://[::1]:4321/mcp',
    'https://remote.example.test/mcp',
  ])('accepts HTTPS and literal fixture loopbacks: %s', (serverUrl) => {
    expect(
      createCoworkMcpPlan([http({ serverUrl })], DIRECTORY).servers[0]?.url
    ).toBe(serverUrl);
  });

  it.each([
    undefined,
    '',
    'with space',
    '../traversal',
    '1number',
    '_underscore',
    'a/b',
    'a.b',
    'a;command',
    'ümlaut',
    'a'.repeat(65),
    'safe\n',
    'safe\u0000',
  ])('rejects unsafe or missing labels: %j', (label) => {
    expectInvalid([http({ label })]);
  });

  it('accepts the label length boundary and rejects duplicates', () => {
    expect(
      createCoworkMcpPlan([http({ label: 'a'.repeat(64) })], DIRECTORY)
        .servers[0]?.label
    ).toHaveLength(64);
    expectInvalid([http(), http({ serverUrl: 'https://other.example.test/' })]);
  });

  it.each([
    'https://MCP.EXAMPLE.TEST:443/team/mcp/',
    'https://mcp.example.test/team/./mcp/',
    'https://mcp.example.test/other/../team/mcp/',
  ])('rejects duplicate normalized URLs: %s', (serverUrl) => {
    expectInvalid([http(), http({ label: 'other', serverUrl })]);
  });

  it.each([
    'not-a-url',
    'ftp://example.test/mcp',
    'http://remote.example.test/mcp',
    'http://localhost.evil.test/mcp',
    'http://localhost./mcp',
    'http://127.1/mcp',
    'http://2130706433/mcp',
    'http://0x7f000001/mcp',
    'http://127.000.000.001/mcp',
    'http://[0:0:0:0:0:0:0:1]/mcp',
    'http://[::ffff:127.0.0.1]/mcp',
    'https://synthetic-user:synthetic-pass@example.test/mcp',
    'https://@example.test/mcp',
    'https://example.test/mcp?synthetic-secret',
    'https://example.test/mcp?',
    'https://example.test/mcp#synthetic-secret',
    'https://example.test/mcp#',
    ' https://example.test/mcp',
    'https://example.test/mcp ',
    'https://example.test/\nmcp',
    'https://example.test/\u0000mcp',
    'https://example.test/\u0085mcp',
    'https://example.test/\\mcp',
    'https:example.test/mcp',
    'https:///example.test/mcp',
    'https://example.test:invalid/mcp',
  ])('rejects unsafe URLs with sanitized errors: %j', (serverUrl) => {
    expectInvalid([http({ serverUrl })]);
  });

  it.each([
    '',
    'relative/path',
    '~/helpers',
    'C:\\helpers',
    '/opt/../helpers',
    '/opt/./helpers',
    '//opt/helpers',
    '/opt//helpers',
    '/opt/my helpers',
    '/opt/helper;echo',
    '/opt/$(command)',
    '/opt/`command`',
    '/opt/"helpers"',
    '/opt/helpers\n',
    '/opt/helpers\u0000',
    '/opt/helpers\u007f',
  ])('rejects unsafe helper directories: %j', (directory) => {
    expect(() => createCoworkMcpPlan([http()], directory)).toThrow(
      CONFIG_ERROR
    );
  });

  it.each(['/', '/opt/helpers', '/opt/helpers/'])(
    'accepts safe absolute Linux directories: %s',
    (directory) => {
      const prefix = directory.replace(/\/$/, '');
      expect(
        createCoworkMcpPlan([http({ headers: { X: 'synthetic' } })], directory)
          .settings.managedMcpServers[0]?.headersHelper
      ).toBe(`${prefix}/mcp-search-headers.sh`);
    }
  );

  it('rejects stdio transport', () => {
    expectInvalid([
      { transport: 'stdio', label: 'local', command: 'synthetic' },
    ]);
  });

  it.each([
    { capabilities: {} },
    { capabilities: { sampling: {} } },
    { capabilities: { roots: { listChanged: false } } },
    { connectTimeoutMs: 1000 },
    { requestTimeoutMs: 1000 },
    { callTimeoutMs: 1000 },
    { proxy: { url: 'https://synthetic:secret@proxy.example.test/' } },
    { retryAttempts: 0 },
    { tls: {} },
    { tls: { rejectUnauthorized: false } },
  ] satisfies Partial<HttpMCPConfig>[])(
    'rejects unsupported canonical options: %j',
    (options) => {
      expectInvalid([http(options)]);
    }
  );

  it.each([
    { oauth: { serverUrl: 'https://auth.example.test/' } },
    { clientCredentials: { clientSecret: 'synthetic-client-secret' } },
    { accessToken: 'synthetic', accessTokenEnv: 'SYNTHETIC_TOKEN' },
    { accessToken: '', accessTokenEnv: 'SYNTHETIC_TOKEN' },
    {
      accessToken: 'synthetic',
      oauth: { serverUrl: 'https://auth.example.test/' },
    },
  ])('rejects unsupported and ambiguous auth: %j', (auth) => {
    expectInvalid([http({ auth })]);
  });

  it.each(['Authorization', 'authorization', 'AUTHORIZATION'])(
    'rejects bearer/header collisions: %s',
    (name) => {
      for (const auth of [
        { accessToken: 'synthetic' },
        { accessTokenEnv: 'TOKEN' },
      ]) {
        expectInvalid([
          http({ headers: { [name]: 'synthetic-header' }, auth }),
        ]);
      }
    }
  );

  it.each<Record<string, string>>([
    { 'X-Key': 'one', 'x-key': 'two' },
    { '': 'synthetic' },
    { 'Bad Name': 'synthetic' },
    { 'Bad:Name': 'synthetic' },
    { 'Bad\n': 'synthetic' },
    { 'Bad\u0000Name': 'synthetic' },
    { Náme: 'synthetic' },
  ])('rejects duplicate and invalid header names: %j', (headers) => {
    expectInvalid([http({ headers })]);
  });

  it.each(
    [
      null,
      {},
      [null],
      new Array<MCPConfig>(1),
      [http({ headers: null } as unknown as HttpMCPConfig)],
      [http({ auth: [] } as unknown as HttpMCPConfig)],
      [http({ serverUrl: 42 } as unknown as HttpMCPConfig)],
      [{ ...http(), unexpected: 'synthetic-secret' }],
      [
        http({
          auth: { unexpected: 'synthetic-secret' },
        } as unknown as HttpMCPConfig),
      ],
    ].map((servers) => ({ servers }))
  )('fails closed on malformed runtime config: %j', ({ servers }) => {
    expectInvalid(servers as unknown as MCPConfig[]);
  });
});

describe('resolveCoworkMcpHeaders', () => {
  it('resolves static and environment bearer auth without mutating inputs', () => {
    const headers = Object.freeze({
      'X-Key': 'synthetic-header',
      Accept: 'application/json',
    });
    const servers = [
      Object.freeze(
        http({ headers, auth: Object.freeze({ accessTokenEnv: 'TEST_TOKEN' }) })
      ),
      http({
        label: 'static',
        serverUrl: 'https://static.example.test/',
        auth: { accessToken: 'synthetic-token._~+/-==' },
      }),
      http({ label: 'public', serverUrl: 'https://public.example.test/' }),
    ];
    const env = Object.freeze({ TEST_TOKEN: 'synthetic-env-token' });
    const before = JSON.stringify(servers);
    expect(resolveCoworkMcpHeaders(servers, env)).toEqual({
      search: { ...headers, Authorization: 'Bearer synthetic-env-token' },
      static: { Authorization: 'Bearer synthetic-token._~+/-==' },
      public: {},
    });
    expect(JSON.stringify(servers)).toBe(before);
    expect(env).toEqual({ TEST_TOKEN: 'synthetic-env-token' });
    expect(JSON.stringify(createCoworkMcpPlan(servers, DIRECTORY))).not.toMatch(
      /synthetic|TEST_TOKEN|X-Key/
    );
  });

  it('supports raw Authorization headers without bearer auth and empty field values', () => {
    const headers = {
      authorization: 'Basic synthetic',
      'X-Empty': '',
      'X-Text': 'café',
    };
    expect(resolveCoworkMcpHeaders([http({ headers })], {})).toEqual({
      search: headers,
    });
  });

  it('uses safe own-property output records for special names', () => {
    const headers = Object.fromEntries([['__proto__', 'synthetic-header']]);
    const result = resolveCoworkMcpHeaders(
      [http({ label: 'constructor', headers })],
      {}
    );
    expect(Object.hasOwn(result, 'constructor')).toBe(true);
    expect(Object.hasOwn(result.constructor, '__proto__')).toBe(true);
    expect(JSON.stringify(result)).toBe(
      '{"constructor":{"__proto__":"synthetic-header"}}'
    );
  });

  it.each([
    'synthetic\r\nInjected: value',
    'synthetic\n',
    'synthetic\t',
    'synthetic\u0000',
    'synthetic\u007f',
    'synthetic\u0085',
    'synthetic😀',
    42,
    null,
  ])('rejects bad header values only at runtime: %j', (value) => {
    const servers = [
      http({ headers: { 'X-Key': value } as Record<string, string> }),
    ];
    expect(
      JSON.stringify(createCoworkMcpPlan(servers, DIRECTORY))
    ).not.toContain('synthetic');
    expect(() => resolveCoworkMcpHeaders(servers, {})).toThrow(HEADERS_ERROR);
  });

  it.each([
    '',
    ' synthetic',
    'synthetic ',
    'synthetic\n',
    'synthetic\t',
    'synthetic:token',
    'synthetic token',
    'synthetic\u007f',
    'synthetic😀',
    undefined,
  ])('rejects empty and malformed tokens at runtime: %j', (token) => {
    for (const auth of [
      { accessToken: token },
      { accessTokenEnv: 'TEST_TOKEN' },
    ]) {
      const servers = [http({ auth })];
      expect(
        createCoworkMcpPlan(servers, DIRECTORY).servers[0]?.helperName
      ).toBe('mcp-search-headers.sh');
      expect(() =>
        resolveCoworkMcpHeaders(servers, { TEST_TOKEN: token })
      ).toThrow(HEADERS_ERROR);
    }
  });

  it.each(['', 'BAD NAME', 'BAD-NAME', 'BAD\n', '1BAD', undefined])(
    'rejects invalid environment references at runtime: %j',
    (accessTokenEnv) => {
      const servers = [http({ auth: { accessTokenEnv } })];
      expect(() => resolveCoworkMcpHeaders(servers, {})).toThrow(HEADERS_ERROR);
    }
  );

  it('does not fall back to process.env or inherited environment values', () => {
    const servers = [http({ auth: { accessTokenEnv: 'PATH' } })];
    expect(() => resolveCoworkMcpHeaders(servers, {})).toThrow(HEADERS_ERROR);
    const inherited = Object.create({ PATH: 'synthetic-inherited' }) as Record<
      string,
      string
    >;
    expect(() => resolveCoworkMcpHeaders(servers, inherited)).toThrow(
      HEADERS_ERROR
    );
  });

  it('returns fresh records and resolves updated supplied environment values each time', () => {
    const servers = [http({ auth: { accessTokenEnv: 'TOKEN' } })];
    const first = resolveCoworkMcpHeaders(servers, {
      TOKEN: 'synthetic-first',
    });
    const second = resolveCoworkMcpHeaders(servers, {
      TOKEN: 'synthetic-second',
    });
    expect(first.search?.Authorization).toBe('Bearer synthetic-first');
    expect(second.search?.Authorization).toBe('Bearer synthetic-second');
    expect(first.search).not.toBe(second.search);
  });
});
