import { describe, expect, it } from 'vitest';
import {
  NativeTranscriptError,
  nativeTranscriptFailureKind,
} from './nativeTranscriptError.js';

describe('nativeTranscriptFailureKind', () => {
  it('returns the kind a native-transcript failure carries', () => {
    const error = new NativeTranscriptError('timeout', 'Timed out.');
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe('NativeTranscriptError');
    expect(nativeTranscriptFailureKind(error, 'unknown')).toBe('timeout');
  });

  it('never reads the kind from an error message', () => {
    for (const message of [
      'Ambiguous sessions',
      'Timed out waiting',
      'No matching session',
      'model mismatch',
    ]) {
      expect(nativeTranscriptFailureKind(new Error(message), 'unknown')).toBe(
        'unknown'
      );
    }
    expect(nativeTranscriptFailureKind('not an error', 'parse_failure')).toBe(
      'parse_failure'
    );
  });
});
