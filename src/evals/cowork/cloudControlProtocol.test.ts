import { describe, expect, it } from 'vitest';
import {
  COWORK_CLOUD_CONTROL_PROTOCOL,
  COWORK_CLOUD_MAX_SESSION_EVENTS,
  CoworkCloudControlRequestSchema,
  cloudEventCursor,
  cloudEventsAfter,
  mergeCloudEvents,
} from './cloudControlProtocol.js';

const event = (id: string) => ({ event_id: id, payload: { uuid: id } });

describe('incremental cloud events', () => {
  it('names the held events by count and last id, or not at all', () => {
    expect(cloudEventCursor([])).toBeUndefined();
    expect(cloudEventCursor([event('a'), { payload: {} }])).toBeUndefined();
    expect(cloudEventCursor([event('a'), event('b')])).toEqual({
      count: 2,
      eventId: 'b',
    });
  });

  it('sends only the events after an unchanged prefix', () => {
    const events = [event('a'), event('b'), event('c')];
    expect(cloudEventsAfter(events, { count: 2, eventId: 'b' })).toEqual({
      offset: 2,
      events: [event('c')],
    });
    expect(cloudEventsAfter(events, { count: 3, eventId: 'c' })).toEqual({
      offset: 3,
      events: [],
    });
  });

  it('sends every event when the prefix the cursor names is gone', () => {
    const events = [event('a'), event('b')];
    for (const after of [
      { count: 2, eventId: 'x' },
      { count: 1, eventId: 'b' },
      { count: 3, eventId: 'b' },
    ])
      expect(cloudEventsAfter(events, after)).toEqual({ offset: 0, events });
  });

  it('merges a tail, or replaces the session with a full reply', () => {
    const held = [event('a'), event('b')];
    const after = { count: 2, eventId: 'b' };
    expect(
      mergeCloudEvents(held, after, { offset: 2, events: [event('c')] })
    ).toEqual([event('a'), event('b'), event('c')]);
    expect(
      mergeCloudEvents(held, after, { offset: 0, events: [event('x')] })
    ).toEqual([event('x')]);
  });

  it('rejects a reply that does not fit the cursor', () => {
    const held = [event('a'), event('b')];
    expect(() =>
      mergeCloudEvents(
        held,
        { count: 2, eventId: 'b' },
        { offset: 1, events: [] }
      )
    ).toThrow('replied from event 1, not 0 or 2');
    expect(() =>
      mergeCloudEvents(
        held,
        { count: 1, eventId: 'a' },
        { offset: 1, events: [] }
      )
    ).toThrow('do not match their cursor');
    expect(() =>
      mergeCloudEvents(
        held,
        { count: 2, eventId: 'b' },
        {
          offset: 2,
          events: Array.from(
            { length: COWORK_CLOUD_MAX_SESSION_EVENTS - 1 },
            (_, i) => event(`n${i}`)
          ),
        }
      )
    ).toThrow(`more than ${COWORK_CLOUD_MAX_SESSION_EVENTS} events`);
  });

  it('accepts an events cursor only in its exact shape', () => {
    const request = {
      protocol: COWORK_CLOUD_CONTROL_PROTOCOL,
      id: 1,
      method: 'events',
      sessionId: 'cse_a',
    };
    expect(CoworkCloudControlRequestSchema.parse(request)).toEqual(request);
    expect(
      CoworkCloudControlRequestSchema.parse({
        ...request,
        after: { count: 3, eventId: 'e' },
      })
    ).toMatchObject({ after: { count: 3, eventId: 'e' } });
    for (const after of [
      { count: 0, eventId: 'e' },
      { count: 1.5, eventId: 'e' },
      { count: COWORK_CLOUD_MAX_SESSION_EVENTS + 1, eventId: 'e' },
      { count: 1, eventId: '' },
      { count: 1, eventId: 'e', extra: true },
    ])
      expect(
        CoworkCloudControlRequestSchema.safeParse({ ...request, after }).success
      ).toBe(false);
  });
});
