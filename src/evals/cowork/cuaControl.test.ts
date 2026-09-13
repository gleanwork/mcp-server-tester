import { describe, expect, it, vi } from 'vitest';
import { createCuaCoworkControl } from './cuaControl.js';
import { CoworkControlError, submitCoworkPrompt } from './workflow.js';
import type { CoworkControlContext } from './types.js';

function fixture(
  options: {
    url?: boolean;
    exactWindow?: boolean;
    wrongPid?: boolean;
    noPaste?: boolean;
    pasteError?: boolean;
    failure?: Error;
    nativeReply?: { effect: string; clipboard_restored: boolean };
  } = {}
) {
  let value = 'retained draft';
  const calls: string[] = [];
  const context: CoworkControlContext = {
    pid: 42,
    windowId: 7,
    async call(name, args) {
      calls.push(name);
      if (name === 'launch_app') return { pid: options.wrongPid ? 99 : 42 };
      if (name === 'get_window_state')
        return {
          elements: [
            { role: 'AXWebArea', label: 'Claude shell' },
            {
              role: 'AXWebArea',
              label: 'New task - Claude',
              url: options.url !== false ? 'https://claude.ai/new' : undefined,
              depth: 1,
              element_index: 1,
            },
            {
              role: 'AXTextArea',
              value,
              in_web_content: true,
              element_token: 'snapshot:2',
            },
            { role: 'AXPopUpButton', label: 'Automatically approve' },
          ],
        };
      if (name === 'bring_to_front')
        return {
          activated: true,
          pid: 42,
          window_id: 7,
          exact_window_effect: { verified: options.exactWindow !== false },
        };
      if (name === 'paste_text' && options.failure !== undefined)
        throw options.failure;
      if (name === 'paste_text' && options.nativeReply) {
        expect(args).toEqual({
          pid: 42,
          window_id: 7,
          text: 'native prompt\nmarker',
        });
        value = String(args.text);
        return options.nativeReply;
      }
      if (name === 'press_key') return { effect: 'unverifiable' };
      // Stale NSWorkspace state must never be queried to veto exact_window_effect.
      if (name === 'list_apps') return { apps: [{ pid: 42, active: false }] };
      throw new Error(`unexpected ${name}`);
    },
  };
  const pasteText = vi.fn(
    async (input: CoworkControlContext & { text: string }) => {
      expect(input.pid).toBe(42);
      expect(input.windowId).toBe(7);
      if (options.pasteError) throw new Error('PRIVATE_CLIPBOARD');
      if (options.failure !== undefined) throw options.failure;
      value = input.text;
    }
  );
  const control = createCuaCoworkControl(
    context,
    options.noPaste ? {} : { pasteText }
  );
  const beforeSubmit = vi.fn(async () => {});
  return {
    calls,
    control,
    pasteText,
    beforeSubmit,
    run: () =>
      submitCoworkPrompt({
        control,
        text: 'native prompt\nmarker',
        deadline: Date.now() + 500,
        pollIntervalMs: 5,
        beforeSubmit,
      }),
  };
}

