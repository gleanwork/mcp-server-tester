import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { runBrowserHost, validateSimulationResult } from './runner.js';

const browser = vi.hoisted(() => ({
  close: vi.fn(),
  newContext: vi.fn(),
}));
vi.mock('playwright', () => ({
  chromium: { launch: vi.fn(async () => browser) },
}));

const script = fileURLToPath(
  new URL('./__fixtures__/script.ts', import.meta.url)
);

describe('browser runner', () => {
  describe('timeout cleanup', () => {
    beforeEach(() => {
      vi.useFakeTimers();
      browser.close.mockReset().mockResolvedValue(undefined);
      browser.newContext.mockReset().mockResolvedValue({
        newPage: vi.fn(async () => ({})),
      });
    });

    afterEach(() => {
      vi.useRealTimers();
      vi.restoreAllMocks();
    });

    it.each(['success', 'reject', 'invalid'])(
      'clears the script timer after %s and before closing the browser',
      async (scenario) => {
        browser.close.mockImplementation(async () => {
          expect(vi.getTimerCount()).toBe(0);
        });
        const result = await runBrowserHost(
          { script, timeout: 120_000 },
          scenario
        );
        expect(result.success).toBe(scenario === 'success');
        if (scenario === 'reject')
          expect(result.error).toContain('script rejection');
        if (scenario === 'invalid')
          expect(result.error).toContain('invalid result');
        expect(browser.close).toHaveBeenCalledOnce();
        expect(vi.getTimerCount()).toBe(0);
      }
    );

    it('closes the browser and clears the timer when the script times out', async () => {
      const setTimer = vi.spyOn(globalThis, 'setTimeout');
      const pending = runBrowserHost({ script, timeout: 100 }, 'timeout');
      await vi.waitFor(() => expect(setTimer).toHaveBeenCalled(), {
        interval: 1,
      });
      await vi.advanceTimersByTimeAsync(100);
      expect(await pending).toMatchObject({
        success: false,
        error: expect.stringContaining('timed out after 100ms'),
      });
      expect(browser.close).toHaveBeenCalledOnce();
      expect(vi.getTimerCount()).toBe(0);
    });

    it('clears the timer even when browser cleanup rejects', async () => {
      browser.close.mockRejectedValue(new Error('close failed'));
      await expect(runBrowserHost({ script }, 'success')).rejects.toThrow(
        'close failed'
      );
      expect(vi.getTimerCount()).toBe(0);
    });
  });

  describe('validateSimulationResult', () => {
    it('returns null for a valid result', () => {
      expect(
        validateSimulationResult({
          success: true,
          toolCalls: [{ name: 'search', arguments: { q: 'test' } }],
          response: 'hello',
        })
      ).toBeNull();
    });

    it('returns null for an empty toolCalls array', () => {
      expect(
        validateSimulationResult({ success: false, toolCalls: [], error: 'x' })
      ).toBeNull();
    });

    it('rejects null', () => {
      expect(validateSimulationResult(null)).toMatch(/Expected object/);
    });

    it('rejects non-object', () => {
      expect(validateSimulationResult('string')).toMatch(/Expected object/);
    });

    it('rejects missing success', () => {
      expect(validateSimulationResult({ toolCalls: [] })).toMatch(
        /"success" must be a boolean/
      );
    });

    it('rejects non-boolean success', () => {
      expect(validateSimulationResult({ success: 1, toolCalls: [] })).toMatch(
        /"success" must be a boolean/
      );
    });

    it('rejects missing toolCalls', () => {
      expect(validateSimulationResult({ success: true })).toMatch(
        /"toolCalls" must be an array/
      );
    });

    it('rejects non-array toolCalls', () => {
      expect(
        validateSimulationResult({ success: true, toolCalls: 'bad' })
      ).toMatch(/"toolCalls" must be an array/);
    });

    it('rejects toolCall with non-string name', () => {
      expect(
        validateSimulationResult({
          success: true,
          toolCalls: [{ name: 123, arguments: {} }],
        })
      ).toMatch(/toolCalls\[0\]\.name must be a string/);
    });

    it('rejects toolCall with null arguments', () => {
      expect(
        validateSimulationResult({
          success: true,
          toolCalls: [{ name: 'x', arguments: null }],
        })
      ).toMatch(/toolCalls\[0\]\.arguments must be an object/);
    });
  });
});
