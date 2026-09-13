import { isAbsolute } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import {
  CallToolResultSchema,
  type CallToolResult,
} from '@modelcontextprotocol/sdk/types.js';
import type { CoworkCuaTransport } from './types.js';
import { CoworkControlError } from './workflow.js';

// The host owns execution (max 10 min) and cleanup (max 30 sec) deadlines.
// The SDK discards late replies on timeout, so allow another 30 sec beyond both.
const RPC_TIMEOUT_MS = 600_000 + 30_000 + 30_000;
const READ_ONLY_OPERATIONS = new Set([
  'list_apps',
  'list_windows',
  'get_window_state',
]);

export interface CoworkCuaConnection extends CoworkCuaTransport {
  /**
   * Close after run() completes cleanup. Refuses without terminating the runtime
   * while any RPC is pending or a mutation has an indeterminate outcome.
   */
  close(): Promise<void>;
}

/**
 * Connect once; Cua's launch/kill ownership is runtime-local. No GUI action is
 * performed here. Runtime version alone does not qualify AXURL or paste support.
 */
export async function connectCoworkCua(options: {
  command: string;
  connectTimeoutMs?: number;
}): Promise<CoworkCuaConnection> {
  if (!isAbsolute(options.command))
    throw new TypeError('an explicit absolute Cua runtime command is required');
  const transport = new StdioClientTransport({
    command: options.command,
    args: ['mcp', '--direct'],
    env: {
      CUA_DRIVER_PERMISSION_MODE: 'standard',
      CUA_DRIVER_RS_TELEMETRY_ENABLED: 'false',
    },
    stderr: 'ignore',
  });
  const client = new Client({
    name: 'mcp-server-tester-cowork',
    version: '1.0.0',
  });
  try {
    await client.connect(transport, {
      timeout: options.connectTimeoutMs ?? 15_000,
    });
  } catch {
    // Initialization cannot have issued a native operation. Do not expose raw
    // SDK errors (or cleanup errors), which can contain private runtime details.
    await client.close().catch(() => {});
    throw new CoworkControlError('Cua runtime connection failed');
  }

  // Keep raw RPCs independent of the host's deadline race. Mutation identities
  // outlive rejected RPCs without retaining their arguments or error payloads.
  const pending = new Map<Promise<unknown>, symbol | undefined>();
  const indeterminateMutations = new Set<symbol>();
  let unavailable = false;
  let closing: Promise<void> | undefined;
  function transportFailed(): void {
    unavailable = true;
    for (const mutation of pending.values()) {
      if (mutation) indeterminateMutations.add(mutation);
    }
  }
  // SDK onerror does not necessarily reject requests. Preserve their promises,
  // but refuse further work on a channel whose acknowledgements are uncertain.
  client.onerror = transportFailed;
  client.onclose = () => {
    if (!closing) transportFailed();
  };

  function requireAvailable(): void {
    if (closing)
      throw new CoworkControlError('Cua runtime is closing or closed');
    if (unavailable || indeterminateMutations.size > 0)
      throw new CoworkControlError(
        'Cua runtime is unavailable after a failed request',
        { quarantine: indeterminateMutations.size > 0 }
      );
  }

  return {
    async call(name, args, _timeoutMs) {
      requireAvailable();
      const mutation = READ_ONLY_OPERATIONS.has(name) ? undefined : Symbol();
      // Defer dispatch until tracking is installed, including for synchronous
      // transport errors. Never pass the host's short timeout or abort signal.
      const request = Promise.resolve().then(() => {
        requireAvailable();
        return client.callTool({ name, arguments: args }, undefined, {
          timeout: RPC_TIMEOUT_MS,
          maxTotalTimeout: RPC_TIMEOUT_MS,
        });
      });
      pending.set(request, mutation);
      try {
        const result = CallToolResultSchema.parse(await request);
        if (
          mutation &&
          (indeterminateMutations.has(mutation) ||
            !acknowledgedMutation(name, result))
        )
          throw new CoworkControlError(
            'Cua mutation acknowledgement is uncertain'
          );
        return result;
      } catch {
        // A rejected/invalid RPC is not cancellation or proof that native work
        // stopped. SDK timeout/connection loss can discard all future replies.
        transportFailed();
        throw new CoworkControlError(
          'Cua request failed; native state may be uncertain',
          {
            quarantine: indeterminateMutations.size > 0,
          }
        );
      } finally {
        pending.delete(request);
      }
    },
    async close() {
      if (closing) return closing;
      if (pending.size > 0 || indeterminateMutations.size > 0)
        throw new CoworkControlError(
          'Cua runtime close refused: native operations are pending or indeterminate',
          { quarantine: true }
        );
      // Block new calls before shutdown starts. Repeated clean closes share one
      // promise; no force-close escape hatch may destroy a native backup.
      closing = Promise.resolve()
        .then(() => client.close())
        .catch(() => {
          throw new CoworkControlError('Cua runtime close failed');
        });
      return closing;
    },
  };
}

function acknowledgedMutation(name: string, result: CallToolResult): boolean {
  const data = result.structuredContent;
  if (data?.error || data?.success === false) return false;
  if (result.isError) {
    // The qualified native paste producer returns this proof after its worker
    // settles, even on refusal or key-delivery failure. Preserve the error for
    // the host, but allow owned-process cleanup once restoration is confirmed.
    return (
      name === 'paste_text' &&
      data?.clipboard_restored === true &&
      (data.effect === 'refused' || data.effect === 'unverifiable')
    );
  }
  // Legacy kill_app returns text only; the host independently verifies PID exit.
  if (!data) return name === 'kill_app';
  // A paste acknowledgement without restoration proof must also prevent close.
  return name !== 'paste_text' || data.clipboard_restored === true;
}
