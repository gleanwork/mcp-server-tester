/**
 * Validator Unit Tests
 *
 * Tests for all validator functions in the assertions module.
 */

import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import {
  validateResponse,
  validateSchema,
  validateText,
  validatePattern,
  validateError,
  validateSize,
  getResponseSizeBytes,
} from './index.js';

describe('validateResponse', () => {
  it('should pass when responses match exactly', () => {
    const result = validateResponse(
      { status: 'ok', count: 42 },
      { status: 'ok', count: 42 }
    );
    expect(result.pass).toBe(true);
    expect(result.message).toContain('matches');
  });

  it('should fail when responses differ', () => {
    const result = validateResponse({ status: 'ok' }, { status: 'error' });
    expect(result.pass).toBe(false);
    expect(result.message).toContain('does not match');
  });

  it('should handle null and undefined', () => {
    expect(validateResponse(null, null).pass).toBe(true);
    expect(validateResponse(undefined, undefined).pass).toBe(true);
    // Note: JSON.stringify treats both null and undefined as "null"
    // so they are considered equal in this comparison
    expect(validateResponse(null, undefined).pass).toBe(true);
  });

  it('should handle primitive values', () => {
    expect(validateResponse('hello', 'hello').pass).toBe(true);
    expect(validateResponse(42, 42).pass).toBe(true);
    expect(validateResponse(true, true).pass).toBe(true);
  });

  it('should handle nested objects', () => {
    const actual = { user: { name: 'John', age: 30 } };
    const expected = { user: { name: 'John', age: 30 } };
    expect(validateResponse(actual, expected).pass).toBe(true);
  });

  it('should handle arrays', () => {
    expect(validateResponse([1, 2, 3], [1, 2, 3]).pass).toBe(true);
    expect(validateResponse([1, 2], [1, 2, 3]).pass).toBe(false);
  });
});

describe('validateSchema', () => {
  const UserSchema = z.object({
    name: z.string(),
    age: z.number(),
    email: z.string().email().optional(),
  });

  it('should pass when response matches schema', () => {
    const result = validateSchema({ name: 'John', age: 30 }, UserSchema);
    expect(result.pass).toBe(true);
    expect(result.message).toContain('matches schema');
  });

  it('should fail when response is missing required fields', () => {
    const result = validateSchema({ name: 'John' }, UserSchema);
    expect(result.pass).toBe(false);
    expect(result.message).toContain('does not match');
  });

  it('should fail when response has wrong types', () => {
    const result = validateSchema({ name: 'John', age: '30' }, UserSchema);
    expect(result.pass).toBe(false);
  });

  it('should handle optional fields', () => {
    const withEmail = validateSchema(
      { name: 'John', age: 30, email: 'john@example.com' },
      UserSchema
    );
    expect(withEmail.pass).toBe(true);

    const withoutEmail = validateSchema({ name: 'John', age: 30 }, UserSchema);
    expect(withoutEmail.pass).toBe(true);
  });

  it('should handle MCP response format with content array', () => {
    // Schema for the content
    const ContentSchema = z.array(
      z.object({
        type: z.string(),
        text: z.string(),
      })
    );

    const response = {
      content: [{ type: 'text', text: 'Hello world' }],
    };

    // Validate the content field
    const result = validateSchema(response.content, ContentSchema);
    expect(result.pass).toBe(true);
  });
});

