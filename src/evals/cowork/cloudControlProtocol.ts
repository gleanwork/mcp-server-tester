import { z } from 'zod';
import type { MCPConfig } from '../../config/mcpConfig.js';
import {
  CloudConnectorsSchema,
  type CloudConnectorConfig,
  type CloudConnectorPlan,
  type verifyCloudConnectorEvents,
} from './claudeAiConnectors.js';

export const COWORK_CLOUD_CONTROL_PROTOCOL = 'mst.cowork-cloud-control/v1';
/** Includes the JSONL newline. Oversized evidence fails rather than truncates. */
export const COWORK_CLOUD_CONTROL_MAX_FRAME_BYTES = 16 * 1024 * 1024;
/** Longest `error` a response may carry, in UTF-16 code units. */
export const COWORK_CLOUD_CONTROL_MAX_ERROR_LENGTH = 1024;
const header = {
  protocol: z.literal(COWORK_CLOUD_CONTROL_PROTOCOL),
  id: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
};
const sessionId = z
  .string()
  .regex(/^cse_[0-9A-Za-z_]+$/)
  .max(256);
/** Most events MST reads for one session (see `fetchCloudEvents`). */
export const COWORK_CLOUD_MAX_SESSION_EVENTS = 10_000;
/**
 * The events of a session the worker already holds: the first `count`, the
 * last of which has `eventId`. With it, the source sends only later events.
 */
const CoworkCloudEventCursorSchema = z
  .object({
    count: z.number().int().positive().max(COWORK_CLOUD_MAX_SESSION_EVENTS),
    eventId: z.string().min(1).max(256),
  })
  .strict();
export type CoworkCloudEventCursor = z.infer<
  typeof CoworkCloudEventCursorSchema
>;
export const CoworkCloudControlRequestSchema = z.discriminatedUnion('method', [
  z.object({ ...header, method: z.literal('prepare') }).strict(),
  z
    .object({
      ...header,
      method: z.literal('beginTask'),
      prompt: z.string().max(1_000_000),
    })
    .strict(),
  z.object({ ...header, method: z.literal('bindTask'), sessionId }).strict(),
  z.object({ ...header, method: z.literal('confirmTaskComplete') }).strict(),
  z.object({ ...header, method: z.literal('verify') }).strict(),
  z.object({ ...header, method: z.literal('restore') }).strict(),
  z.object({ ...header, method: z.literal('listSessions') }).strict(),
  z
    .object({
      ...header,
      method: z.literal('events'),
      sessionId,
      after: CoworkCloudEventCursorSchema.optional(),
    })
    .strict(),
]);
export type CoworkCloudControlRequest = z.infer<
  typeof CoworkCloudControlRequestSchema
>;
export const CoworkCloudControlResponseSchema = z.discriminatedUnion('ok', [
  z.object({ ...header, ok: z.literal(true), result: z.unknown() }).strict(),
  z
    .object({
      ...header,
      ok: z.literal(false),
      error: z.string().max(COWORK_CLOUD_CONTROL_MAX_ERROR_LENGTH),
    })
    .strict(),
]);
export type CoworkCloudControlResponse = z.infer<
  typeof CoworkCloudControlResponseSchema
>;
export type CoworkCloudControlCommand =
  CoworkCloudControlRequest extends infer Request
    ? Request extends CoworkCloudControlRequest
      ? Omit<Request, 'protocol' | 'id'>
      : never
    : never;

export interface CoworkAccountIdentity {
  accountId: string;
  organizationId: string;
}
export interface CoworkCloudPreparation {
  plan: CloudConnectorPlan;
  serverLabels: Record<string, string>;
  remoteServerNames: string[];
  requestedConnectors?: CloudConnectorConfig;
  effectiveConnectors: CloudConnectorConfig;
  servers: MCPConfig[];
  writes?: Readonly<Record<string, 'unguarded' | 'live'>>;
  model?: string;
}
export type CoworkCloudVerification = ReturnType<
  typeof verifyCloudConnectorEvents
>;

/**
 * The reply to `events` with `after`: the session's events from `offset` on.
 * `offset` is the cursor's count, or 0 when the session no longer starts with
 * the events the cursor names, and the source sends all of them again.
 */
export interface CoworkCloudEventsTail<Event> {
  offset: number;
  events: Event[];
}

function eventIdOf(event: unknown): string | undefined {
  const id =
    event && typeof event === 'object'
      ? (event as { event_id?: unknown }).event_id
      : undefined;
  return typeof id === 'string' && id.length > 0 && id.length <= 256
    ? id
    : undefined;
}

/**
 * The cursor for the events a worker holds, if the last one has an id. With
 * no cursor the worker asks for every event, as without this exchange.
 */
export function cloudEventCursor(
  events: readonly unknown[]
): CoworkCloudEventCursor | undefined {
  const eventId = eventIdOf(events.at(-1));
  return eventId &&
    events.length > 0 &&
    events.length <= COWORK_CLOUD_MAX_SESSION_EVENTS
    ? { count: events.length, eventId }
    : undefined;
}

/** Source side: the events after `after`, or all of them if its prefix changed. */
export function cloudEventsAfter<Event>(
  events: readonly Event[],
  after: CoworkCloudEventCursor
): CoworkCloudEventsTail<Event> {
  return after.count <= events.length &&
    eventIdOf(events[after.count - 1]) === after.eventId
    ? { offset: after.count, events: events.slice(after.count) }
    : { offset: 0, events: [...events] };
}

/**
 * Worker side: the whole session, from the events it held and the source's
 * reply to a cursor for them. Throws on a reply that doesn't fit the cursor,
 * so a caller reads the whole session again rather than record a gap.
 */
export function mergeCloudEvents<Event>(
  held: readonly Event[],
  after: CoworkCloudEventCursor,
  reply: CoworkCloudEventsTail<Event>
): Event[] {
  if (
    held.length !== after.count ||
    cloudEventCursor(held)?.eventId !== after.eventId
  )
    throw new Error('The held events do not match their cursor.');
  if (reply.offset !== 0 && reply.offset !== after.count)
    throw new Error(
      `The source replied from event ${reply.offset}, not 0 or ${after.count}.`
    );
  const events =
    reply.offset === 0 ? [...reply.events] : [...held, ...reply.events];
  if (events.length > COWORK_CLOUD_MAX_SESSION_EVENTS)
    throw new Error(
      `The session has more than ${COWORK_CLOUD_MAX_SESSION_EVENTS} events.`
    );
  return events;
}

/** Validate the source reply before using its policy for worker HITL. */
export const CoworkCloudPreparationSchema = z
  .object({
    plan: z
      .object({
        accountId: z.string().min(1),
        organizationId: z.string().min(1),
        patch: z.record(z.string(), z.boolean().nullable()),
        allowedTools: z.array(z.string()),
        blockedTools: z.array(z.string()),
        managedServers: z.array(z.string()),
        serverDisplayNames: z.record(z.string(), z.string()),
        failOnApproval: z.boolean(),
      })
      .strict(),
    serverLabels: z.record(z.string(), z.string()),
    remoteServerNames: z.array(z.string()),
    requestedConnectors: CloudConnectorsSchema.optional(),
    effectiveConnectors: CloudConnectorsSchema,
    servers: z.array(
      z
        .object({
          transport: z.literal('http'),
          serverUrl: z.string(),
          label: z.string().optional(),
        })
        .strict()
    ),
    writes: z.record(z.string(), z.enum(['unguarded', 'live'])).optional(),
    model: z.string().optional(),
  })
  .strict();
