import { describe, it, expect } from 'vitest';
import { interpolateArgs, validateSimulationResult } from './runner.js';

describe('interpolateArgs', () => {
  it('replaces {{scenario}} in args', () => {
    const result = interpolateArgs(
      ['-p', '{{scenario}}', '--verbose'],
      'Find recent docs'
    );
    expect(result).toEqual(['-p', 'Find recent docs', '--verbose']);
  });

  it('handles multiple occurrences of {{scenario}}', () => {
    const result = interpolateArgs(
      ['--prompt', '{{scenario}}', '--log', 'Running: {{scenario}}'],
      'hello'
    );
    expect(result).toEqual(['--prompt', 'hello', '--log', 'Running: hello']);
  });

  it('returns args unchanged when no placeholder is present', () => {
    const result = interpolateArgs(['--flag', 'value'], 'scenario text');
    expect(result).toEqual(['--flag', 'value']);
  });

  it('handles empty args array', () => {
    const result = interpolateArgs([], 'scenario');
    expect(result).toEqual([]);
  });
});

describe('validateSimulationResult', () => {
  it('returns null for a valid result', () => {
    const result = validateSimulationResult({
      success: true,
      toolCalls: [{ name: 'search', arguments: { q: 'test' } }],
    });
    expect(result).toBeNull();
  });

  it('returns null for valid result with empty toolCalls', () => {
    const result = validateSimulationResult({
      success: false,
      toolCalls: [],
    });
    expect(result).toBeNull();
  });

  it('returns error when success is missing', () => {
    const result = validateSimulationResult({
      toolCalls: [],
    });
    expect(result).toContain('"success" must be a boolean');
  });

  it('returns error when success is non-boolean', () => {
    const result = validateSimulationResult({
      success: 'yes',
      toolCalls: [],
    });
    expect(result).toContain('"success" must be a boolean');
  });

  it('returns error when toolCalls is missing', () => {
    const result = validateSimulationResult({
      success: true,
    });
    expect(result).toContain('"toolCalls" must be an array');
  });

  it('returns error when toolCalls is not an array', () => {
    const result = validateSimulationResult({
      success: true,
      toolCalls: 'not-an-array',
    });
    expect(result).toContain('"toolCalls" must be an array');
  });

  it('returns error for invalid toolCall entry (missing name)', () => {
    const result = validateSimulationResult({
      success: true,
      toolCalls: [{ arguments: {} }],
    });
    expect(result).toContain('toolCalls[0].name must be a string');
  });

  it('returns error for invalid toolCall entry (bad arguments)', () => {
    const result = validateSimulationResult({
      success: true,
      toolCalls: [{ name: 'tool', arguments: 'not-object' }],
    });
    expect(result).toContain('toolCalls[0].arguments must be an object');
  });

  it('returns error for null arguments', () => {
    const result = validateSimulationResult({
      success: true,
      toolCalls: [{ name: 'tool', arguments: null }],
    });
    expect(result).toContain('toolCalls[0].arguments must be an object');
  });

  it('returns error for null input', () => {
    const result = validateSimulationResult(null);
    expect(result).toContain('Expected object');
  });

  it('returns error for non-object input', () => {
    const result = validateSimulationResult('string');
    expect(result).toContain('Expected object');
  });
});