describe('validateText', () => {
  describe('basic functionality', () => {
    it('should pass when single substring is found', () => {
      const result = validateText('hello world', 'hello');
      expect(result.pass).toBe(true);
    });

    it('should fail when substring is not found', () => {
      const result = validateText('hello world', 'goodbye');
      expect(result.pass).toBe(false);
      expect(result.message).toContain('goodbye');
    });

    it('should pass when all substrings are found', () => {
      const result = validateText('hello world test', [
        'hello',
        'world',
        'test',
      ]);
      expect(result.pass).toBe(true);
      expect(result.message).toContain('3 expected substrings');
    });

    it('should fail when some substrings are missing', () => {
      const result = validateText('hello world', ['hello', 'world', 'missing']);
      expect(result.pass).toBe(false);
      expect(result.message).toContain('missing');
    });
  });

  describe('case sensitivity', () => {
    it('should be case-sensitive by default', () => {
      const result = validateText('hello world', 'HELLO');
      expect(result.pass).toBe(false);
    });

    it('should support case-insensitive matching', () => {
      const result = validateText('hello world', 'HELLO', {
        caseSensitive: false,
      });
      expect(result.pass).toBe(true);
    });
  });

  describe('MCP response formats', () => {
    it('should extract text from MCP CallToolResult format', () => {
      const response = {
        content: [{ type: 'text', text: 'The weather is sunny' }],
      };
      const result = validateText(response, 'weather');
      expect(result.pass).toBe(true);
    });

    it('should handle multiple content blocks', () => {
      const response = {
        content: [
          { type: 'text', text: 'first block' },
          { type: 'text', text: 'second block' },
        ],
      };
      const result = validateText(response, ['first', 'second']);
      expect(result.pass).toBe(true);
    });

    it('should extract from structuredContent field', () => {
      const response = {
        structuredContent: { result: 42 },
      };
      const result = validateText(response, 'result');
      expect(result.pass).toBe(true);
    });

    it('should prefer host simulation final response over metadata JSON', () => {
      const response = {
        response: 'final answer text',
        externalHost: {
          traceLimitations: ['metadata-only text'],
        },
      };

      expect(validateText(response, 'final answer').pass).toBe(true);
      expect(validateText(response, 'metadata-only').pass).toBe(false);
    });
  });
});

describe('validatePattern', () => {
  describe('basic functionality', () => {
    it('should pass when string pattern matches', () => {
      const result = validatePattern(
        'temperature: 25 degrees',
        'temperature: \\d+'
      );
      expect(result.pass).toBe(true);
    });

    it('should pass when RegExp pattern matches', () => {
      const result = validatePattern(
        'temperature: 25 degrees',
        /temperature: \d+/
      );
      expect(result.pass).toBe(true);
    });

    it('should fail when pattern does not match', () => {
      const result = validatePattern('no numbers here', /\d+/);
      expect(result.pass).toBe(false);
    });

    it('should pass when all patterns match', () => {
      const result = validatePattern('temp: 25, humidity: 60%', [
        /temp: \d+/,
        /humidity: \d+%/,
      ]);
      expect(result.pass).toBe(true);
      expect(result.message).toContain('2 patterns');
    });

    it('should fail when some patterns do not match', () => {
      const result = validatePattern('temp: 25', [
        /temp: \d+/,
        /humidity: \d+%/,
      ]);
      expect(result.pass).toBe(false);
      expect(result.message).toContain('humidity');
    });
  });

  describe('case sensitivity', () => {
    it('should be case-sensitive by default', () => {
      const result = validatePattern('Hello World', /hello/);
      expect(result.pass).toBe(false);
    });

    it('should support case-insensitive matching', () => {
      const result = validatePattern('Hello World', /hello/, {
        caseSensitive: false,
      });
      expect(result.pass).toBe(true);
    });

    it('should respect existing case-insensitive flag on RegExp', () => {
      const result = validatePattern('Hello World', /hello/i);
      expect(result.pass).toBe(true);
    });
  });

  describe('MCP response formats', () => {
    it('should extract text from MCP response', () => {
      const response = {
        content: [{ type: 'text', text: 'temperature: 25 degrees' }],
      };
      const result = validatePattern(response, /temperature: \d+/);
      expect(result.pass).toBe(true);
    });
  });
});

