import { describe, expect, it, vi } from 'vitest';
import { holdAccessibilityClient } from './heldAccessibilityClient.js';

function fakeBus(call = vi.fn().mockResolvedValue(undefined)) {
  return { call, close: vi.fn(), unref: vi.fn() };
}
const env = { DBUS_SESSION_BUS_ADDRESS: 'unix:path=/fixture' };

describe('the held accessibility client', () => {
  it('registers one event listener and stays on the bus until released', async () => {
    const bus = fakeBus();
    const open = vi.fn().mockResolvedValue(bus);

    const release = await holdAccessibilityClient(env, { open });

    expect(open).toHaveBeenCalledOnce();
    expect(open.mock.calls[0]![0]).toBe(env);
    expect(bus.call).toHaveBeenCalledExactlyOnceWith({
      destination: 'org.a11y.atspi.Registry',
      path: '/org/a11y/atspi/registry',
      interface: 'org.a11y.atspi.Registry',
      member: 'RegisterEvent',
      signature: 'sass',
      body: ['window:activate', [], ''],
    });
    // Connected, and not what keeps MST running.
    expect(bus.close).not.toHaveBeenCalled();
    expect(bus.unref).toHaveBeenCalledOnce();

    release();
    release();
    expect(bus.close).toHaveBeenCalledOnce();
  });

  it('leaves the bus and fails when the registry refuses the listener', async () => {
    const bus = fakeBus(vi.fn().mockRejectedValue(new Error('refused')));

    await expect(
      holdAccessibilityClient(env, { open: async () => bus })
    ).rejects.toThrow('refused');
    expect(bus.close).toHaveBeenCalledOnce();
    expect(bus.unref).not.toHaveBeenCalled();
  });

  it('fails when the accessibility bus cannot be reached', async () => {
    await expect(
      holdAccessibilityClient(env, {
        open: async () => {
          throw new Error('accessibility_bus_disconnected');
        },
      })
    ).rejects.toThrow('accessibility_bus_disconnected');
  });
});
