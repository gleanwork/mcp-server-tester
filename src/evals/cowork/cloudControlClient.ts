import { lstat } from 'node:fs/promises';
import { createConnection, type Socket } from 'node:net';
import { dirname, isAbsolute } from 'node:path';
import {
  COWORK_CLOUD_CONTROL_MAX_FRAME_BYTES,
  COWORK_CLOUD_CONTROL_PROTOCOL,
  CoworkCloudControlResponseSchema,
  type CoworkCloudControlCommand,
} from './cloudControlProtocol.js';

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
        resolve(value: unknown): void;
        reject(error: Error): void;
        timer: NodeJS.Timeout;
      }
    | undefined;
  let bytes = Buffer.alloc(0);
  function fail(): void {
    failure ??= new Error(
      'Cowork source cloud control disconnected or sent invalid evidence; no local/gateway fallback is permitted. Source recovery state must be retained.'
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
    socket.on('error', fail);
    socket.on('close', fail);
    socket.on('data', (chunk: Buffer) => {
      if (
        !pending ||
        bytes.length + chunk.length > COWORK_CLOUD_CONTROL_MAX_FRAME_BYTES
      ) {
        fail();
        return;
      }
      bytes = Buffer.concat([bytes, chunk]);
      const newline = bytes.indexOf(10);
      if (newline < 0) return;
      if (newline !== bytes.length - 1) {
        fail();
        return;
      }
      try {
        const response = CoworkCloudControlResponseSchema.parse(
          JSON.parse(bytes.subarray(0, newline).toString('utf8'))
        );
        if (response.id !== pending.id) {
          fail();
          return;
        }
        const completed = pending;
        pending = undefined;
        bytes = Buffer.alloc(0);
        clearTimeout(completed.timer);
        if (response.ok) completed.resolve(response.result);
        else completed.reject(new Error(response.error));
      } catch {
        fail();
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
            pending = { id, resolve, reject, timer: setTimeout(fail, 120_000) };
            connected.write(frame, (error) => {
              if (error) fail();
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
