import { describe, it, expect } from 'vitest';
import { validateSimulationResult } from './runner.js';

describe('browser runner', () => {
  describe('validateSimulationResult', () => {
    it('returns null for a valid result', () => {
      expect(
        validateSimulationResult({
          success: true,
          toolCalls: [{ name: 'search', arguments: { q: 'test' } }],
          response: 'hello',
        })
      ).toBeNull();
    });

    it('returns null for an empty toolCalls array', () => {
      expect(
        validateSimulationResult({ success: false, toolCalls: [], error: 'x' })
      ).toBeNull();
    });

    it('rejects null', () => {
      expect(validateSimulationResult(null)).toMatch(/Expected object/);
    });

    it('rejects non-object', () => {
      expect(validateSimulationResult('string')).toMatch(/Expected object/);
    });

    it('rejects missing success', () => {
      expect(validateSimulationResult({ toolCalls: [] })).toMatch(
        /"success" must be a boolean/
      );
    });

    it('rejects non-boolean success', () => {
      expect(validateSimulationResult({ success: 1, toolCalls: [] })).toMatch(
        /"success" must be a boolean/
      );
    });

    it('rejects missing toolCalls', () => {
      expect(validateSimulationResult({ success: true })).toMatch(
        /"toolCalls" must be an array/
      );
    });

    it('rejects non-array toolCalls', () => {
      expect(
        validateSimulationResult({ success: true, toolCalls: 'bad' })
      ).toMatch(/"toolCalls" must be an array/);
    });

    it('rejects toolCall with non-string name', () => {
      expect(
        validateSimulationResult({
          success: true,
          toolCalls: [{ name: 123, arguments: {} }],
        })
      ).toMatch(/toolCalls\[0\]\.name must be a string/);
    });

    it('rejects toolCall with null arguments', () => {
      expect(
        validateSimulationResult({
          success: true,
          toolCalls: [{ name: 'x', arguments: null }],
        })
      ).toMatch(/toolCalls\[0\]\.arguments must be an object/);
    });
  });
});
