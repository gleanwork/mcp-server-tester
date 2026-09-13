import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  CallToolRequestSchema,
  type CallToolRequest,
  type CallToolResult,
} from '@modelcontextprotocol/sdk/types.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { connectCoworkCua } from './cuaTransport.js';
import { CoworkOperationScope } from './deadline.js';

const runtime = vi.hoisted(() => ({
  transport: undefined as InMemoryTransport | undefined,
  transports: vi.fn(),
}));
// Keep the real SDK protocol and replace only the subprocess transport.
vi.mock('@modelcontextprotocol/sdk/client/stdio.js', () => ({
  StdioClientTransport: class {
    constructor(options: unknown) {
      runtime.transports(options);
      if (!runtime.transport) throw new Error('missing test transport');
      return runtime.transport;
    }
  },
}));

const acknowledged: CallToolResult = {
  content: [],
  structuredContent: { pid: 42, clipboard_restored: true },
};
const unsafe = { fatal: true, quarantine: true };
let server: Server;
let serverTransport: InMemoryTransport;
let callTool: ReturnType<
  typeof vi.fn<(request: CallToolRequest) => Promise<CallToolResult>>
>;

beforeEach(async () => {
  vi.clearAllMocks();
  [runtime.transport, serverTransport] = InMemoryTransport.createLinkedPair();
  server = new Server(
    { name: 'in-memory-cua', version: '1.0.0' },
    { capabilities: { tools: {} } }
  );
  callTool = vi.fn(async () => acknowledged);
  server.setRequestHandler(CallToolRequestSchema, callTool);
  await server.connect(serverTransport);
});
afterEach(async () => {
  // Test-owned peer teardown, never a production force-close API.
  await server.close();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

async function connect() {
  return connectCoworkCua({ command: '/synthetic/cua-driver' });
}

describe('persistent Cua transport (in-memory MCP, no subprocess)', () => {
  it('uses one caller-provided runtime for launch and exact-PID cleanup', async () => {
    const sdkCall = vi.spyOn(Client.prototype, 'callTool');
    const sdkClose = vi.spyOn(Client.prototype, 'close');
    const cua = await connect();
    await cua.call(
      'launch_app',
      { bundle_id: 'com.anthropic.claudefordesktop' },
      100
    );
    await cua.call('kill_app', { pid: 42 }, 30);
    await cua.close();
    expect(runtime.transports).toHaveBeenCalledExactlyOnceWith({
      command: '/synthetic/cua-driver',
      args: ['mcp', '--direct'],
      env: {
        CUA_DRIVER_PERMISSION_MODE: 'standard',
        CUA_DRIVER_RS_TELEMETRY_ENABLED: 'false',
      },
      stderr: 'ignore',
    });
    expect(sdkCall).toHaveBeenLastCalledWith(
      { name: 'kill_app', arguments: { pid: 42 } },
      undefined,
      { timeout: 660_000, maxTotalTimeout: 660_000 }
    );
    expect(sdkClose).toHaveBeenCalledTimes(1);
  });

  it('requires an absolute runtime path before spawning a client', async () => {
    await expect(connectCoworkCua({ command: 'cua-driver' })).rejects.toThrow(
      /absolute/
    );
    expect(runtime.transports).not.toHaveBeenCalled();
  });

  it('closes the runtime on connect failure without exposing the error', async () => {
    const sdkClose = vi.spyOn(Client.prototype, 'close');
    vi.spyOn(Client.prototype, 'connect').mockRejectedValueOnce(
      new Error('PRIVATE_CONNECTION_DETAILS')
    );
    const error: unknown = await connect().catch((failure: unknown) => failure);
    expect(error).toMatchObject({ message: 'Cua runtime connection failed' });
    expect(error).not.toHaveProperty('cause');
    expect(String(error)).not.toContain('PRIVATE_CONNECTION_DETAILS');
    expect(sdkClose).toHaveBeenCalledTimes(1);
  });

  it('retains a late launch reply after the host execution deadline', async () => {
    vi.useFakeTimers();
    const reply = deferred<CallToolResult>();
    callTool.mockImplementationOnce(() => reply.promise);
    const cua = await connect();
    const scope = new CoworkOperationScope(Date.now() + 100);
    let acquiredPid: unknown;
    const operation = scope.run(async () => {
      const result = await cua.call('launch_app', {}, 100);
      acquiredPid = result.structuredContent?.pid;
    });
    const deadlineFailure = expect(operation).rejects.toThrow(/deadline/);
    await vi.advanceTimersByTimeAsync(101);
    await deadlineFailure;
    expect(scope.pendingCount).toBe(1);
    // Even the largest host execution + cleanup budget must not consume the RPC.
    await vi.advanceTimersByTimeAsync(630_000 - 101);
    expect(scope.pendingCount).toBe(1);
    reply.resolve(acknowledged);
    await scope.drain(Date.now() + 100);
    expect(acquiredPid).toBe(42);
    expect(scope.pendingCount).toBe(0);
    expect(scope.quarantineRequired).toBe(false);
    await cua.close();
  });

  it.each(['paste_text', 'list_apps'])(
    'refuses close while a raw %s request is pending, then closes after settlement',
    async (name) => {
      const sdkClose = vi.spyOn(Client.prototype, 'close');
      const reply = deferred<CallToolResult>();
      callTool.mockImplementationOnce(() => reply.promise);
      const cua = await connect();
      const operation = cua.call(name, {}, 100);
      await expect(cua.close()).rejects.toMatchObject(unsafe);
      expect(sdkClose).not.toHaveBeenCalled();
      reply.resolve(acknowledged);
      await expect(operation).resolves.toEqual(acknowledged);
      await cua.close();
      await cua.close();
      expect(sdkClose).toHaveBeenCalledTimes(1);
    }
  );

  it.each(['refused', 'unverifiable'])(
    'returns a settled %s paste error unchanged and allows owned-PID cleanup and close',
    async (effect) => {
      const sdkClose = vi.spyOn(Client.prototype, 'close');
      const cua = await connect();
      const launched = await cua.call('launch_app', {}, 100);
      const structuredContent = { effect, clipboard_restored: true };
      const result: CallToolResult = {
        content: [{ type: 'text', text: JSON.stringify(structuredContent) }],
        structuredContent,
        isError: true,
      };
      const reply = deferred<CallToolResult>();
      callTool.mockImplementationOnce(() => reply.promise);
      const operation = cua.call('paste_text', {}, 100);
      await expect(cua.close()).rejects.toMatchObject(unsafe);
      expect(sdkClose).not.toHaveBeenCalled();
      reply.resolve(result);
      await expect(operation).resolves.toEqual(result);
      await cua.call('kill_app', { pid: launched.structuredContent?.pid }, 100);
      expect(callTool.mock.calls.map(([request]) => request.params)).toEqual([
        { name: 'launch_app', arguments: {} },
        { name: 'paste_text', arguments: {} },
        { name: 'kill_app', arguments: { pid: 42 } },
      ]);
      await cua.close();
      await cua.close();
      expect(sdkClose).toHaveBeenCalledTimes(1);
    }
  );

  it.each([
    ['paste_text', 'refused', false],
    ['paste_text', 'refused', undefined],
    ['paste_text', 'unverifiable', false],
    ['paste_text', 'unverifiable', undefined],
    ['paste_text', 'refused', 'true'],
    ['paste_text', 'unknown', true],
    ['paste_text', undefined, true],
    ['launch_app', 'refused', true],
    ['kill_app', 'refused', true],
    ['press_key', 'unverifiable', true],
  ] as const)(
    'quarantines %s errors with effect=%s and clipboard_restored=%s',
    async (name, effect, clipboardRestored) => {
      const sdkClose = vi.spyOn(Client.prototype, 'close');
      callTool.mockResolvedValueOnce({
        content: [],
        structuredContent: { effect, clipboard_restored: clipboardRestored },
        isError: true,
      });
      const cua = await connect();
      await expect(cua.call(name, {}, 100)).rejects.toMatchObject(unsafe);
      await expect(
        cua.call('kill_app', { pid: 42 }, 100)
      ).rejects.toMatchObject(unsafe);
      await expect(cua.close()).rejects.toMatchObject(unsafe);
      expect(sdkClose).not.toHaveBeenCalled();
      expect(callTool).toHaveBeenCalledTimes(1);
    }
  );

  it('quarantines at the bounded SDK timeout and cannot close or mutate again', async () => {
    vi.useFakeTimers();
    const sdkClose = vi.spyOn(Client.prototype, 'close');
    const reply = deferred<CallToolResult>();
    callTool.mockImplementationOnce(() => reply.promise);
    const cua = await connect();
    const operation = cua.call(
      'paste_text',
      { text: 'PRIVATE_CLIPBOARD' },
      100
    );
    const failed = expect(operation).rejects.toMatchObject(unsafe);
    await vi.advanceTimersByTimeAsync(660_000);
    await failed;
    await expect(cua.close()).rejects.toMatchObject(unsafe);
    await expect(cua.call('press_key', {}, 100)).rejects.toMatchObject(unsafe);
    expect(sdkClose).not.toHaveBeenCalled();
    expect(callTool).toHaveBeenCalledTimes(1);
    // The SDK discarded the timed-out request. A late peer reply cannot prove safety.
    reply.resolve(acknowledged);
    await vi.advanceTimersByTimeAsync(0);
    await expect(cua.close()).rejects.toMatchObject(unsafe);
  });

  it('quarantines a mutating request whose transport disconnects', async () => {
    const sdkClose = vi.spyOn(Client.prototype, 'close');
    const reply = deferred<CallToolResult>();
    const started = deferred<void>();
    callTool.mockImplementationOnce(() => {
      started.resolve();
      return reply.promise;
    });
    const cua = await connect();
    const operation = cua.call('paste_text', {}, 100);
    const failed = expect(operation).rejects.toMatchObject(unsafe);
    await started.promise;
    await server.close();
    await failed;
    await expect(cua.close()).rejects.toMatchObject(unsafe);
    await expect(cua.call('kill_app', { pid: 42 }, 100)).rejects.toMatchObject(
      unsafe
    );
    expect(sdkClose).not.toHaveBeenCalled();
    expect(callTool).toHaveBeenCalledTimes(1);
    reply.resolve(acknowledged);
  });

  it('blocks mutations after an unsolicited transport error without dropping the pending RPC', async () => {
    const sdkClose = vi.spyOn(Client.prototype, 'close');
    const reply = deferred<CallToolResult>();
    const started = deferred<void>();
    callTool.mockImplementationOnce(() => {
      started.resolve();
      return reply.promise;
    });
    const cua = await connect();
    const operation = cua.call('paste_text', {}, 100);
    const failed = expect(operation).rejects.toMatchObject(unsafe);
    await started.promise;
    runtime.transport?.onerror?.(new Error('PRIVATE_CLIPBOARD'));
    await expect(cua.call('press_key', {}, 100)).rejects.toMatchObject(unsafe);
    await expect(cua.close()).rejects.toMatchObject(unsafe);
    expect(sdkClose).not.toHaveBeenCalled();
    expect(callTool).toHaveBeenCalledTimes(1);
    reply.resolve(acknowledged);
    await failed;
    await expect(cua.close()).rejects.toMatchObject(unsafe);
  });

  it('does not dispatch a queued mutation after the transport becomes uncertain', async () => {
    const cua = await connect();
    const operation = cua.call('paste_text', {}, 100);
    runtime.transport?.onerror?.(new Error('PRIVATE_TRANSPORT_ERROR'));
    await expect(operation).rejects.toMatchObject(unsafe);
    expect(callTool).not.toHaveBeenCalled();
    await expect(cua.close()).rejects.toMatchObject(unsafe);
  });

  it('quarantines a failed send without exposing the transport error', async () => {
    const cua = await connect();
    vi.spyOn(runtime.transport!, 'send').mockRejectedValueOnce(
      new Error('PRIVATE_TRANSPORT_ERROR')
    );
    const error: unknown = await cua
      .call('launch_app', {}, 100)
      .catch((failure: unknown) => failure);
    expect(error).toMatchObject(unsafe);
    expect(error).not.toHaveProperty('cause');
    expect(String(error)).not.toContain('PRIVATE_TRANSPORT_ERROR');
    await expect(cua.close()).rejects.toMatchObject(unsafe);
  });

  it.each([
    ['invalid MCP envelope', { content: 'PRIVATE_CLIPBOARD' }],
    ['missing structured acknowledgement', { content: [] }],
    ['tool failure', { content: [], isError: true }],
    [
      'native failure',
      { content: [], structuredContent: { error: 'PRIVATE_CLIPBOARD' } },
    ],
    [
      'unconfirmed clipboard restoration',
      { content: [], structuredContent: { clipboard_restored: false } },
    ],
  ])('fails closed on %s for a mutation', async (_description, result) => {
    const sdkClose = vi.spyOn(Client.prototype, 'close');
    callTool.mockResolvedValueOnce(result as unknown as CallToolResult);
    const cua = await connect();
    const error: unknown = await cua
      .call('paste_text', { text: 'PRIVATE_CLIPBOARD' }, 100)
      .catch((failure: unknown) => failure);
    expect(error).toMatchObject(unsafe);
    expect(error).not.toHaveProperty('cause');
    expect(String(error)).not.toContain('PRIVATE_CLIPBOARD');
    await expect(cua.close()).rejects.toMatchObject(unsafe);
    await expect(cua.call('launch_app', {}, 100)).rejects.toMatchObject(unsafe);
    expect(sdkClose).not.toHaveBeenCalled();
    expect(callTool).toHaveBeenCalledTimes(1);
  });

  it('treats unknown operations as mutating, not as read-only by naming convention', async () => {
    callTool.mockRejectedValueOnce(new Error('PRIVATE_CLIPBOARD'));
    const cua = await connect();
    await expect(
      cua.call('get_and_clear_clipboard', {}, 100)
    ).rejects.toMatchObject(unsafe);
    await expect(cua.close()).rejects.toMatchObject(unsafe);
  });

  it('does not strand the runtime after a settled read-only failure', async () => {
    const sdkClose = vi.spyOn(Client.prototype, 'close');
    callTool.mockRejectedValueOnce(new Error('PRIVATE_SERVER_ERROR'));
    const cua = await connect();
    const error: unknown = await cua
      .call('list_apps', {}, 100)
      .catch((failure: unknown) => failure);
    expect(error).toBeInstanceOf(Error);
    expect(String(error)).not.toContain('PRIVATE_SERVER_ERROR');
    await expect(cua.call('launch_app', {}, 100)).rejects.toThrow();
    expect(callTool).toHaveBeenCalledTimes(1);
    await cua.close();
    expect(sdkClose).toHaveBeenCalledTimes(1);
  });

  it('accepts the legacy text-only kill acknowledgement', async () => {
    callTool.mockResolvedValueOnce({
      content: [{ type: 'text', text: 'killed' }],
    });
    const cua = await connect();
    await expect(cua.call('kill_app', { pid: 42 }, 100)).resolves.toMatchObject(
      {
        content: [{ type: 'text', text: 'killed' }],
      }
    );
    await cua.close();
  });

  it('does not expose an underlying close error or reopen the connection', async () => {
    const cua = await connect();
    vi.spyOn(Client.prototype, 'close').mockRejectedValueOnce(
      new Error('PRIVATE_CLOSE_ERROR')
    );
    const error: unknown = await cua
      .close()
      .catch((failure: unknown) => failure);
    expect(error).toMatchObject({ message: 'Cua runtime close failed' });
    expect(error).not.toHaveProperty('cause');
    expect(String(error)).not.toContain('PRIVATE_CLOSE_ERROR');
    await expect(cua.call('launch_app', {}, 100)).rejects.toThrow(/clos/);
    expect(callTool).not.toHaveBeenCalled();
  });

  it('rejects requests once a clean close begins', async () => {
    const cua = await connect();
    const closing = cua.close();
    await expect(cua.call('launch_app', {}, 100)).rejects.toThrow(/clos/);
    await closing;
    await expect(cua.call('list_apps', {}, 100)).rejects.toThrow(/clos/);
    expect(callTool).not.toHaveBeenCalled();
  });
});
