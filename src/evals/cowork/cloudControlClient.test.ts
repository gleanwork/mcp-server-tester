import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server, type Socket } from 'node:net';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createCoworkCloudControlClient } from './cloudControlClient.js';
import {
  COWORK_CLOUD_CONTROL_MAX_FRAME_BYTES,
  COWORK_CLOUD_CONTROL_PROTOCOL,
  type CoworkCloudControlRequest,
} from './cloudControlProtocol.js';

describe('worker cloud-control domain RPC (offline Unix socket)', () => {
  let directory: string;
  let server: Server | undefined;
  const sockets = new Set<Socket>();
  const clients: Array<ReturnType<typeof createCoworkCloudControlClient>> = [];
  beforeEach(async () => {
    directory = await mkdtemp('/tmp/mst-rpc-');
  });
  afterEach(async () => {
    for (const client of clients.splice(0)) client.close();
    for (const socket of sockets) socket.destroy();
    sockets.clear();
    if (server)
      await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = undefined;
    await rm(directory, { recursive: true, force: true });
  });
  async function serve(
    handler: (request: CoworkCloudControlRequest, socket: Socket) => void
  ) {
    const path = join(directory, 'control.sock');
    server = createServer((socket) => {
      sockets.add(socket);
      socket.on('close', () => sockets.delete(socket));
      socket.on('error', () => undefined);
      let pending = '';
      socket.on('data', (data) => {
        pending += data.toString();
        let newline: number;
        while ((newline = pending.indexOf('\n')) >= 0) {
          const line = pending.slice(0, newline);
          pending = pending.slice(newline + 1);
          handler(JSON.parse(line) as CoworkCloudControlRequest, socket);
        }
      });
    });
    await new Promise<void>((resolve) => server!.listen(path, resolve));
    await chmod(path, 0o600);
    const client = createCoworkCloudControlClient({
      MST_COWORK_CLOUD_CONTROL_SOCKET: path,
    });
    clients.push(client);
    return { client, path };
  }
  function reply(request: CoworkCloudControlRequest, result: unknown) {
    return `${JSON.stringify({ protocol: COWORK_CLOUD_CONTROL_PROTOCOL, id: request.id, ok: true, result })}\n`;
  }

  it('fails closed without a private socket and never reconnects after transport loss', async () => {
    const missing = createCoworkCloudControlClient({});
    await expect(missing.call({ method: 'prepare' })).rejects.toThrow(
      /requires private/
    );
    const { client } = await serve((_request, socket) => socket.destroy());
    await expect(
      client.call({ method: 'beginTask', prompt: 'authorized' })
    ).rejects.toThrow(/disconnected/);
    await expect(client.call({ method: 'restore' })).rejects.toThrow(
      /disconnected/
    );
  });

  it('rejects non-sockets and world-accessible paths before sending', async () => {
    const file = join(directory, 'not-a-socket');
    await writeFile(file, '', { mode: 0o600 });
    await expect(
      createCoworkCloudControlClient({
        MST_COWORK_CLOUD_CONTROL_SOCKET: file,
      }).call({ method: 'prepare' })
    ).rejects.toThrow(/owner-only Unix socket/);
    let received = 0;
    const { client, path } = await serve(() => {
      received++;
    });
    await chmod(path, 0o666);
    await expect(client.call({ method: 'prepare' })).rejects.toThrow(
      /owner-only Unix socket/
    );
    expect(received).toBe(0);
  });

  it('handles chunked frames and serializes calls with exact request correlation', async () => {
    const observed: string[] = [];
    const { client } = await serve((request, socket) => {
      observed.push(request.method);
      const frame = reply(request, request.method);
      socket.write(frame.slice(0, 5));
      setImmediate(() => socket.write(frame.slice(5)));
    });
    const results = await Promise.all([
      client.call({ method: 'prepare' }),
      client.call({ method: 'beginTask', prompt: 'authorized' }),
    ]);
    expect(results).toEqual(['prepare', 'beginTask']);
    expect(observed).toEqual(['prepare', 'beginTask']);
  });

  it('assembles fragmented UTF-8 responses with linear copying and newline scanning', async () => {
    const result = '🌍'.repeat(256 * 1024);
    let frameBytes = 0;
    const { client } = await serve((request, socket) => {
      const frame = Buffer.from(reply(request, result));
      frameBytes = frame.length;
      // Split inside the first four-byte character, not only between characters.
      const split = frame.indexOf(Buffer.from('🌍')) + 1;
      socket.write(frame.subarray(0, split));
      let offset = split;
      function send(): void {
        if (socket.destroyed || offset === frame.length) return;
        const end = Math.min(offset + 16 * 1024, frame.length);
        socket.write(frame.subarray(offset, end));
        offset = end;
        setImmediate(send);
      }
      setImmediate(send);
    });
    const scans = vi.spyOn(Buffer.prototype, 'indexOf');
    const copies = vi.spyOn(Buffer, 'concat');
    const byteLengths = vi.spyOn(Buffer, 'byteLength');
    try {
      await expect(client.call({ method: 'listSessions' })).resolves.toBe(
        result
      );
      const newlineScans = scans.mock.calls.flatMap((args, index) => {
        const buffer = scans.mock.contexts[index] as Buffer;
        return args[0] === 10 ? [buffer.length] : [];
      });
      expect(newlineScans.length).toBeGreaterThan(1);
      expect(newlineScans.reduce((sum, length) => sum + length, 0)).toBe(
        frameBytes
      );
      expect(
        copies.mock.calls.reduce(
          (sum, [chunks]) =>
            sum + chunks.reduce((size, chunk) => size + chunk.length, 0),
          0
        )
      ).toBe(frameBytes);
      // Request sizing is fine; rescanning the growing response is not.
      expect(
        byteLengths.mock.calls.reduce(
          (sum, [value]) =>
            sum + (typeof value === 'string' ? value.length : value.byteLength),
          0
        )
      ).toBeLessThan(frameBytes);
    } finally {
      scans.mockRestore();
      copies.mockRestore();
      byteLengths.mockRestore();
    }
  });

  it('fails closed when fragmented bytes exceed the limit before a newline', async () => {
    const { client } = await serve((_request, socket) => {
      const chunk = Buffer.alloc(64 * 1024, 'x');
      let sent = 0;
      function send(): void {
        if (socket.destroyed) return;
        if (sent === COWORK_CLOUD_CONTROL_MAX_FRAME_BYTES) {
          socket.write('x');
          return;
        }
        socket.write(chunk);
        sent += chunk.length;
        setImmediate(send);
      }
      send();
    });
    await expect(client.call({ method: 'listSessions' })).rejects.toThrow(
      /disconnected/
    );
    await expect(client.call({ method: 'restore' })).rejects.toThrow(
      /disconnected/
    );
  });

  it.each(['id', 'protocol', 'extra-frame', 'oversize', 'malformed'] as const)(
    'fails closed on %s responses',
    async (fault) => {
      const { client } = await serve((request, socket) => {
        if (fault === 'id')
          socket.write(reply({ ...request, id: request.id + 1 }, null));
        if (fault === 'protocol')
          socket.write(
            `${JSON.stringify({ protocol: 'other', id: request.id, ok: true, result: null })}\n`
          );
        if (fault === 'extra-frame')
          socket.write(reply(request, null) + reply(request, null));
        if (fault === 'oversize')
          socket.write('x'.repeat(COWORK_CLOUD_CONTROL_MAX_FRAME_BYTES + 1));
        if (fault === 'malformed') socket.write('not JSON\n');
      });
      await expect(client.call({ method: 'listSessions' })).rejects.toThrow(
        /disconnected/
      );
      await expect(client.call({ method: 'restore' })).rejects.toThrow(
        /disconnected/
      );
    }
  );

  it('allows a source-domain rejection without claiming completion or changing authority', async () => {
    const { client } = await serve((request, socket) => {
      if (request.method === 'confirmTaskComplete')
        socket.write(
          `${JSON.stringify({ protocol: COWORK_CLOUD_CONTROL_PROTOCOL, id: request.id, ok: false, error: 'Task still running; recovery state retained.' })}\n`
        );
      else socket.write(reply(request, null));
    });
    await expect(
      client.call({ method: 'confirmTaskComplete' })
    ).rejects.toThrow(/still running/);
    await expect(client.call({ method: 'restore' })).resolves.toBeNull();
  });
});
