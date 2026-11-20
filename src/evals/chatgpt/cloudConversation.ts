import { createHash } from 'node:crypto';
import {
  evaluateChatgptWeb,
  type ChatgptWebIdentity,
  type ChatgptWebIdentitySource,
} from '../chatgptSetup/webIdentity.js';
import type { LLMToolCall } from '../mstClient/types.js';

const CLOUD_ERROR =
  'ChatGPT Cloud conversation could not be read from the pinned signed-in browser account.';
const MAX_CONVERSATIONS = 50;

export interface CloudConversationSummary {
  id: string;
  createdAt: string;
  origin: string;
}

export interface CloudConversation {
  id: string;
  turnId?: string;
  createdAt: string;
  completedAt?: string;
  prompt: string;
  response?: string;
  model?: string;
  reasoningEffort?: string;
  complete: boolean;
  toolCalls: LLMToolCall[];
  limitations: string[];
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function validId(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9-]{20,80}$/i.test(value);
}

/** Browser fetch keeps the web session token inside the signed-in tab. */
function expression(expected: ChatgptWebIdentity, id?: string): string {
  return `
(async () => {
  if (location.origin !== 'https://chatgpt.com') throw new Error('origin');
  const sessionResponse = await fetch('/api/auth/session', {
    credentials: 'same-origin', cache: 'no-store', redirect: 'error',
    signal: AbortSignal.timeout(8000)
  });
  if (!sessionResponse.ok) throw new Error('session');
  const sessionText = await sessionResponse.text();
  if (sessionText.length > 1048576) throw new Error('session-size');
  const session = JSON.parse(sessionText);
  if (session?.account?.id !== ${JSON.stringify(expected.accountId)} ||
      session?.account?.organizationId !== ${JSON.stringify(expected.organizationId)} ||
      session?.user?.email?.toLowerCase() !== ${JSON.stringify(expected.email.toLowerCase())} ||
      typeof session?.accessToken !== 'string') throw new Error('identity');
  const headers = {
    authorization: 'Bearer ' + session.accessToken,
    'chatgpt-account-id': session.account.id
  };
  const url = ${id ? JSON.stringify(`/backend-api/conversations/${id}`) : JSON.stringify(`/backend-api/conversations?offset=0&limit=${MAX_CONVERSATIONS}`)};
  const response = await fetch(url, {
    credentials: 'same-origin', headers, cache: 'no-store', redirect: 'error',
    signal: AbortSignal.timeout(8000)
  });
  if (!response.ok) throw new Error('conversation');
  const body = await response.text();
  if (body.length > 4194304) throw new Error('conversation-size');
  const data = JSON.parse(body);
  ${id ? `
  if (!Array.isArray(data.messages) || data.messages.length > 200)
    throw new Error('message-count');
  if (data.messages.some(m =>
    Array.isArray(m.metadata?.dil_v2_reasoning?.appData?.items) &&
    m.metadata.dil_v2_reasoning.appData.items.length > 200
  )) throw new Error('tool-count');
  return {
    id: data.conversation_id,
    createdAt: typeof data.create_time === 'number'
      ? new Date(data.create_time * 1000).toISOString() : data.create_time,
    origin: data.conversation_origin,
    messages: data.messages.map(m => ({
      role: m.author?.role,
      channel: m.channel,
      createdAt: typeof m.create_time === 'number'
        ? new Date(m.create_time * 1000).toISOString() : m.create_time,
      status: m.status,
      endTurn: m.end_turn,
      parts: Array.isArray(m.content?.parts) ? m.content.parts
        .filter(p => typeof p === 'string').map(p => {
          if (p.length > 100000) throw new Error('part-size');
          return p;
        }) : [],
      model: m.metadata?.model_slug,
      effort: m.metadata?.thinking_effort,
      turnId: m.metadata?.turn_id,
      toolCount: m.metadata?.dil_v2_reasoning?.appData?.tool_count,
      tools: Array.isArray(m.metadata?.dil_v2_reasoning?.appData?.items)
        ? m.metadata.dil_v2_reasoning.appData.items.map(item => ({
          id: item.id, type: item.type, connectorId: item.connectorId,
          toolName: item.toolName, label: item.label
        })) : []
    }))
  };` : `
  return {
    items: Array.isArray(data.items) ? data.items.slice(0, ${MAX_CONVERSATIONS}).map(item => ({
      id: item.id, createdAt: item.create_time, origin: item.conversation_origin
    })) : null
  };`}
})()`;
}

