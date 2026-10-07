import type { ExternalClientFailureKind } from './types.js';

/**
 * A native-trace failure whose kind is decided where it is detected, so a
 * result's failure kind never depends on the wording of an error message.
 */
export class NativeTraceError extends Error {
  constructor(
    readonly failureKind: ExternalClientFailureKind,
    message: string
  ) {
    super(message);
    this.name = 'NativeTraceError';
  }
}

/** The kind a native-trace failure carries, or `fallback` for any other error. */
export function nativeTraceFailureKind(
  error: unknown,
  fallback: ExternalClientFailureKind
): ExternalClientFailureKind {
  return error instanceof NativeTraceError ? error.failureKind : fallback;
}
