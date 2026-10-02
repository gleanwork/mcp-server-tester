/**
 * The SDK host against a mock LLM gateway, with the real `ai` and
 * `@ai-sdk/anthropic` packages (no SDK mocks in this file).
 *
 * The mock behaves like a typical LLM gateway: it accepts only
 * `Authorization: Bearer`, passes streamed Messages responses through, and
 * rebuilds non-streaming responses with zero-value fields (`citations: null`,
 * an empty `caller`) that the AI SDK's response schema rejects.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createVercelOrchestrator } from './vercel.js';
import type { MCPFixtureApi } from '../../../mcp/fixtures/mcpFixture.js';
import { createFixtureExtensions } from '../../../mcp/fixtures/fixtureExtensions.js';

const GOOD_TOKEN = 'gateway-token';
const OVERLOAD_TOKEN = 'overload-token';

interface SeenRequest {
  path?: string;
  authorization?: string;
  apiKey?: string;
  stream: boolean;
  store?: unknown;
}

const seen: SeenRequest[] = [];
let server: Server;
/** The gateway's Anthropic API root, as the official SDKs and Claude Code take it. */
let apiRoot: string;
let origin: string;

/** A Responses API reply, which the gateway serves non-streaming as-is. */
const RESPONSES_BODY = {
  id: 'resp_1',
  object: 'response',
  created_at: 1700000000,
  model: 'gpt-test',
  status: 'completed',
  output: [
    {
      type: 'message',
      id: 'msg_1',
      role: 'assistant',
      status: 'completed',
      content: [
        { type: 'output_text', text: 'Hello from Responses.', annotations: [] },
      ],
    },
  ],
  usage: { input_tokens: 3, output_tokens: 4, total_tokens: 7 },
};

function sse(events: Array<Record<string, unknown>>): string {
  return events
    .map(
      (event) =>
        `event: ${String(event.type)}\ndata: ${JSON.stringify(event)}\n\n`
    )
    .join('');
}

const usage = { input_tokens: 10, output_tokens: 1 };

function messageStart(): Record<string, unknown> {
  return {
    type: 'message_start',
    message: {
      id: 'msg_1',
      type: 'message',
      role: 'assistant',
      model: 'claude-test',
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage,
    },
  };
}

function toolUseStream(): string {
  return sse([
    messageStart(),
    {
      type: 'content_block_start',
      index: 0,
      content_block: {
        type: 'tool_use',
        id: 'toolu_1',
        name: 'get_weather',
        input: {},
      },
    },
    {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'input_json_delta', partial_json: '{"city":"London"}' },
    },
    { type: 'content_block_stop', index: 0 },
    {
      type: 'message_delta',
      delta: { stop_reason: 'tool_use', stop_sequence: null },
      usage: { output_tokens: 5 },
    },
    { type: 'message_stop' },
  ]);
}

function textStream(text: string): string {
  return sse([
    messageStart(),
    {
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'text', text: '' },
    },
    {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'text_delta', text },
    },
    { type: 'content_block_stop', index: 0 },
    {
      type: 'message_delta',
      delta: { stop_reason: 'end_turn', stop_sequence: null },
      usage: { output_tokens: 7 },
    },
    { type: 'message_stop' },
  ]);
}

/**
 * A non-streaming body as the gateway rebuilds it from the Go SDK struct.
 * The zero-value fields are ones observed from a real gateway that
 * rebuilds non-streaming responses; the ids and text are placeholders.
 */
const GATEWAY_NON_STREAMING_BODY = {
  id: 'msg_1',
  type: 'message',
  role: 'assistant',
  model: 'claude-test',
  content: [
    {
      type: 'tool_use',
      id: 'toolu_1',
      name: 'get_weather',
      input: { city: 'London' },
      caller: { type: '', tool_id: '' },
    },
    { type: 'text', text: 'Checking.', citations: null },
  ],
  stop_reason: 'tool_use',
  stop_sequence: '',
  stop_details: { type: 'refusal' },
  usage: { input_tokens: 10, output_tokens: 5 },
};

