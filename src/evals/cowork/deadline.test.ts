import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CoworkOperationScope,
  isFatalControlError,
  requiresQuarantine,
} from './deadline.js';
import { CoworkControlError, isCoworkControlError } from './workflow.js';

afterEach(() => vi.useRealTimers());

describe('Cowork control safety flags', () => {
  it('defaults to fatal refusal without quarantine and makes quarantine fatal', () => {
    expect(new CoworkControlError('refused')).toMatchObject({
      fatal: true,
      quarantine: false,
    });
    expect(
      new CoworkControlError('safe fallback', { fatal: false })
    ).toMatchObject({
      fatal: false,
      quarantine: false,
    });
    expect(
      new CoworkControlError('uncertain', { fatal: false, quarantine: true })
    ).toMatchObject({ fatal: true, quarantine: true });
  });

  it.each([
    {
      failure: { fatal: true, quarantine: false },
      fatal: true,
      quarantine: false,
    },
    {
      failure: { fatal: false, quarantine: true },
      fatal: true,
      quarantine: true,
    },
    { failure: { fatal: true }, fatal: true, quarantine: false },
    { failure: { quarantine: true }, fatal: true, quarantine: true },
    {
      failure: { fatal: 'true', quarantine: 'true' },
      fatal: false,
      quarantine: false,
    },
    { failure: null, fatal: false, quarantine: false },
    { failure: 'fatal', fatal: false, quarantine: false },
  ])(
    'reads strict structural flags without class identity: $failure',
    ({ failure, fatal, quarantine }) => {
      expect(isFatalControlError(failure)).toBe(fatal);
      expect(requiresQuarantine(failure)).toBe(quarantine);
    }
  );

  it('does not throw when an error exposes unsafe property access', () => {
    const failure = new Proxy(
      {},
      {
        get() {
          throw new Error('unreadable property');
        },
      }
    );
    expect(isFatalControlError(failure)).toBe(false);
    expect(requiresQuarantine(failure)).toBe(false);
    expect(isCoworkControlError(failure)).toBe(false);
  });
});

describe('Cowork shared execution deadline', () => {
  it('rejects a synchronous result that outlives the deadline before the timer runs', async () => {
    vi.useFakeTimers();
    const now = Date.now();
    const scope = new CoworkOperationScope(now + 100);
    await expect(
      scope.run(() => {
        vi.setSystemTime(now + 101);
        return 'late success';
      })
    ).rejects.toThrow('deadline');
  });
  it('keeps timed-out work pending until drain sees its actual settlement', async () => {
    vi.useFakeTimers();
    const scope = new CoworkOperationScope(Date.now() + 100);
    let settle: (() => void) | undefined;
    const operation = scope.run(
      () =>
        new Promise<void>((resolve) => {
          settle = resolve;
        })
    );
    const timeout = expect(operation).rejects.toThrow('deadline');
    await vi.advanceTimersByTimeAsync(101);
    await timeout;
    expect(scope.pendingCount).toBe(1);
    settle!();
    await scope.drain(Date.now() + 100);
    expect(scope.pendingCount).toBe(0);
    expect(scope.quarantineRequired).toBe(false);
  });

  it('retains quarantine from a late rejection after drain and later ordinary settlements', async () => {
    vi.useFakeTimers();
    const scope = new CoworkOperationScope(Date.now() + 40);
    const failure = Object.assign(new Error('external state uncertain'), {
      quarantine: true,
    });
    const operation = scope.run(
      () =>
        new Promise<void>((_, reject) => {
          setTimeout(() => reject(failure), 90);
        })
    );
    const timeout = expect(operation).rejects.toThrow('deadline');
    await vi.advanceTimersByTimeAsync(41);
    await timeout;
    expect(scope.pendingCount).toBe(1);
    expect(scope.quarantineRequired).toBe(false);
    const drained = scope.drain(Date.now() + 200);
    await vi.advanceTimersByTimeAsync(50);
    await drained;
    expect(scope.pendingCount).toBe(0);
    expect(scope.quarantineRequired).toBe(true);
    await expect(
      scope.run(
        () => Promise.reject(new Error('ordinary failure')),
        Date.now() + 100
      )
    ).rejects.toThrow('ordinary failure');
    await scope.run(() => 'cleanup finished', Date.now() + 100);
    await scope.drain(Date.now() + 100);
    expect(scope.quarantineRequired).toBe(true);
  });

  it.each([
    new Error('ordinary'),
    Object.assign(new Error('ordinary'), { quarantine: false }),
    Object.assign(new Error('ordinary'), { quarantine: 'true' }),
  ])(
    'does not infer quarantine from unmarked failures: %o',
    async (failure) => {
      const scope = new CoworkOperationScope(Date.now() + 1000);
      await expect(scope.run(() => Promise.reject(failure))).rejects.toBe(
        failure
      );
      await scope.drain(Date.now() + 1000);
      expect(scope.quarantineRequired).toBe(false);
    }
  );
});
