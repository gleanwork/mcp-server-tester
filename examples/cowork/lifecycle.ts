import type { CoworkCuaConnection } from '@gleanwork/mcp-server-tester';

export interface RuntimeDisposition {
  runtimeRetained: boolean;
  reason: 'closed' | 'host-quarantined' | 'close-refused-or-failed';
  closeError?: string;
}

export async function finishRuntime(
  cua: Pick<CoworkCuaConnection, 'close'>,
  quarantined: boolean
): Promise<RuntimeDisposition> {
  if (quarantined) return { runtimeRetained: true, reason: 'host-quarantined' };
  try {
    await cua.close();
    return { runtimeRetained: false, reason: 'closed' };
  } catch (error) {
    return {
      runtimeRetained: true,
      reason: 'close-refused-or-failed',
      closeError:
        error instanceof Error ? error.message : 'Unknown close error',
    };
  }
}

const retainedConnections = new Set<CoworkCuaConnection>();

export function retainRuntime(cua: CoworkCuaConnection): void {
  retainedConnections.add(cua);
  if (retainedConnections.size === 1) {
    // Keep the worker alive even if broken stdio no longer keeps Node running.
    // There is deliberately no automatic close, retry, or timeout here.
    setInterval(() => void retainedConnections.size, 60_000);
  }
}
