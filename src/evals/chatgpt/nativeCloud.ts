/** Read-only Cloud conversation transport for a verified Linux account profile. */
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import type { ChatgptWebIdentity } from '../chatgptSetup/webIdentity.js';

export interface NativeCloudSource {
  kind: 'native';
  authFile: string;
}

const MAX_AUTH_BYTES = 32 * 1024;
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

async function accountToken(
  source: NativeCloudSource,
  expected: ChatgptWebIdentity
): Promise<string> {
  if (!isAbsolute(source.authFile)) throw new Error('Invalid account source');
  const bytes = Buffer.alloc(MAX_AUTH_BYTES + 1);
  let handle;
  try {
    handle = await open(
      source.authFile,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
    );
    const info = await handle.stat();
    if (!info.isFile() || info.nlink !== 1 ||
        info.uid !== process.getuid?.() || (info.mode & 0o777) !== 0o600 ||
        info.size > MAX_AUTH_BYTES) throw new Error('Invalid account source');
    const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
    if (bytesRead > MAX_AUTH_BYTES) throw new Error('Invalid account source');
    const auth: unknown = JSON.parse(bytes.subarray(0, bytesRead).toString('utf8'));
    if (!record(auth) || auth.auth_mode !== 'chatgptAuthTokens' ||
        !record(auth.tokens) || auth.tokens.account_id !== expected.accountId ||
        auth.tokens.refresh_token !== '' ||
        auth.tokens.id_token !== auth.tokens.access_token ||
        typeof auth.tokens.access_token !== 'string' ||
        !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(auth.tokens.access_token))
      throw new Error('Invalid account source');
    const token = auth.tokens.access_token;
    const claims: unknown = JSON.parse(
      Buffer.from(token.split('.')[1]!, 'base64url').toString('utf8')
    );
    if (!record(claims) ||
        !record(claims['https://api.openai.com/auth']) ||
        claims['https://api.openai.com/auth'].chatgpt_account_id !== expected.accountId ||
        !record(claims['https://api.openai.com/profile']) ||
        String(claims['https://api.openai.com/profile'].email).toLowerCase() !==
          expected.email.toLowerCase() ||
        typeof claims.exp !== 'number' || !Number.isSafeInteger(claims.exp) ||
        claims.exp * 1000 <= Date.now() + 60_000)
      throw new Error('Invalid account source');
    return token;
  } finally {
    bytes.fill(0);
    await handle?.close();
  }
}

function timestamp(value: unknown): unknown {
  return typeof value === 'number'
    ? new Date(value * 1000).toISOString() : value;
}

/** The same narrow projection that the browser transport returns. */
function project(data: unknown, id?: string): unknown {
  if (!record(data)) throw new Error('Invalid Cloud response');
  if (!id) {
    return {
      items: Array.isArray(data.items)
        ? data.items.slice(0, 50).map(item => record(item)
          ? { id: item.id, createdAt: item.create_time,
              origin: item.conversation_origin }
          : null)
        : null,
    };
  }
  if (!Array.isArray(data.messages) || data.messages.length > 200)
    throw new Error('Invalid Cloud response');
  return {
    id: data.conversation_id,
    createdAt: timestamp(data.create_time),
    origin: data.conversation_origin,
    messages: data.messages.map(message => {
      if (!record(message)) throw new Error('Invalid Cloud message');
      const author = record(message.author) ? message.author : {};
      const content = record(message.content) ? message.content : {};
      const metadata = record(message.metadata) ? message.metadata : {};
      const reasoning = record(metadata.dil_v2_reasoning)
        ? metadata.dil_v2_reasoning : {};
      const appData = record(reasoning.appData) ? reasoning.appData : {};
      if (Array.isArray(appData.items) && appData.items.length > 200)
        throw new Error('Invalid Cloud tool count');
      let connectorPath;
      if (message.recipient === 'api_tool.call_tool') {
        if (typeof metadata.connector_tool_payload !== 'string')
          throw new Error('Invalid Cloud connector');
        const payload: unknown = JSON.parse(metadata.connector_tool_payload);
        connectorPath = record(payload) ? payload.path : undefined;
      }
      const invoked = record(metadata.invoked_resource)
        ? metadata.invoked_resource : undefined;
      return {
        id: message.id,
        role: author.role,
        recipient: message.recipient,
        channel: message.channel,
        createdAt: timestamp(message.create_time),
        status: message.status,
        endTurn: message.end_turn,
        parts: Array.isArray(content.parts)
          ? content.parts.filter((part): part is string =>
              typeof part === 'string').map(part => {
                if (part.length > 100_000) throw new Error('Invalid Cloud part');
                return part;
              }) : [],
        model: metadata.model_slug,
        effort: metadata.thinking_effort,
        turnId: metadata.turn_id,
        connectorPath,
        invokedResource: author.role === 'tool' && invoked
          ? { resourceUri: invoked.resource_uri,
              connectorId: invoked.connector_id, appName: invoked.app_name }
          : undefined,
        toolCount: appData.tool_count,
        tools: Array.isArray(appData.items)
          ? appData.items.map(item => record(item)
            ? { id: item.id, type: item.type,
                connectorId: item.connectorId, toolName: item.toolName,
                label: item.label }
            : null)
          : [],
      };
    }),
  };
}

export async function evaluateNativeCloud(
  source: NativeCloudSource,
  expected: ChatgptWebIdentity,
  id?: string
): Promise<unknown> {
  const token = await accountToken(source, expected);
  const url = id
    ? `https://chatgpt.com/backend-api/conversations/${id}`
    : 'https://chatgpt.com/backend-api/conversations?offset=0&limit=50';
  const response = await fetch(url, {
    headers: { authorization: `Bearer ${token}`,
      'chatgpt-account-id': expected.accountId },
    redirect: 'error', signal: AbortSignal.timeout(8000),
  });
  if (!response.ok ||
      Number(response.headers.get('content-length') ?? 0) > MAX_RESPONSE_BYTES)
    throw new Error('Cloud response unavailable');
  const body = await response.text();
  if (body.length > MAX_RESPONSE_BYTES) throw new Error('Cloud response too large');
  return project(JSON.parse(body), id);
}
