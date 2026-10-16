import { describe, expect, it } from 'vitest';
import {
  PlannerConnectionError,
  PlannerStatusError,
  type PlannerRequest,
} from './computerUseLoop.js';
import {
  anthropicComputerUsePlanner,
  PlannerTimeoutError,
} from './computerUsePlanner.js';

const REQUEST: PlannerRequest = {
  model: 'claude-sonnet-4-6',
  max_tokens: 1024,
  system: 'system',
  tools: [],
  messages: [{ role: 'user', content: 'private query' }],
};
const REPLY = {
  model: 'claude-sonnet-4-6',
  content: [{ type: 'text', text: 'ok' }],
};

interface Call {
  url: string;
  headers: Record<string, string>;
  body: unknown;
}

function planner(
  env: NodeJS.ProcessEnv,
  replies: Array<Response | Error | (() => Promise<Response>)>
) {
  const calls: Call[] = [];
  const sleeps: number[] = [];
  const instance = anthropicComputerUsePlanner({
    env,
    async fetch(url, init) {
      calls.push({
        url,
        headers: init.headers as Record<string, string>,
        body: JSON.parse(init.body as string) as unknown,
      });
      const next = replies.shift();
      if (!next) throw new Error('no more replies');
      if (next instanceof Error) throw next;
      if (typeof next === 'function') return next();
      return next;
    },
    async sleep(ms) {
      sleeps.push(ms);
    },
    requestTimeoutMs: 50,
  });
  return { instance, calls, sleeps };
}

function json(
  status: number,
  body: unknown,
  headers: Record<string, string> = {}
) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

function refused(): Error {
  return new TypeError('fetch failed', {
    cause: Object.assign(new Error('connect ECONNREFUSED secret-host-detail'), {
      code: 'ECONNREFUSED',
    }),
  });
}

const signal = () => new AbortController().signal;

describe('the endpoint and credential', () => {
  it('sends an API key to the public API, with the Computer Use beta', async () => {
    const { instance, calls } = planner({ ANTHROPIC_API_KEY: 'test-key' }, [
      json(200, REPLY),
    ]);
    await expect(instance.create(REQUEST, signal())).resolves.toEqual(REPLY);
    expect(calls[0]!.url).toBe(
      'https://api.anthropic.com/v1/messages?beta=true'
    );
    expect(calls[0]!.headers).toMatchObject({
      'x-api-key': 'test-key',
      'anthropic-version': '2023-06-01',
      'anthropic-beta': 'computer-use-2025-11-24',
    });
    expect(calls[0]!.headers).not.toHaveProperty('authorization');
    expect(calls[0]!.body).toEqual(REQUEST);
  });

  it('sends only the gateway token to the gateway', async () => {
    const { instance, calls } = planner(
      {
        ANTHROPIC_BASE_URL: 'https://gateway.example.test/anthropic/v1',
        ANTHROPIC_AUTH_TOKEN: 'gateway-token',
        ANTHROPIC_API_KEY: 'public-key',
      },
      [json(200, REPLY)]
    );
    await instance.create(REQUEST, signal());
    expect(calls[0]!.url).toBe(
      'https://gateway.example.test/anthropic/v1/messages?beta=true'
    );
    expect(calls[0]!.headers.authorization).toBe('Bearer gateway-token');
    expect(calls[0]!.headers).not.toHaveProperty('x-api-key');
  });

  it('runs the gateway auth command for its token', async () => {
    const { instance, calls } = planner(
      {
        ANTHROPIC_BASE_URL: 'https://gateway.example.test/anthropic',
        MST_LLM_AUTH_COMMAND: 'printf command-token',
      },
      [json(200, REPLY)]
    );
    await instance.prepare();
    await instance.create(REQUEST, signal());
    expect(calls[0]!.headers.authorization).toBe('Bearer command-token');
  });

  it('needs a credential', async () => {
    const { instance, calls } = planner({}, []);
    await expect(instance.prepare()).rejects.toThrow('needs ANTHROPIC_API_KEY');
    expect(calls).toEqual([]);
  });

  it('never sends a gateway token to the public API', async () => {
    const { instance, calls } = planner(
      {
        ANTHROPIC_BASE_URL: 'https://api.anthropic.com',
        ANTHROPIC_AUTH_TOKEN: 'gateway-token',
      },
      []
    );
    await expect(instance.prepare()).rejects.toThrow('gateway base URL');
    await expect(instance.create(REQUEST, signal())).rejects.toThrow(
      'gateway base URL'
    );
    expect(calls).toEqual([]);
  });
});

