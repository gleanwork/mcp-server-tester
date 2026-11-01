import { describe, expect, it } from 'vitest';

import type { EvalCaseResult, TrialResult } from '../types/reporter.js';
import {
  caseIncompleteness,
  contextOverflowEnding,
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

  it.each([
    ['app_unavailable', infra('client-app')],
    ['automation_permission_denied', infra('setup', false)],
    ['no_matching_session', infra('client-app')],
    ['client_run_failed', infra('client-app')],
    ['cleanup_failed', infra('client-app')],
    ['timeout', infra('deadline')],
    ['unsupported_client', infra('setup', false)],
  ])('maps the external client failure %s', (failureKind, expected) => {
    expect(
      endingOf({ error: 'It failed.', clientMetadata: { failureKind } })
    ).toMatchObject(expected);
  });

  // Words the old shared list matched. Only a producer reads its own
  // provider's or app's text (ADR 0010); an error alone is a trial.
  it.each([
    'read ECONNRESET',
    'Rate limit reached for requests',
    'HTTP 503 Service Unavailable',
    'No matching Claude session found',
    "Cowork's workspace was unavailable: the VM didn't start",
    'prompt is too long: 210000 tokens > 200000',
    'automation permission was denied',
  ])('never reads what broke from an error: %s', (error) => {
    expect(endingOf({ error })).toEqual(TRIAL_ENDING);
  });

  it("keeps a startup failure the client app's, whatever its words", () => {
    expect(
      endingOf({
        error: "Cowork's workspace was unavailable: the VM didn't start",
        diagnostics: { failureKind: 'startup' },
      })
    ).toMatchObject(infra('client-app'));
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

  // Stored trial records from before endings, as `mst.run/v1` wrote them:
  // every record has `infrastructureError`, so a record's words never
  // decided it. They keep that, and a retry can help unless a failure kind
  // says otherwise.
  it.each([
    [
      'a rate limit',
      { error: '429 Too Many Requests', infrastructureError: true },
      infra('client-app'),
    ],
    [
      'a context overflow',
      { error: 'prompt is too long', infrastructureError: true },
      infra('client-app'),
    ],
    [
      'a Cowork workspace',
      {
        error: "Cowork's workspace was unavailable: down",
        infrastructureError: true,
        clientDiagnostics: { failureKind: 'startup' },
      },
      infra('client-app'),
    ],
    [
      'a truncated prompt',
      {
        error: 'Claude kept 10 of the prompt',
        infrastructureError: true,
        clientDiagnostics: { failureKind: 'input' },
      },
      infra('setup', false),
    ],
    [
      'a failed trial that mentions a 503',
      { error: 'Expected 200, got 503.', infrastructureError: false },
      TRIAL_ENDING,
    ],
  ])('maps a stored record from before endings: %s', (_, record, expected) => {
    expect(endingOf(record)).toMatchObject(expected);
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

  it('reads a network code from the cause, as fetch reports one', () => {
    const failed = new TypeError('fetch failed', {
      cause: Object.assign(new Error('getaddrinfo ENOTFOUND api.example'), {
        code: 'ENOTFOUND',
      }),
    });
    expect(thrownEnding(failed)).toMatchObject({
      ...infra('network'),
      reason: 'fetch failed',
    });
  });

  it('is a trial that failed when nothing names what broke', () => {
    expect(thrownEnding(new Error('Unexpected token'))).toEqual(TRIAL_ENDING);
    expect(thrownEnding({ odd: true })).toEqual(TRIAL_ENDING);
    // Words alone never decide it: a client that knows returns its ending.
    expect(thrownEnding(new Error('read ECONNRESET'))).toEqual(TRIAL_ENDING);
    expect(thrownEnding('429 rate limit')).toEqual(TRIAL_ENDING);
  });
});

describe('contextOverflowEnding', () => {
  it('is a trial once the client acted, and setup before', () => {
    expect(contextOverflowEnding('prompt is too long', true)).toEqual(
      TRIAL_ENDING
    );
    expect(contextOverflowEnding('prompt is too long', false)).toMatchObject(
      infra('setup', false)
    );
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
