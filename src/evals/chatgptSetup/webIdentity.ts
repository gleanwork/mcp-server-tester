const CHATGPT_ORIGIN = 'https://chatgpt.com';
const MAX_RESPONSE_BYTES = 1024 * 1024;
const PROBE_ERROR =
  'ChatGPT web identity probe failed. Check the signed-in ChatGPT page and pinned identity; identity details are suppressed.';

export interface ChatgptWebIdentitySource {
  kind: 'cdp';
  endpoint: string;
}

export interface ChatgptWebIdentity {
  accountId: string;
  organizationId: string;
  email: string;
}

export type ChatgptIdentityFetch = (
  input: string,
  init?: RequestInit
) => Promise<Response>;

export function isChatgptIdentityEndpoint(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      url.protocol === 'http:' &&
      url.hostname === '127.0.0.1' &&
      Number(url.port) > 0 &&
      Number(url.port) <= 65535 &&
      (url.pathname === '/' || url.pathname === '') &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash
    );
  } catch {
    return false;
  }
}

function checkedSource(source: ChatgptWebIdentitySource): string {
  if (source?.kind !== 'cdp' || !isChatgptIdentityEndpoint(source.endpoint))
    throw new Error(PROBE_ERROR);
  return new URL(source.endpoint).origin;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function checkedIdentity(value: unknown): ChatgptWebIdentity {
  if (!isRecord(value) || !isRecord(value.account) || !isRecord(value.user))
    throw new Error(PROBE_ERROR);
  const { id, organizationId } = value.account;
  const { email } = value.user;
  if (
    typeof id !== 'string' ||
    !/^[A-Za-z0-9_-]{8,128}$/.test(id) ||
    typeof organizationId !== 'string' ||
    !/^org-[A-Za-z0-9_-]{6,124}$/.test(organizationId) ||
    typeof email !== 'string' ||
    email.trim() !== email ||
    email.length > 320
  )
    throw new Error(PROBE_ERROR);
  return { accountId: id, organizationId, email };
}

async function readBoundedResponse(response: Response): Promise<string> {
  if (!response.ok) throw new Error(PROBE_ERROR);
  if (!response.body) {
    const text = await response.text();
    if (Buffer.byteLength(text) > MAX_RESPONSE_BYTES)
      throw new Error(PROBE_ERROR);
    return text;
  }
  const reader: ReadableStreamDefaultReader<Uint8Array> =
    response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const result = await reader.read();
      if (result.done) break;
      size += result.value.byteLength;
      if (size > MAX_RESPONSE_BYTES) throw new Error(PROBE_ERROR);
      chunks.push(result.value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks).toString('utf8');
}

function checkedDebuggerUrl(value: unknown, endpoint: string): string {
  if (typeof value !== 'string') throw new Error(PROBE_ERROR);
  const target = new URL(value);
  const requested = new URL(endpoint);
  if (
    target.protocol !== 'ws:' ||
    target.hostname !== '127.0.0.1' ||
    target.port !== requested.port ||
    !/^\/devtools\/page\/[A-Za-z0-9_-]+$/.test(target.pathname) ||
    target.username ||
    target.password ||
    target.search ||
    target.hash
  )
    throw new Error(PROBE_ERROR);
  return target.href;
}

const IDENTITY_EXPRESSION = `
(async () => {
  if (location.origin !== '${CHATGPT_ORIGIN}') throw new Error('origin');
  const response = await fetch('/api/auth/session', {
    method: 'GET',
    credentials: 'same-origin',
    cache: 'no-store',
    redirect: 'error',
    signal: AbortSignal.timeout(10000)
  });
  if (!response.ok) throw new Error('identity');
  const text = await response.text();
  if (text.length > ${MAX_RESPONSE_BYTES}) throw new Error('size');
  const session = JSON.parse(text);
  return {
    account: {
      id: session?.account?.id,
      organizationId: session?.account?.organizationId
    },
    user: { email: session?.user?.email }
  };
})()`;

async function readIdentity(
  endpoint: string,
  signal?: AbortSignal,
  fetchImpl: ChatgptIdentityFetch = fetch
): Promise<ChatgptWebIdentity> {
  const response = await fetchImpl(`${endpoint}/json/list`, {
    redirect: 'error',
    signal: AbortSignal.any([
      signal ?? new AbortController().signal,
      AbortSignal.timeout(10_000),
    ]),
  });
  const targets: unknown = JSON.parse(await readBoundedResponse(response));
  if (!Array.isArray(targets) || targets.length > 128)
    throw new Error(PROBE_ERROR);
  const pages = targets.filter((target) => {
    if (!isRecord(target) || target.type !== 'page') return false;
    try {
      return new URL(String(target.url)).origin === CHATGPT_ORIGIN;
    } catch {
      return false;
    }
  });
  if (pages.length !== 1) throw new Error(PROBE_ERROR);
  const debuggerUrl = checkedDebuggerUrl(
    (pages[0] as Record<string, unknown>).webSocketDebuggerUrl,
    endpoint
  );

  return await new Promise((resolve, reject) => {
    const socket = new WebSocket(debuggerUrl);
    let finished = false;
    const finish = (identity?: ChatgptWebIdentity) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      try {
        socket.close();
      } catch {
        reject(new Error(PROBE_ERROR));
        return;
      }
      if (identity) resolve(identity);
      else reject(new Error(PROBE_ERROR));
    };
    const abort = () => finish();
    const timer = setTimeout(abort, 10_000);
    signal?.addEventListener('abort', abort, { once: true });
    socket.addEventListener('open', () => {
      if (finished || signal?.aborted) return finish();
      try {
        socket.send(
          JSON.stringify({
            id: 1,
            method: 'Runtime.evaluate',
            params: {
              expression: IDENTITY_EXPRESSION,
              awaitPromise: true,
              returnByValue: true,
            },
          })
        );
      } catch {
        finish();
      }
    });
    socket.addEventListener('message', (event) => {
      try {
        if (
          typeof event.data !== 'string' ||
          Buffer.byteLength(event.data) > MAX_RESPONSE_BYTES
        )
          return finish();
        const reply: unknown = JSON.parse(event.data);
        if (!isRecord(reply) || reply.id === undefined) return;
        if (
          reply.id !== 1 ||
          reply.error !== undefined ||
          !isRecord(reply.result) ||
          reply.result.exceptionDetails !== undefined ||
          !isRecord(reply.result.result)
        )
          return finish();
        finish(checkedIdentity(reply.result.result.value));
      } catch {
        finish();
      }
    });
    socket.addEventListener('error', abort);
    socket.addEventListener('close', abort);
    if (signal?.aborted) abort();
  });
}

export async function probeChatgptWebIdentity(
  source: ChatgptWebIdentitySource,
  expected: ChatgptWebIdentity,
  options: { signal?: AbortSignal; fetchImpl?: ChatgptIdentityFetch } = {}
): Promise<void> {
  try {
    const endpoint = checkedSource(source);
    const actual = await readIdentity(
      endpoint,
      options.signal,
      options.fetchImpl
    );
    if (
      actual.accountId !== expected.accountId ||
      actual.organizationId !== expected.organizationId ||
      actual.email.toLowerCase() !== expected.email.toLowerCase()
    )
      throw new Error(PROBE_ERROR);
  } catch {
    throw new Error(PROBE_ERROR);
  }
}
