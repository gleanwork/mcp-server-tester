import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  isChatgptIdentityEndpoint,
  probeChatgptWebIdentity,
} from './webIdentity.js';

const identity = {
  account: {
    id: '00000000-0000-4000-8000-000000000001',
    organizationId: 'org-example123456',
  },
  user: { email: 'test@example.com' },
};
const expected = {
  accountId: identity.account.id,
  organizationId: identity.account.organizationId,
  email: identity.user.email,
};
const source = { kind: 'cdp' as const, endpoint: 'http://127.0.0.1:9222' };

class FakeWebSocket {
  readonly commands: Array<Record<string, unknown>> = [];
  readonly listeners = new Map<
    string,
    Array<((event?: { data: unknown }) => void) | (() => void)>
  >();

  constructor(readonly url: string) {}

  addEventListener(
    type: string,
    listener: ((event?: { data: unknown }) => void) | (() => void)
  ) {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
    if (type === 'open') queueMicrotask(() => this.emit(type));
  }

  send(message: string) {
    this.commands.push(JSON.parse(message) as Record<string, unknown>);
    queueMicrotask(() =>
      this.emit('message', {
        data: JSON.stringify({
          id: 1,
          result: {
            result: {
              type: 'object',
              value: { ...identity, accessToken: 'not-returned' },
            },
          },
        }),
      })
    );
  }

  close() {}

  emit(type: string, event?: { data: unknown }) {
    for (const listener of this.listeners.get(type) ?? []) {
      if (type === 'message')
        (listener as (event: { data: unknown }) => void)(event!);
      else (listener as () => void)();
    }
  }
}

afterEach(() => vi.unstubAllGlobals());

describe('ChatGPT web identity source', () => {
  it('accepts only numeric IPv4 loopback CDP endpoints', () => {
    expect(isChatgptIdentityEndpoint(source.endpoint)).toBe(true);
    expect(isChatgptIdentityEndpoint('http://localhost:9222')).toBe(false);
    expect(isChatgptIdentityEndpoint('http://0.0.0.0:9222')).toBe(false);
    expect(isChatgptIdentityEndpoint('http://127.0.0.1:9222/path')).toBe(false);
    expect(isChatgptIdentityEndpoint('http://user:pass@127.0.0.1:9222')).toBe(
      false
    );
  });

  it('reads only pinned identity fields from one signed-in ChatGPT page', async () => {
    const socket = new FakeWebSocket(
      'ws://127.0.0.1:9222/devtools/page/chatgpt1'
    );
    vi.stubGlobal(
      'WebSocket',
      class {
        constructor(url: string) {
          expect(url).toBe(socket.url);
          return socket;
        }
      }
    );
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      const requested =
        typeof url === 'string' ? url : url instanceof URL ? url.href : url.url;
      expect(requested).toBe('http://127.0.0.1:9222/json/list');
      return new Response(
        JSON.stringify([
          {
            type: 'page',
            url: 'https://chatgpt.com/',
            webSocketDebuggerUrl: socket.url,
          },
        ])
      );
    }) as unknown as typeof fetch;

    await expect(
      probeChatgptWebIdentity(source, expected, { fetchImpl })
    ).resolves.toBeUndefined();
    const command = socket.commands[0]!;
    expect(command.method).toBe('Runtime.evaluate');
    const expression = (command.params as { expression: string }).expression;
    expect(expression).toContain("fetch('/api/auth/session'");
    expect(expression).not.toContain('refresh=true');
    expect(expression).not.toContain('accessToken');
    expect(expression).not.toContain('Network.getCookies');
  });

  it.each([
    [
      'account ID',
      { ...expected, accountId: '00000000-0000-4000-8000-000000000002' },
    ],
    ['organization ID', { ...expected, organizationId: 'org-another123456' }],
    ['email', { ...expected, email: 'other@example.com' }],
  ])('fails closed when the pinned %s differs', async (_label, pinned) => {
    const socket = new FakeWebSocket(
      'ws://127.0.0.1:9222/devtools/page/chatgpt1'
    );
    vi.stubGlobal(
      'WebSocket',
      class {
        constructor() {
          return socket;
        }
      }
    );
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          JSON.stringify([
            {
              type: 'page',
              url: 'https://chatgpt.com/',
              webSocketDebuggerUrl: socket.url,
            },
          ])
        )
    ) as unknown as typeof fetch;

    await expect(
      probeChatgptWebIdentity(source, pinned, { fetchImpl })
    ).rejects.toThrow('identity details are suppressed');
  });

  it('requires exactly one ChatGPT page in the CDP profile', async () => {
    const fetchImpl = vi.fn(
      async () => new Response('[]')
    ) as unknown as typeof fetch;
    await expect(
      probeChatgptWebIdentity(source, expected, { fetchImpl })
    ).rejects.toThrow('identity details are suppressed');
  });
});
