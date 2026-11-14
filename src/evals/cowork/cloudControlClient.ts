import { lstat } from 'node:fs/promises';
import { createConnection, type Socket } from 'node:net';
import { dirname, isAbsolute } from 'node:path';
import {
  COWORK_CLOUD_CONTROL_MAX_FRAME_BYTES,
  COWORK_CLOUD_CONTROL_PROTOCOL,
  CoworkCloudControlResponseSchema,
  type CoworkCloudControlCommand,
} from './cloudControlProtocol.js';

/** How long the worker waits for the source to answer one request. */
const REPLY_TIMEOUT_MS = 120_000;

/** Worker-only, fixed domain RPC. Never falls back to local Chrome or permissions. */
export function createCoworkCloudControlClient(
  env: Record<string, string | undefined>
) {
  const path = env.MST_COWORK_CLOUD_CONTROL_SOCKET;
  let socket: Socket | undefined;
  let failure: Error | undefined;
  let nextId = 0;
  let changes = Promise.resolve();
  let pending:
    | {
        id: number;
        method: CoworkCloudControlCommand['method'];
        resolve(value: unknown): void;
        reject(error: Error): void;
        timer: NodeJS.Timeout;
      }
    | undefined;
  let chunks: Buffer[] = [];
  let byteLength = 0;
  // The first cause is the one reported: later failures (the close after a
  // timeout, a call after loss) only repeat it.
  function fail(cause: string): void {
    failure ??= new Error(
      `Cowork source cloud control disconnected or sent invalid evidence (${cause}); no local/gateway fallback is permitted. Source recovery state must be retained.`
    );
    if (pending) {
      clearTimeout(pending.timer);
      pending.reject(failure);
      pending = undefined;
    }
    socket?.destroy();
  }
  async function connect(): Promise<Socket> {
    if (failure) throw failure;
    if (socket) return socket;
    if (!path || !isAbsolute(path))
      throw new Error(
        'Linux first-party Cowork requires private MST_COWORK_CLOUD_CONTROL_SOCKET.'
      );
    const [file, directory] = await Promise.all([
      lstat(path),
      lstat(dirname(path)),
    ]);
    const uid = process.getuid?.();
    if (
      !file.isSocket() ||
      !directory.isDirectory() ||
      (file.mode & 0o077) !== 0 ||
      (directory.mode & 0o077) !== 0 ||
      (uid !== undefined && (file.uid !== uid || directory.uid !== uid))
    )
      throw new Error(
        'Cowork cloud control requires an owner-only Unix socket and directory.'
      );
    socket = createConnection(path);
    socket.unref();
    socket.on('error', (error: NodeJS.ErrnoException) =>
      fail(`socket error${error.code ? ` ${error.code}` : ''}`)
    );
    socket.on('close', () =>
      fail(
        pending
          ? `socket closed while waiting for ${pending.method}`
          : 'socket closed'
      )
    );
    socket.on('data', (chunk: Buffer) => {
      if (!pending) {
        fail('data arrived with no request pending');
        return;
      }
      if (byteLength + chunk.length > COWORK_CLOUD_CONTROL_MAX_FRAME_BYTES) {
        fail(
          `the ${pending.method} reply exceeds ${COWORK_CLOUD_CONTROL_MAX_FRAME_BYTES} bytes`
        );
        return;
      }
      chunks.push(chunk);
      byteLength += chunk.length;
      const newline = chunk.indexOf(10);
      if (newline < 0) return;
      if (newline !== chunk.length - 1) {
        fail(`bytes followed the ${pending.method} reply`);
        return;
      }
      try {
        // Join and decode only the complete frame, preserving split UTF-8 bytes.
        const bytes = Buffer.concat(chunks, byteLength);
        const response = CoworkCloudControlResponseSchema.parse(
          JSON.parse(bytes.subarray(0, byteLength - 1).toString('utf8'))
        );
        if (response.id !== pending.id) {
          fail(`a reply to request ${response.id} came for ${pending.id}`);
          return;
        }
        const completed = pending;
        pending = undefined;
        chunks = [];
        byteLength = 0;
        clearTimeout(completed.timer);
        if (response.ok) completed.resolve(response.result);
        else completed.reject(new Error(response.error));
      } catch {
        fail(
          `the ${pending?.method ?? 'request'} reply is not a cloud-control response`
        );
      }
    });
    const connected = socket;
    await new Promise<void>((resolve, reject) => {
      connected.once('connect', resolve);
      connected.once('error', () =>
        reject(new Error('Cowork source cloud control connection failed.'))
      );
    });
    if (connected.destroyed)
      throw new Error(
        'Cowork source cloud control disconnected during connection.'
      );
    return connected;
  }
  return {
    async call(command: CoworkCloudControlCommand): Promise<unknown> {
      const result = changes.then(async () => {
        try {
          const connected = await connect();
          const id = ++nextId;
          const frame = `${JSON.stringify({ protocol: COWORK_CLOUD_CONTROL_PROTOCOL, id, ...command })}\n`;
          if (Buffer.byteLength(frame) > COWORK_CLOUD_CONTROL_MAX_FRAME_BYTES)
            throw new Error(
              'Cowork cloud control request exceeds its frame limit.'
            );
          return await new Promise<unknown>((resolve, reject) => {
            pending = {
              id,
              method: command.method,
              resolve,
              reject,
              timer: setTimeout(
                () =>
                  fail(
                    `no ${command.method} reply within ${REPLY_TIMEOUT_MS / 1000} s`
                  ),
                REPLY_TIMEOUT_MS
              ),
            };
            connected.write(frame, (error) => {
              if (error) fail(`sending ${command.method} failed`);
            });
          });
        } catch (error) {
          // A domain rejection is usable (e.g. a task is still running), but a
          // missing transport can never be retried through another authority.
          if (!socket || socket.destroyed)
            failure ??= new Error(
              'Cowork source cloud control is unavailable; no fallback is permitted.'
            );
          throw error;
        }
      });
      changes = result.then(
        () => undefined,
        () => undefined
      );
      return result;
    },
    close() {
      socket?.destroy();
    },
  };
}
