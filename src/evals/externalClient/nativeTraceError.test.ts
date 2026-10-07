import { describe, expect, it } from 'vitest';
import {
  NativeTraceError,
  nativeTraceFailureKind,
} from './nativeTraceError.js';

describe('nativeTraceFailureKind', () => {
  it('returns the kind a native-trace failure carries', () => {
    const error = new NativeTraceError('timeout', 'Timed out.');
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe('NativeTraceError');
    expect(nativeTraceFailureKind(error, 'unknown')).toBe('timeout');
  });

  it('never reads the kind from an error message', () => {
    for (const message of [
      'Ambiguous sessions',
      'Timed out waiting',
      'No matching session',
      'model mismatch',
    ]) {
      expect(nativeTraceFailureKind(new Error(message), 'unknown')).toBe(
        'unknown'
      );
    }
    expect(nativeTraceFailureKind('not an error', 'parse_failure')).toBe(
      'parse_failure'
    );
  });
});
