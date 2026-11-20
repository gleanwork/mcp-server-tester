import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { evaluateNativeCloud } from './nativeCloud.js';

const expected = {
  accountId: 'account-12345678',
  organizationId: 'org-example123456',
  email: 'eval@example.com',
};
const id = '6b009631-d634-8326-9bb2-b5bd4122d71c';
const folders: string[] = [];

function token(accountId = expected.accountId): string {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${encode({ alg: 'none' })}.${encode({
    exp: Math.floor(Date.now() / 1000) + 3600,
    'https://api.openai.com/auth': { chatgpt_account_id: accountId },
    'https://api.openai.com/profile': { email: expected.email },
  })}.signature`;
}

async function source(accountId = expected.accountId) {
  const folder = await mkdtemp(join(tmpdir(), 'mst-native-cloud-'));
  folders.push(folder);
  const authFile = join(folder, 'auth.json');
  const access = token(accountId);
  await writeFile(authFile, JSON.stringify({
    auth_mode: 'chatgptAuthTokens',
    tokens: { account_id: expected.accountId, access_token: access,
      id_token: access, refresh_token: '' },
  }), { mode: 0o600 });
  return { kind: 'native' as const, authFile };
}

afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(folders.splice(0).map(folder => rm(folder, { recursive: true })));
});

describe('native Cloud transport', () => {
  it('reads the pinned profile and projects list and detail without exporting credentials', async () => {
    const native = await source();
    const fetcher = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ items: [
        { id, create_time: '2026-11-20T18:49:23.432Z', conversation_origin: 'tpp' },
      ] }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        conversation_id: id, conversation_origin: 'tpp',
        create_time: 1795200563.432,
        messages: [{ id: 'message-1', author: { role: 'user' },
          content: { parts: ['Search Glean'] }, metadata: {} }],
      }), { status: 200 }));
    vi.stubGlobal('fetch', fetcher);
    expect(await evaluateNativeCloud(native, expected)).toMatchObject({
      items: [{ id, origin: 'tpp' }],
    });
    expect(await evaluateNativeCloud(native, expected, id)).toMatchObject({
      id, origin: 'tpp', messages: [{ role: 'user', parts: ['Search Glean'] }],
    });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(fetcher.mock.calls[0][1].headers['chatgpt-account-id'])
      .toBe(expected.accountId);
    expect(JSON.stringify(await fetcher.mock.results[0].value)).not.toContain('signature');
  });

  it('does not fetch with a token for a different account', async () => {
    const native = await source('other-account');
    const fetcher = vi.fn();
    vi.stubGlobal('fetch', fetcher);
    await expect(evaluateNativeCloud(native, expected)).rejects.toThrow('Invalid account source');
    expect(fetcher).not.toHaveBeenCalled();
  });
});
