import { beforeEach, describe, expect, it, vi } from 'vitest';
import { evaluateChatgptWeb } from '../chatgptSetup/webIdentity.js';
import {
  listCloudConversations,
  readCloudConversation,
} from './cloudConversation.js';

vi.mock('../chatgptSetup/webIdentity.js', () => ({
  evaluateChatgptWeb: vi.fn(),
}));

const source = { kind: 'cdp' as const, endpoint: 'http://127.0.0.1:9223' };
const expected = {
  accountId: 'account-12345678',
  organizationId: 'org-example123456',
  email: 'eval@example.com',
};
const id = '6b009631-d634-8326-9bb2-b5bd4122d71c';
const detail = {
  id,
  origin: 'tpp',
  createdAt: '2026-11-20T18:49:23.432Z',
  messages: [
    {
      role: 'user', channel: null, createdAt: '2026-11-20T18:49:23.432Z',
      status: 'finished_successfully', endTurn: null, parts: ['Search Glean'],
      tools: [],
    },
    {
      role: 'assistant', channel: 'analysis', status: 'finished_successfully',
      endTurn: false, parts: [], model: 'gpt-6.1-sol-wm', effort: 'standard',
      toolCount: 2,
      tools: [
        { id: 'call-1', type: 'connector_call',
          connectorId: 'asdk_app_glean', toolName: 'glean_default.search' },
        { id: 'call-2', type: 'connector_call',
          connectorId: 'asdk_app_glean', toolName: 'glean_default.read_document' },
      ],
    },
    {
      role: 'assistant', channel: 'final', status: 'finished_successfully',
      endTurn: true, createdAt: '2026-11-20T18:49:30.000Z',
      parts: ['Here is the answer.'], model: 'gpt-6.1-sol-wm',
      effort: 'standard', turnId: 'turn-123', tools: [],
    },
  ],
};

beforeEach(() => vi.mocked(evaluateChatgptWeb).mockReset());

describe('ChatGPT Cloud conversation evidence', () => {
  it('reads only fresh-list metadata and tolerates ordinary Chat origins', async () => {
    vi.mocked(evaluateChatgptWeb).mockResolvedValue({ items: [
      { id, createdAt: detail.createdAt, origin: 'tpp' },
      { id: '6b0094e7-9694-832c-aaf2-fa842ccffa4c',
        createdAt: detail.createdAt, origin: null },
    ] });
    expect(await listCloudConversations(source, expected)).toMatchObject([
      { id, origin: 'tpp' }, { origin: '' },
    ]);
    const expression = vi.mocked(evaluateChatgptWeb).mock.calls[0]![1];
    expect(expression).toContain("location.origin !== 'https://chatgpt.com'");
    expect(expression).toContain('session?.account?.id !==');
    expect(expression).toContain("'chatgpt-account-id': session.account.id");
    expect(expression).not.toContain('refresh=true');
  });

  it('binds the exact user prompt, final answer, native turn and connector names', async () => {
    vi.mocked(evaluateChatgptWeb).mockResolvedValue(detail);
    const conversation = await readCloudConversation(source, expected, id);
    expect(conversation).toMatchObject({
      id, turnId: 'turn-123', prompt: 'Search Glean',
      response: 'Here is the answer.', complete: true,
      model: 'gpt-6.1-sol-wm', reasoningEffort: 'standard',
    });
    expect(conversation.toolCalls).toMatchObject([
      { source: 'mcp', server: 'glean_default', name: 'search' },
      { source: 'mcp', server: 'glean_default', name: 'read_document' },
    ]);
    expect(conversation.toolCalls[0]).not.toHaveProperty('output');
    const expression = vi.mocked(evaluateChatgptWeb).mock.calls[0]![1];
    expect(() => new Function(`return ${expression}`)).not.toThrow();
  });

  it('keeps a different connected app visible to the caller audit', async () => {
    vi.mocked(evaluateChatgptWeb).mockResolvedValue({
      ...detail,
      messages: [detail.messages[0], {
        ...detail.messages[1], toolCount: 1,
        tools: [{ type: 'connector_call', connectorId: 'other-app',
          toolName: 'other_connector.search' }],
      }, detail.messages[2]],
    });
    expect((await readCloudConversation(source, expected, id)).toolCalls)
      .toMatchObject([{ source: 'mcp', server: 'other_connector' }]);
  });

  it.each([
    ['wrong origin', { ...detail, origin: null }],
    ['multiple user prompts', { ...detail, messages: [detail.messages[0], detail.messages[0], ...detail.messages.slice(1)] }],
    ['hidden tool calls', { ...detail, messages: [detail.messages[0], { ...detail.messages[1], toolCount: 3 }, detail.messages[2]] }],
    ['unattributed connector', { ...detail, messages: [detail.messages[0], { ...detail.messages[1], toolCount: 1, tools: [{ type: 'connector_call', toolName: 'other.search' }] }, detail.messages[2]] }],
  ])('rejects %s', async (_name, value) => {
    vi.mocked(evaluateChatgptWeb).mockResolvedValue(value);
    await expect(readCloudConversation(source, expected, id))
      .rejects.toThrow('pinned signed-in browser account');
  });
});