describe('Cua adapter without GUI', () => {
  it('trusts exact_window_effect, not stale NSWorkspace active; uses one atomic paste', async () => {
    const f = fixture();
    await expect(f.run()).resolves.toMatchObject({ inputMode: 'keyboard' });
    expect(f.pasteText).toHaveBeenCalledTimes(1);
    expect(f.calls).not.toContain('list_apps');
    expect(f.calls.some((name) => name.startsWith('clipboard_'))).toBe(false);
    expect(f.beforeSubmit).toHaveBeenCalledTimes(1);
  });
  it('fails before modifying draft when stock Cua cannot expose AXURL', async () => {
    const f = fixture({ url: false });
    await expect(f.run()).rejects.toThrow(/AXURL/);
    expect(f.pasteText).not.toHaveBeenCalled();
    expect(f.beforeSubmit).not.toHaveBeenCalled();
  });
  it('marks uncertain native clipboard restoration for lifecycle quarantine', async () => {
    const f = fixture({ pasteError: true });
    await expect(f.run()).rejects.toMatchObject({
      fatal: true,
      quarantine: true,
    });
  });
  it('cannot substitute AX echo for native transactional paste', async () => {
    const f = fixture({ noPaste: true });
    await expect(f.run()).rejects.toThrow(/transactional paste/);
    expect(f.calls).not.toContain('set_value');
    expect(f.beforeSubmit).not.toHaveBeenCalled();
  });
  it('uses the native single-call paste_text bridge by default', async () => {
    const f = fixture({
      noPaste: true,
      nativeReply: { effect: 'unverifiable', clipboard_restored: true },
    });
    await expect(f.run()).resolves.toMatchObject({ inputMode: 'keyboard' });
    expect(f.calls.filter((name) => name === 'paste_text')).toHaveLength(1);
    expect(f.beforeSubmit).toHaveBeenCalledTimes(1);
  });
  it('never submits when native paste cannot prove clipboard restoration', async () => {
    const f = fixture({
      noPaste: true,
      nativeReply: { effect: 'unverifiable', clipboard_restored: false },
    });
    await expect(f.run()).rejects.toMatchObject({
      fatal: true,
      quarantine: true,
    });
    expect(f.beforeSubmit).not.toHaveBeenCalled();
  });
  describe.each(['native bridge', 'custom paste'] as const)(
    '%s errors',
    (source) => {
      it.each([
        { fatal: true, quarantine: false },
        { fatal: false, quarantine: false },
        { fatal: true, quarantine: true },
      ])(
        'preserves cross-copy flags and scrubs clipboard data: %o',
        async (flags) => {
          vi.resetModules();
          const { CoworkControlError: OtherCopyError } =
            await import('./workflow.js');
          expect(OtherCopyError).not.toBe(CoworkControlError);
          const f = fixture({
            noPaste: source === 'native bridge',
            failure: new OtherCopyError('PRIVATE_CLIPBOARD', flags),
          });
          await expect(
            f.control.paste('native prompt\nmarker')
          ).rejects.toMatchObject({
            ...flags,
            message: expect.not.stringContaining('PRIVATE_CLIPBOARD'),
          });
          if (flags.fatal) {
            const fallback = vi.spyOn(f.control, 'setValue');
            await expect(f.run()).rejects.toMatchObject(flags);
            expect(fallback).not.toHaveBeenCalled();
            expect(f.beforeSubmit).not.toHaveBeenCalled();
          }
        }
      );

      it.each([
        new Error('PRIVATE_CLIPBOARD'),
        new CoworkControlError('PRIVATE_CLIPBOARD', { quarantine: true }),
        Object.assign(new Error('PRIVATE_CLIPBOARD'), {
          fatal: false,
          quarantine: true,
        }),
      ])(
        'quarantines uncertainty without fallback or clipboard disclosure: %o',
        async (failure) => {
          const f = fixture({ noPaste: source === 'native bridge', failure });
          const fallback = vi.spyOn(f.control, 'setValue');
          await expect(f.run()).rejects.toMatchObject({
            fatal: true,
            quarantine: true,
            message: expect.not.stringContaining('PRIVATE_CLIPBOARD'),
          });
          expect(fallback).not.toHaveBeenCalled();
          expect(f.beforeSubmit).not.toHaveBeenCalled();
        }
      );
    }
  );

  it.each([{ exactWindow: false }, { wrongPid: true }, { pasteError: true }])(
    'fails closed for ownership or transactional failure: %o',
    async (options) => {
      const f = fixture(options);
      await expect(f.run()).rejects.not.toThrow('PRIVATE_CLIPBOARD');
      expect(f.beforeSubmit).not.toHaveBeenCalled();
      expect(f.calls).not.toContain('set_value');
      expect(f.calls).not.toContain('press_key');
    }
  );
});
