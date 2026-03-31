/**
 * Judge Registry Unit Tests
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  registerJudge,
  getRegisteredJudge,
  clearJudgeRegistry,
} from './judgeRegistry.js';

beforeEach(() => {
  clearJudgeRegistry();
});

describe('registerJudge', () => {
  it('registers a judge executor by name', () => {
    const executor = async () => ({ score: 1.0, reasoning: 'ok' });
    registerJudge('my-judge', executor);

    expect(getRegisteredJudge('my-judge')).toBe(executor);
  });

  it('is idempotent when re-registering the same function', () => {
    const executor = async () => ({ score: 1.0 });
    registerJudge('dup', executor);
    registerJudge('dup', executor); // should not throw

    expect(getRegisteredJudge('dup')).toBe(executor);
  });

  it('throws when registering a different executor under the same name', () => {
    const executorA = async () => ({ score: 1.0 });
    const executorB = async () => ({ score: 0.0 });
    registerJudge('conflict', executorA);

    expect(() => registerJudge('conflict', executorB)).toThrow(
      'different executor'
    );
  });
});

describe('getRegisteredJudge', () => {
  it('throws with helpful message when judge is not registered', () => {
    expect(() => getRegisteredJudge('nonexistent')).toThrow(
      'Judge "nonexistent" is not registered'
    );
    expect(() => getRegisteredJudge('nonexistent')).toThrow(
      'No judges are registered'
    );
  });

  it('lists available judges in error message', () => {
    registerJudge('alpha', async () => ({ score: 1.0 }));
    registerJudge('beta', async () => ({ score: 1.0 }));

    expect(() => getRegisteredJudge('gamma')).toThrow('alpha, beta');
  });
});

describe('clearJudgeRegistry', () => {
  it('removes all registered judges', () => {
    registerJudge('temp', async () => ({ score: 1.0 }));
    clearJudgeRegistry();

    expect(() => getRegisteredJudge('temp')).toThrow('not registered');
  });

  it('allows re-registration after clearing', () => {
    const executor = async () => ({ score: 1.0 });
    registerJudge('reuse', executor);
    clearJudgeRegistry();
    registerJudge('reuse', executor);

    expect(getRegisteredJudge('reuse')).toBe(executor);
  });
});
