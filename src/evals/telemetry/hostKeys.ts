/**
 * The attributes by which a host's telemetry event names what it is about.
 * The receiver uses them to give model calls their request IDs; the trace
 * builder, to join events to the spans they name.
 */
import type { HostTelemetryEvent } from '../evalFrameworkTypes.js';

/** The attributes that name the request a host's event is about. */
export const HOST_REQUEST_ID_KEYS = ['request_id', 'request.id'];
/** The attributes that name the model response a host's event is about. */
export const HOST_RESPONSE_ID_KEYS = ['gen_ai.response.id', 'response_id'];
/** Either: the attributes that name the model request a host's event is about. */
export const HOST_REQUEST_KEYS = [
  ...HOST_REQUEST_ID_KEYS,
  ...HOST_RESPONSE_ID_KEYS,
];
/** The attributes that name the message record a host's event is about. */
export const HOST_MESSAGE_KEYS = ['message_uuid', 'message.uuid'];
/** The attributes that name the tool call a host's event is about. */
export const HOST_TOOL_CALL_KEYS = [
  'tool_use_id',
  'tool_call_id',
  'gen_ai.tool.call.id',
  'call_id',
];

/** The first of `keys` the event names, as a non-empty string. */
export function hostKey(
  event: HostTelemetryEvent,
  keys: readonly string[]
): string | undefined {
  for (const key of keys) {
    const value = event.attributes[key];
    if (typeof value === 'string' && value) return value;
  }
  return undefined;
}