export async function listCloudConversations(
  source: ChatgptWebIdentitySource,
  expected: ChatgptWebIdentity
): Promise<CloudConversationSummary[]> {
  let value: unknown;
  try {
    value = await evaluateChatgptWeb(source, expression(expected));
  } catch {
    throw new Error(CLOUD_ERROR);
  }
  if (!record(value) || !Array.isArray(value.items))
    throw new Error(CLOUD_ERROR);
  const items: CloudConversationSummary[] = [];
  for (const item of value.items) {
    if (
      !record(item) || !validId(item.id) ||
      typeof item.createdAt !== 'string' ||
      item.origin !== null && typeof item.origin !== 'string'
    ) throw new Error(CLOUD_ERROR);
    items.push({ id: item.id, createdAt: item.createdAt, origin: item.origin ?? '' });
  }
  return items;
}

export async function readCloudConversation(
  source: ChatgptWebIdentitySource,
  expected: ChatgptWebIdentity,
  id: string
): Promise<CloudConversation> {
  if (!validId(id)) throw new Error(CLOUD_ERROR);
  let value: unknown;
  try {
    value = await evaluateChatgptWeb(source, expression(expected, id));
  } catch {
    throw new Error(CLOUD_ERROR);
  }
  if (
    !record(value) || value.id !== id || value.origin !== 'tpp' ||
    typeof value.createdAt !== 'string' || !Array.isArray(value.messages) ||
    value.messages.length > 200
  ) throw new Error(CLOUD_ERROR);
  const messages = value.messages;
  const users = messages.filter(m => record(m) && m.role === 'user');
  if (users.length !== 1 || !record(users[0]) || !Array.isArray(users[0].parts) ||
      users[0].parts.length !== 1 || typeof users[0].parts[0] !== 'string')
    throw new Error(CLOUD_ERROR);
  const final = messages.slice().reverse().find((m: unknown) =>
    record(m) && m.role === 'assistant' && m.channel === 'final' &&
    m.endTurn === true && m.status === 'finished_successfully'
  );
  const toolCalls: LLMToolCall[] = [];
  let declaredCount = 0;
  let observedCount = 0;
  let model: string | undefined;
  let effort: string | undefined;
  for (const message of messages) {
    if (!record(message)) throw new Error(CLOUD_ERROR);
    if (message.role === 'assistant') {
      if (typeof message.model === 'string') model = message.model;
      if (typeof message.effort === 'string') effort = message.effort;
    }
    if (!Array.isArray(message.tools)) throw new Error(CLOUD_ERROR);
    const count = message.toolCount;
    if (count !== undefined && (!Number.isInteger(count) || Number(count) < 0))
      throw new Error(CLOUD_ERROR);
    declaredCount += Number(count ?? 0);
    for (const tool of message.tools) {
      if (!record(tool) || typeof tool.type !== 'string') throw new Error(CLOUD_ERROR);
      observedCount += 1;
      if (tool.type === 'connector_call') {
        if (typeof tool.toolName !== 'string' ||
            !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(tool.toolName) ||
            typeof tool.connectorId !== 'string') throw new Error(CLOUD_ERROR);
        const [server, name] = tool.toolName.split('.');
        if (!server || !name) throw new Error(CLOUD_ERROR);
        toolCalls.push({
          source: 'mcp', server, name, rawName: tool.toolName,
          arguments: {},
          ...(typeof tool.id === 'string' ? { id: tool.id } : {}),
        });
      } else {
        if (tool.connectorId !== undefined && tool.connectorId !== null)
          throw new Error(CLOUD_ERROR);
        if (typeof tool.toolName !== 'string' && typeof tool.label !== 'string')
          throw new Error(CLOUD_ERROR);
        toolCalls.push({
          source: 'builtin', name: String(tool.toolName ?? tool.label),
          arguments: {},
          ...(typeof tool.id === 'string' ? { id: tool.id } : {}),
        });
      }
    }
  }
  if (declaredCount !== observedCount) throw new Error(CLOUD_ERROR);
  const response = record(final) && Array.isArray(final.parts) &&
    final.parts.length === 1 && typeof final.parts[0] === 'string'
      ? final.parts[0] : undefined;
  return {
    id,
    ...(record(final) && typeof final.turnId === 'string' &&
      final.turnId.length > 0 ? { turnId: final.turnId } : {}),
    createdAt: value.createdAt,
    ...(record(final) && typeof final.createdAt === 'string'
      ? { completedAt: final.createdAt } : {}),
    prompt: users[0].parts[0],
    ...(response ? { response } : {}),
    ...(model ? { model } : {}),
    ...(effort ? { reasoningEffort: effort } : {}),
    complete: Boolean(response),
    toolCalls,
    limitations: [
      'Cloud conversation tool summaries contain names, but not arguments, results, timing or token usage.',
    ],
  };
}

export function cloudPromptHash(prompt: string): string {
  return createHash('sha256').update(prompt, 'utf8').digest('hex');
}
