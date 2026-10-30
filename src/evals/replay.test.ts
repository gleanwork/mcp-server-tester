import { describe, expect, it } from 'vitest';

import type { TrialRecord } from './runFormat.js';
import { isMissingTrial } from './replay.js';

const trial = (failureKind?: string) =>
  ({
    ...(failureKind ? { clientDiagnostics: { failureKind } } : {}),
  }) as unknown as TrialRecord;

describe('isMissingTrial (what mst run --resume collects)', () => {
  it('collects a trial its shard never returned', () => {
    expect(isMissingTrial(undefined)).toBe(true);
    expect(isMissingTrial(trial('missing'))).toBe(true);
  });

  it('collects a trial the client never submitted, an infrastructure failure', () => {
    // E.g. every case after a failed reset in a Cowork batch.
    expect(isMissingTrial(trial('not-submitted'))).toBe(true);
  });

  it('keeps a trial the client ran, passed or failed', () => {
    expect(isMissingTrial(trial())).toBe(false);
    expect(isMissingTrial(trial('timeout'))).toBe(false);
  });
});