function hasToolResult(body: {
  messages?: Array<{ content?: unknown }>;
}): boolean {
  return (body.messages ?? []).some(
    (message) =>
      Array.isArray(message.content) &&
      message.content.some(
        (part: { type?: string }) => part.type === 'tool_result'
      )
  );
}

beforeAll(async () => {
  server = createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk: Buffer) => (raw += chunk.toString()));
    req.on('end', () => {
      const body = JSON.parse(raw) as {
        stream?: boolean;
        store?: unknown;
        messages?: Array<{ content?: unknown }>;
      };
      const authorization = req.headers.authorization;
      const apiKey = req.headers['x-api-key'];
      seen.push({
        path: req.url,
        authorization,
        apiKey: typeof apiKey === 'string' ? apiKey : undefined,
        stream: body.stream === true,
        store: body.store,
      });
      if (req.url === '/openai/v1/responses') {
        const authorized = authorization === `Bearer ${GOOD_TOKEN}`;
        res.writeHead(authorized ? 200 : 401, {
          'content-type': 'application/json',
        });
        res.end(
          JSON.stringify(
            authorized
              ? RESPONSES_BODY
              : { error: { message: 'Unauthorized', type: 'auth_error' } }
          )
        );
        return;
      }
      if (req.url !== '/anthropic/v1/messages') {
        res.writeHead(404, { 'content-type': 'text/plain' });
        res.end('404 page not found');
        return;
      }
      const token = authorization?.startsWith('Bearer ')
        ? authorization.slice('Bearer '.length)
        : undefined;
      if (token !== GOOD_TOKEN && token !== OVERLOAD_TOKEN) {
        res.writeHead(401, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            type: 'error',
            error: {
              type: 'authentication_error',
              message: 'Bearer token required',
            },
          })
        );
        return;
      }
      if (body.stream !== true) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(GATEWAY_NON_STREAMING_BODY));
        return;
      }
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      if (token === OVERLOAD_TOKEN) {
        res.end(
          sse([
            messageStart(),
            {
              type: 'error',
              error: { type: 'overloaded_error', message: 'Overloaded' },
            },
          ])
        );
        return;
      }
      res.end(
        hasToolResult(body) ? textStream('Sunny in London.') : toolUseStream()
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  apiRoot = `${origin}/anthropic`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

function createMockMCP(): MCPFixtureApi {
  return {
    client: {} as MCPFixtureApi['client'],
    authType: 'none',
    protocol: { requested: 'legacy', negotiated: '2025-11-25', era: 'legacy' },
    ...createFixtureExtensions({} as MCPFixtureApi['client']),
    project: undefined,
    getServerInfo: vi.fn().mockReturnValue(null),
    listTools: vi.fn().mockResolvedValue([
      {
        name: 'get_weather',
        description: 'Get weather',
        inputSchema: {
          type: 'object',
          properties: { city: { type: 'string' } },
        },
      },
    ]),
    callTool: vi.fn().mockResolvedValue({
      content: [{ type: 'text', text: 'Sunny, 20°C' }],
      isError: false,
    }),
  };
}

/** Credentials cleared from the parent environment, so the test is hermetic. */
function gatewayEnv(
  env: Record<string, string | undefined>
): Record<string, string | undefined> {
  return {
    ANTHROPIC_API_KEY: undefined,
    ANTHROPIC_AUTH_TOKEN: undefined,
    MST_LLM_AUTH_COMMAND: undefined,
    ANTHROPIC_BASE_URL: apiRoot,
    ...env,
  };
}

async function simulate(env: Record<string, string | undefined>) {
  seen.length = 0;
  return createVercelOrchestrator().simulate(
    createMockMCP(),
    'What is the weather in London?',
    {
      provider: 'anthropic',
      model: 'claude-test',
      env: gatewayEnv(env),
      timeout: 10_000,
    }
  );
}

describe('SDK host through a bearer-only LLM gateway', () => {
  it('sends openai calls to the Responses API with the command token as a bearer token', async () => {
    seen.length = 0;
    const result = await createVercelOrchestrator().simulate(
      createMockMCP(),
      'Say hello.',
      {
        provider: 'openai',
        model: 'gpt-test',
        env: {
          OPENAI_API_KEY: undefined,
          OPENAI_BASE_URL: `${origin}/openai/v1`,
          MST_LLM_AUTH_COMMAND: `node -e "process.stdout.write('${GOOD_TOKEN}')"`,
        },
        timeout: 10_000,
      }
    );

    expect(result.error).toBeUndefined();
    expect(result.response).toBe('Hello from Responses.');
    expect(seen).toEqual([
      {
        path: '/openai/v1/responses',
        authorization: `Bearer ${GOOD_TOKEN}`,
        apiKey: undefined,
        stream: false,
        store: false,
      },
    ]);
  });

  it('runs a streamed tool loop with ANTHROPIC_AUTH_TOKEN', async () => {
    const result = await simulate({ ANTHROPIC_AUTH_TOKEN: GOOD_TOKEN });

    expect(result.error).toBeUndefined();
    expect(result.success).toBe(true);
    expect(result.response).toBe('Sunny in London.');
    expect(result.toolCalls).toEqual([
      expect.objectContaining({
        name: 'get_weather',
        arguments: { city: 'London' },
        output: 'Sunny, 20°C',
      }),
    ]);
    expect(result.usage).toMatchObject({ inputTokens: 20, outputTokens: 12 });
    const request = {
      path: '/anthropic/v1/messages',
      authorization: `Bearer ${GOOD_TOKEN}`,
      apiKey: undefined,
      stream: true,
    };
    expect(seen).toEqual([request, request]);
  });

  it("accepts the base URL with the AI SDK's trailing /v1 as well", async () => {
    const result = await simulate({
      ANTHROPIC_AUTH_TOKEN: GOOD_TOKEN,
      ANTHROPIC_BASE_URL: `${apiRoot}/v1/`,
    });

    expect(result.error).toBeUndefined();
    expect(seen.map((request) => request.path)).toEqual([
      '/anthropic/v1/messages',
      '/anthropic/v1/messages',
    ]);
  });

  it('gets its bearer token from MST_LLM_AUTH_COMMAND', async () => {
    const result = await simulate({
      MST_LLM_AUTH_COMMAND: `node -e "process.stdout.write('${GOOD_TOKEN}')"`,
    });

    expect(result.error).toBeUndefined();
    expect(result.success).toBe(true);
    expect(seen.map((request) => request.authorization)).toEqual([
      `Bearer ${GOOD_TOKEN}`,
      `Bearer ${GOOD_TOKEN}`,
    ]);
  });

  it('reports the gateway rejecting an x-api-key credential with a bearer hint', async () => {
    const result = await simulate({ ANTHROPIC_API_KEY: GOOD_TOKEN });

    expect(result.success).toBe(false);
    expect(result.error).toContain('authentication error');
    expect(result.error).toContain('ANTHROPIC_AUTH_TOKEN');
    expect(seen[0]).toMatchObject({
      authorization: undefined,
      apiKey: GOOD_TOKEN,
    });
  });

  it('fails the run on a mid-stream error instead of returning an empty answer', async () => {
    const result = await simulate({ ANTHROPIC_AUTH_TOKEN: OVERLOAD_TOKEN });

    expect(result.success).toBe(false);
    expect(result.error).toContain('Overloaded');
  });

  // Why the anthropic provider streams. If an AI SDK upgrade starts accepting
  // this body, streaming is no longer needed for gateway compatibility.
  it('the gateway non-streaming body fails the AI SDK response schema', async () => {
    const { generateText } = await import('ai');
    const { createAnthropic } = await import('@ai-sdk/anthropic');
    const model = createAnthropic({
      baseURL: `${apiRoot}/v1`,
      authToken: GOOD_TOKEN,
    })('claude-test');

    await expect(generateText({ model, prompt: 'hi' })).rejects.toThrow(
      /Invalid JSON response|Type validation failed/
    );
  });
});