describe('retries', () => {
  const env = { ANTHROPIC_API_KEY: 'test-key' };

  it("retries a retryable status, waiting as the server's retry-after says", async () => {
    const { instance, calls, sleeps } = planner(env, [
      json(429, { error: 'slow down' }, { 'retry-after': '3' }),
      json(529, { error: 'overloaded' }, { 'retry-after-ms': '250' }),
      json(200, REPLY),
    ]);
    await expect(instance.create(REQUEST, signal())).resolves.toEqual(REPLY);
    expect(calls).toHaveLength(3);
    expect(sleeps).toEqual([3000, 250]);
  });

  it('gives up after two retries with the status, never the body', async () => {
    const { instance, calls } = planner(env, [
      json(500, { error: 'private query echoed' }),
      json(500, { error: 'private query echoed' }),
      json(500, { error: 'private query echoed' }),
    ]);
    const error = await instance
      .create(REQUEST, signal())
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(PlannerStatusError);
    expect((error as PlannerStatusError).status).toBe(500);
    expect(String((error as Error).message)).not.toContain('private');
    expect(calls).toHaveLength(3);
  });

  it("doesn't retry a request the API rejected", async () => {
    const { instance, calls } = planner(env, [json(400, { error: 'bad' })]);
    await expect(instance.create(REQUEST, signal())).rejects.toBeInstanceOf(
      PlannerStatusError
    );
    expect(calls).toHaveLength(1);
  });

  it('follows x-should-retry', async () => {
    const { instance, calls } = planner(env, [
      json(400, {}, { 'x-should-retry': 'true' }),
      json(503, {}, { 'x-should-retry': 'false' }),
    ]);
    await expect(instance.create(REQUEST, signal())).rejects.toMatchObject({
      status: 503,
    });
    expect(calls).toHaveLength(2);
  });

  it('retries a dropped connection twice, then names its error classes only', async () => {
    const { instance, calls, sleeps } = planner(env, [
      refused(),
      refused(),
      refused(),
    ]);
    const error = await instance
      .create(REQUEST, signal())
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(PlannerConnectionError);
    expect((error as PlannerConnectionError).chain).toBe(
      'TypeError <- Error(ECONNREFUSED)'
    );
    expect(String((error as Error).message)).not.toContain(
      'secret-host-detail'
    );
    expect(calls).toHaveLength(3);
    expect(sleeps).toHaveLength(2);
    expect(sleeps[0]!).toBeGreaterThanOrEqual(375);
    expect(sleeps[0]!).toBeLessThanOrEqual(500);
  });

  it("doesn't retry a timeout", async () => {
    const hang = () =>
      new Promise<Response>((_, reject) =>
        setTimeout(() => reject(new Error('aborted')), 200)
      );
    const { instance, calls } = planner(env, [hang]);
    // The fake fetch ignores the signal, so the timeout shows as an error after it fires.
    const error = await instance
      .create(REQUEST, signal())
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(PlannerTimeoutError);
    expect(calls).toHaveLength(1);
  });

  it('stops at once when the caller aborts', async () => {
    const controller = new AbortController();
    const { instance } = planner(env, [
      () => {
        controller.abort(new Error('deadline'));
        return Promise.reject(new Error('aborted'));
      },
    ]);
    await expect(instance.create(REQUEST, controller.signal)).rejects.toThrow(
      'deadline'
    );
  });

  it('rejects a reply without content blocks', async () => {
    const { instance } = planner(env, [json(200, { model: 'x' })]);
    await expect(instance.create(REQUEST, signal())).rejects.toThrow(
      'invalid response'
    );
  });
});
