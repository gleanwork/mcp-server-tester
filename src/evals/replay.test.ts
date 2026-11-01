import { describe, expect, it } from 'vitest';

import type { TrialRecord } from './runFormat.js';
import { resumeCollects } from './trialEnding.js';

const trial = (fields: Partial<TrialRecord> = {}) =>
  ({ infrastructureError: false, ...fields }) as unknown as TrialRecord;
const failed = (failureKind: string, error = 'It failed.') =>
  trial({
    infrastructureError: true,
    error,
    clientDiagnostics: { failureKind },
  });

describe('resumeCollects (what mst run --resume collects)', () => {
  it('collects a trial its shard never returned', () => {
    expect(resumeCollects(undefined)).toBe(true);
    expect(resumeCollects(failed('missing'))).toBe(true);
  });

  it('collects a trial the client never submitted, an infrastructure failure', () => {
    // E.g. every case after a failed reset in a Cowork batch.
    expect(resumeCollects(failed('not-submitted'))).toBe(true);
  });

  it('collects every infrastructure failure a retry can help', () => {
    expect(resumeCollects(failed('process'))).toBe(true);
    expect(resumeCollects(failed('timeout'))).toBe(true);
    expect(
      resumeCollects(
        trial({ infrastructureError: true, error: 'HTTP 503 from provider' })
      )
    ).toBe(true);
  });

  it("keeps an infrastructure failure a retry can't help", () => {
    // The desktop kept only the prompt's beginning: it would again.
    expect(resumeCollects(failed('input'))).toBe(false);
  });

  it('keeps a trial the client ran, passed or failed', () => {
    expect(resumeCollects(trial())).toBe(false);
    expect(resumeCollects(trial({ error: 'The client failed.' }))).toBe(false);
  });

  it('keeps an ungraded trial: mst grade --resume grades it', () => {
    expect(
      resumeCollects(
        trial({
          infrastructureError: true,
          gradingError: 'judge: 503',
          error: 'Not graded: judge: 503',
        })
      )
    ).toBe(false);
  });

  it('follows a recorded ending over the old fields', () => {
    expect(
      resumeCollects(
        trial({
          ending: {
            kind: 'infrastructure',
            broke: 'setup',
            retryable: false,
            reason: 'Missing permission.',
          },
          infrastructureError: true,
          clientDiagnostics: { failureKind: 'missing' },
        })
      )
    ).toBe(false);
  });
});
