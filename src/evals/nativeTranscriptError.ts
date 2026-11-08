import type { ExternalClientFailureKind } from './clientTelemetryTypes.js';

/**
 * A native-transcript failure whose kind is decided where it is detected, so a
 * result's failure kind never depends on the wording of an error message.
 */
export class NativeTranscriptError extends Error {
  constructor(
    readonly failureKind: ExternalClientFailureKind,
    message: string
  ) {
    super(message);
    this.name = 'NativeTranscriptError';
  }
}

/** The kind a native-transcript failure carries, or `fallback` for any other error. */
export function nativeTranscriptFailureKind(
  error: unknown,
  fallback: ExternalClientFailureKind
): ExternalClientFailureKind {
  return error instanceof NativeTranscriptError ? error.failureKind : fallback;
}
