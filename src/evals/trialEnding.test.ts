import { describe, expect, it } from 'vitest';

import type { EvalCaseResult, TrialResult } from '../types/reporter.js';
import {
  caseIncompleteness,
  endingOf,
  isCounted,
  thrownEnding,
  TRIAL_ENDING,
} from './trialEnding.js';

const infra = (broke: string, retryable = true) => ({
  kind: 'infrastructure',
  broke,
  retryable,
});

describe('endingOf', () => {
  it('is a trial when the attempt ended without a failure', () => {
    expect(endingOf({})).toEqual(TRIAL_ENDING);
    expect(endingOf({ error: 'Expected tool search was not called.' })).toEqual(
      TRIAL_ENDING
    );
  });

  it('keeps a recorded ending', () => {
    const ending = {
      kind: 'infrastructure' as const,
      broke: 'network' as const,
      retryable: true,
      reason: 'Reset.',
    };
    expect(endingOf({ ending, isInfrastructureError: false })).toBe(ending);
  });

  it.each([
    ['startup', infra('client-app')],
    ['timeout', infra('deadline')],
    ['process', infra('client-app')],
    ['output', infra('client-app')],
    ['not-submitted', infra('client-app')],
    ['cleanup', infra('client-app')],
    ['missing', infra('collection')],
    ['artifacts', infra('collection')],
    ['input', infra('setup', false)],
  ])('maps the client diagnostic %s', (failureKind, expected) => {
    expect(
      endingOf({ error: 'It failed.', clientDiagnostics: { failureKind } })
    ).toMatchObject(expected);
    // A client result names them `diagnostics`.
    expect(
      endingOf({ error: 'It failed.', diagnostics: { failureKind } })
    ).toMatchObject(expected);
  });

  it("tells Cowork's workspace from the client app on startup", () => {
    expect(
      endingOf({
        error: "Cowork's workspace was unavailable: the VM didn't start",
        diagnostics: { failureKind: 'startup' },
      })
    ).toMatchObject(infra('workspace'));
  });

  it.each([
    ['app_unavailable', infra('client-app')],
    ['automation_permission_denied', infra('setup', false)],
    ['no_matching_session', infra('client-app')],
    ['timeout', infra('deadline')],
    ['unsupported_client', infra('setup', false)],
  ])('maps the external client failure %s', (failureKind, expected) => {
    expect(
      endingOf({ error: 'It failed.', clientMetadata: { failureKind } })
    ).toMatchObject(expected);
  });

  it.each([
    ['read ECONNRESET', infra('network')],
    ['Rate limit reached for requests', infra('provider')],
    ['HTTP 503 Service Unavailable', infra('provider')],
    ['No matching Claude session found', infra('client-app')],
    ['prompt is too long: 210000 tokens > 200000', infra('setup', false)],
  ])('reads what broke from text: %s', (error, expected) => {
    expect(endingOf({ error })).toMatchObject({ ...expected, reason: error });
  });

  it('is a trial when a grader failed: the attempt ended fine', () => {
    expect(
      endingOf({
        error: 'Not graded: judge: 429 rate limit',
        gradingError: 'judge: 429 rate limit',
        // Recorded as infrastructure before endings.
        infrastructureError: true,
      })
    ).toEqual(TRIAL_ENDING);
  });

  it('keeps the classification a run was stored with', () => {
    // A trial the old rules called a trial stays one.
    expect(
      endingOf({ error: 'network glitch', isInfrastructureError: false })
    ).toEqual(TRIAL_ENDING);
    // One they called infrastructure stays infrastructure, even when its
    // record no longer says what broke.
    expect(
      endingOf({ error: 'Something odd.', infrastructureError: true })
    ).toMatchObject({ ...infra('client-app'), reason: 'Something odd.' });
  });
});

describe('thrownEnding', () => {
  it('names what broke from an error a client threw', () => {
    const aborted = new Error('The operation was aborted');
    aborted.name = 'AbortError';
    expect(thrownEnding(aborted)).toMatchObject(infra('deadline'));
    const refused = Object.assign(new Error('connect failed'), {
      code: 'ECONNREFUSED',
    });
    expect(thrownEnding(refused)).toMatchObject(infra('network'));
  });

  it('is a trial that failed when nothing names what broke', () => {
    expect(thrownEnding(new Error('Unexpected token'))).toEqual(TRIAL_ENDING);
    expect(thrownEnding({ odd: true })).toEqual(TRIAL_ENDING);
  });
});

describe('isCounted', () => {
  it('counts graded trials only', () => {
    expect(isCounted({})).toBe(true);
    expect(isCounted({ gradingError: 'judge: failed' })).toBe(false);
    expect(
      isCounted({
        error: 'gone',
        clientDiagnostics: { failureKind: 'missing' },
      })
    ).toBe(false);
  });
});

describe('caseIncompleteness', () => {
  const trial = (fields: Partial<TrialResult> = {}): TrialResult => ({
    pass: true,
    durationMs: 1,
    ...fields,
  });
  const caseOf = (
    trialResults?: TrialResult[],
    fields: Partial<EvalCaseResult> = {}
  ) =>
    ({
      id: 'c',
      datasetName: 'd',
      source: 'eval',
      pass: true,
      scores: {},
      durationMs: 1,
      ...(trialResults ? { trialResults } : {}),
      ...fields,
    }) as EvalCaseResult;

  it('is complete when every trial ran and was graded', () => {
    expect(caseIncompleteness(caseOf([trial(), trial()]))).toBeUndefined();
    expect(caseIncompleteness(caseOf())).toBeUndefined();
  });

  it('counts the trials a case is short, and the ones that need a fix', () => {
    expect(
      caseIncompleteness(
        caseOf([
          trial(),
          trial({ error: 'x', clientDiagnostics: { failureKind: 'missing' } }),
          trial({ error: 'y', clientDiagnostics: { failureKind: 'input' } }),
        ])
      )
    ).toEqual({ shortTrials: 2, needsFix: 1, ungradedTrials: 0 });
  });

  it('counts ungraded trials apart from infrastructure failures', () => {
    expect(
      caseIncompleteness(caseOf([trial(), trial({ gradingError: 'judge' })]))
    ).toEqual({ shortTrials: 0, needsFix: 0, ungradedTrials: 1 });
    // A case that ran once.
    expect(
      caseIncompleteness(
        caseOf(undefined, {
          error: 'gone',
          clientDiagnostics: { failureKind: 'not-submitted' },
        })
      )
    ).toEqual({ shortTrials: 1, needsFix: 0, ungradedTrials: 0 });
  });
});
