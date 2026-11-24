/**
 * One AT-SPI client that stays on the accessibility bus for a batch.
 *
 * at-spi2's ATK bridge gives an application a key listener while it has a
 * client, and removes it when the last client leaves the bus. The listener
 * waits for the registry in a nested main loop, so the removal can run while
 * the application is still inside it; Chromium, Electron and GTK 3 then
 * crash. agent-desktop is a client only while a command runs: a command that
 * sends a key exits a fraction of a millisecond later, as the last client
 * (https://github.com/vercel-labs/agent-desktop/issues/529).
 *
 * A client that outlives every command keeps the listener in place. It has
 * to be held by the process that owns the batch: a driver operation is its
 * own short process, and a client it held would leave just as early. This
 * module goes when a release of agent-desktop keeps its own client.
 */
import {
  ATSPI_REGISTRY,
  openAtspiBus,
  type AtspiBus,
} from '../linuxAtspiBus.js';

const REGISTRY_PATH = '/org/a11y/atspi/registry';
/** Any event makes a client; this is the one agent-desktop registers. */
const HELD_EVENT = 'window:activate';
const CONNECT_TIMEOUT_MS = 5_000;

type HeldBus = Pick<AtspiBus, 'call' | 'close' | 'unref'>;

export interface AccessibilityClientOptions {
  /** Opens the accessibility bus. Tests pass their own. */
  open?: (
    env: Record<string, string | undefined>,
    deadlineAt: number
  ) => Promise<HeldBus>;
}

/**
 * Registers one event listener on the accessibility bus and keeps the
 * connection. Returns the function that leaves the bus; calling it again
 * does nothing. Throws when the bus can't be reached or refuses the
 * listener, so a batch never sends keys without the client.
 */
export async function holdAccessibilityClient(
  env: Record<string, string | undefined>,
  options: AccessibilityClientOptions = {}
): Promise<() => void> {
  const open = options.open ?? openAtspiBus;
  const bus = await open(env, Date.now() + CONNECT_TIMEOUT_MS);
  try {
    await bus.call({
      destination: ATSPI_REGISTRY,
      path: REGISTRY_PATH,
      interface: ATSPI_REGISTRY,
      member: 'RegisterEvent',
      signature: 'sass',
      body: [HELD_EVENT, [], ''],
    });
  } catch (error) {
    bus.close();
    throw error;
  }
  // The connection must not keep a finished MST process running.
  bus.unref();
  let released = false;
  return () => {
    if (released) return;
    released = true;
    bus.close();
  };
}