describe('validateError', () => {
  // Helper to create error response
  const errorResponse = (message: string) => ({
    isError: true,
    content: [{ type: 'text', text: message }],
  });

  const successResponse = {
    content: [{ type: 'text', text: 'Success!' }],
  };

  describe('boolean expectations', () => {
    it('should pass when expecting error and response is error', () => {
      const result = validateError(errorResponse('Something went wrong'), true);
      expect(result.pass).toBe(true);
      expect(result.message).toContain('is an error as expected');
    });

    it('should fail when expecting error and response is success', () => {
      const result = validateError(successResponse, true);
      expect(result.pass).toBe(false);
      expect(result.message).toContain('Expected an error');
    });

    it('should pass when expecting success and response is success', () => {
      const result = validateError(successResponse, false);
      expect(result.pass).toBe(true);
      expect(result.message).toContain('is not an error');
    });

    it('should fail when expecting success and response is error', () => {
      const result = validateError(errorResponse('Failed'), false);
      expect(result.pass).toBe(false);
      expect(result.message).toContain('Expected a success response');
    });
  });

  describe('string message expectations', () => {
    it('should pass when error message contains expected text', () => {
      const result = validateError(
        errorResponse('File not found'),
        'not found'
      );
      expect(result.pass).toBe(true);
    });

    it('should fail when error message does not contain expected text', () => {
      const result = validateError(
        errorResponse('Permission denied'),
        'not found'
      );
      expect(result.pass).toBe(false);
      expect(result.message).toContain('does not contain');
    });

    it('should be case-insensitive for message matching', () => {
      const result = validateError(
        errorResponse('FILE NOT FOUND'),
        'file not found'
      );
      expect(result.pass).toBe(true);
    });

    it('should pass when error contains any of multiple expected messages', () => {
      const result = validateError(errorResponse('File not found'), [
        'not found',
        'does not exist',
      ]);
      expect(result.pass).toBe(true);
    });

    it('should fail when none of the expected messages match', () => {
      const result = validateError(errorResponse('Connection timeout'), [
        'not found',
        'permission denied',
      ]);
      expect(result.pass).toBe(false);
    });
  });
});

describe('validateSize', () => {
  describe('maxBytes constraint', () => {
    it('should pass when response is under maximum', () => {
      const result = validateSize('small response', { maxBytes: 100 });
      expect(result.pass).toBe(true);
    });

    it('should fail when response exceeds maximum', () => {
      const largeResponse = 'x'.repeat(1000);
      const result = validateSize(largeResponse, { maxBytes: 100 });
      expect(result.pass).toBe(false);
      expect(result.message).toContain('exceeds maximum');
    });
  });

  describe('minBytes constraint', () => {
    it('should pass when response is above minimum', () => {
      const result = validateSize('adequate response', { minBytes: 10 });
      expect(result.pass).toBe(true);
    });

    it('should fail when response is below minimum', () => {
      const result = validateSize('hi', { minBytes: 100 });
      expect(result.pass).toBe(false);
      expect(result.message).toContain('below minimum');
    });
  });

  describe('both constraints', () => {
    it('should pass when within bounds', () => {
      const result = validateSize('medium response', {
        minBytes: 10,
        maxBytes: 1000,
      });
      expect(result.pass).toBe(true);
    });

    it('should fail when below minimum', () => {
      const result = validateSize('hi', { minBytes: 100, maxBytes: 1000 });
      expect(result.pass).toBe(false);
    });

    it('should fail when above maximum', () => {
      const result = validateSize('x'.repeat(2000), {
        minBytes: 10,
        maxBytes: 1000,
      });
      expect(result.pass).toBe(false);
    });
  });

  describe('edge cases', () => {
    it('should fail when no constraint is provided', () => {
      const result = validateSize('response', {});
      expect(result.pass).toBe(false);
      expect(result.message).toContain('requires at least one');
    });

    it('should handle empty response', () => {
      const result = validateSize('', { minBytes: 0, maxBytes: 100 });
      expect(result.pass).toBe(true);
    });

    it('should handle null/undefined', () => {
      const result = validateSize(null, { maxBytes: 100 });
      expect(result.pass).toBe(true);
    });
  });
});

describe('getResponseSizeBytes', () => {
  it('should return 0 for null', () => {
    expect(getResponseSizeBytes(null)).toBe(0);
  });

  it('should return 0 for undefined', () => {
    expect(getResponseSizeBytes(undefined)).toBe(0);
  });

  it('should return correct size for strings', () => {
    expect(getResponseSizeBytes('hello')).toBe(5);
    expect(getResponseSizeBytes('')).toBe(0);
  });

  it('should handle unicode characters correctly', () => {
    // emoji is 4 bytes in UTF-8
    const size = getResponseSizeBytes('👋');
    expect(size).toBeGreaterThan(1);
  });

  it('should serialize objects to JSON', () => {
    const obj = { hello: 'world' };
    const size = getResponseSizeBytes(obj);
    expect(size).toBeGreaterThan(0);
  });
});
