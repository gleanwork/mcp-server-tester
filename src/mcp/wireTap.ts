import type { Client, JSONRPCMessage } from '@modelcontextprotocol/client';

/** A JSON-RPC message observed on a client's transport. */
export interface WireFrame {
  direction: 'in' | 'out';
  message: JSONRPCMessage;
}

/** A request paired with the response the server sent for it. */
export interface WireExchange {
  method: string;
  request: Record<string, unknown>;
  response: Record<string, unknown>;
}

const DEFAULT_MAX_FRAMES = 1000;

/**
 * Records the raw JSON-RPC frames of one connection.
 *
 * The SDK normalizes results (for example it drops `resultType`), so checks
 * that need to see exactly what the server sent read from the tap instead.
 * The buffer is bounded; the oldest frames are discarded first.
 */
export class WireTap {
  private readonly frames: WireFrame[] = [];

  constructor(private readonly maxFrames = DEFAULT_MAX_FRAMES) {}

  record(direction: WireFrame['direction'], message: JSONRPCMessage): void {
    this.frames.push({ direction, message });
    if (this.frames.length > this.maxFrames) this.frames.shift();
  }

  /** All recorded frames, oldest first. */
  all(): readonly WireFrame[] {
    return this.frames;
  }

  /**
   * Request/response pairs, oldest first. Only complete pairs are returned.
   */
  exchanges(): WireExchange[] {
    const requests = new Map<string | number, Record<string, unknown>>();
    const pairs: WireExchange[] = [];
    for (const { direction, message } of this.frames) {
      const frame = message as Record<string, unknown>;
      const id = frame.id as string | number | undefined;
      if (id === undefined) continue;
      if (direction === 'out' && typeof frame.method === 'string') {
        requests.set(id, frame);
      } else if (direction === 'in' && !('method' in frame)) {
        const request = requests.get(id);
        if (request) {
          pairs.push({
            method: request.method as string,
            request,
            response: frame,
          });
          requests.delete(id);
        }
      }
    }
    return pairs;
  }

  /** The most recent exchange for a method, if any. */
  lastExchange(method: string): WireExchange | undefined {
    return this.exchanges()
      .filter((exchange) => exchange.method === method)
      .at(-1);
  }
}

const taps = new WeakMap<Client, WireTap>();

/**
 * Starts recording a connected client's transport frames. Call after
 * `connect()`; frames exchanged during the handshake are not recorded.
 */
export function attachWireTap(client: Client): WireTap | undefined {
  const transport = client.transport;
  if (!transport) return undefined;
  const existing = taps.get(client);
  if (existing) return existing;

  const tap = new WireTap();
  const onmessage = transport.onmessage;
  transport.onmessage = (message, extra) => {
    tap.record('in', message);
    onmessage?.(message, extra);
  };
  const send = transport.send.bind(transport);
  transport.send = (message, options) => {
    tap.record('out', message);
    return send(message, options);
  };
  taps.set(client, tap);
  return tap;
}

/** Returns the wire tap for a client created by MST, if any. */
export function getWireTap(client: Client): WireTap | undefined {
  return taps.get(client);
}
