import { describe, it, expect } from 'vitest';
import { normalizeToolResponse, extractText } from './response.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

describe('normalizeToolResponse', () => {
  describe('basic normalization', () => {
    it('should normalize a simple text response', () => {
      const result: CallToolResult = {
        content: [{ type: 'text', text: 'Hello World' }],
      };

      const normalized = normalizeToolResponse(result);

      expect(normalized.text).toBe('Hello World');
      expect(normalized.isError).toBe(false);
      expect(normalized.contentBlocks).toHaveLength(1);
      expect(normalized.contentBlocks[0]).toEqual({
        type: 'text',
        text: 'Hello World',
      });
      expect(normalized.raw).toBe(result);
    });

    it('should normalize a response with isError true', () => {
      const result: CallToolResult = {
        content: [{ type: 'text', text: 'Error occurred' }],
        isError: true,
      };

      const normalized = normalizeToolResponse(result);

      expect(normalized.isError).toBe(true);
      expect(normalized.text).toBe('Error occurred');
    });

    it('should default isError to false when undefined', () => {
      const result: CallToolResult = {
        content: [{ type: 'text', text: 'Success' }],
      };

      const normalized = normalizeToolResponse(result);

      expect(normalized.isError).toBe(false);
    });
  });

  describe('multiple content blocks', () => {
    it('should concatenate text from multiple blocks', () => {
      const result: CallToolResult = {
        content: [
          { type: 'text', text: 'Line 1' },
          { type: 'text', text: 'Line 2' },
          { type: 'text', text: 'Line 3' },
        ],
      };

      const normalized = normalizeToolResponse(result);

      expect(normalized.text).toBe('Line 1\nLine 2\nLine 3');
      expect(normalized.contentBlocks).toHaveLength(3);
    });

    it('should handle mixed content types', () => {
      const result: CallToolResult = {
        content: [
          { type: 'text', text: 'Hello' },
          { type: 'image', data: 'base64data', mimeType: 'image/png' },
          { type: 'text', text: 'World' },
        ],
      };

      const normalized = normalizeToolResponse(result);

      expect(normalized.text).toBe('Hello\nWorld');
      expect(normalized.contentBlocks).toHaveLength(3);
      expect(normalized.contentBlocks[1]).toEqual({
        type: 'image',
        data: 'base64data',
        mimeType: 'image/png',
      });
    });
  });

  describe('structuredContent handling', () => {
    it('should extract structuredContent as object', () => {
      const result: CallToolResult = {
        content: [],
        structuredContent: { key: 'value', nested: { a: 1 } },
      };

      const normalized = normalizeToolResponse(result);

      expect(normalized.structuredContent).toEqual({
        key: 'value',
        nested: { a: 1 },
      });
    });

    it('should use structuredContent as text when no content blocks', () => {
      const result: CallToolResult = {
        content: [],
        structuredContent: { city: 'London', temp: 20 },
      };

      const normalized = normalizeToolResponse(result);

      expect(normalized.text).toBe('{"city":"London","temp":20}');
    });

    it('should use structuredContent string directly', () => {
      // Cast to unknown to test runtime behavior with string structuredContent
      const result: CallToolResult = {
        content: [],
        structuredContent: 'plain text structured content' as unknown as Record<
          string,
          unknown
        >,
      };

      const normalized = normalizeToolResponse(result);

      expect(normalized.text).toBe('plain text structured content');
    });

    it('should prefer content blocks text over structuredContent', () => {
      const result: CallToolResult = {
        content: [{ type: 'text', text: 'From content' }],
        structuredContent: 'From structured' as unknown as Record<
          string,
          unknown
        >,
      };

      const normalized = normalizeToolResponse(result);

      expect(normalized.text).toBe('From content');
    });
  });

  describe('edge cases', () => {
    it('should handle empty content array', () => {
      const result: CallToolResult = { content: [] };

      const normalized = normalizeToolResponse(result);

      expect(normalized.text).toBe('');
      expect(normalized.contentBlocks).toHaveLength(0);
    });

    it('should skip null/undefined content blocks', () => {
      const result: CallToolResult = {
        content: [
          { type: 'text', text: 'Hello' },
          null as unknown,
          undefined as unknown,
          { type: 'text', text: 'World' },
        ] as CallToolResult['content'],
      };

      const normalized = normalizeToolResponse(result);

      expect(normalized.text).toBe('Hello\nWorld');
      expect(normalized.contentBlocks).toHaveLength(2);
    });

    it('should handle content blocks without text', () => {
      const result: CallToolResult = {
        content: [{ type: 'image', data: 'abc123', mimeType: 'image/jpeg' }],
      };

      const normalized = normalizeToolResponse(result);

      expect(normalized.text).toBe('');
      expect(normalized.contentBlocks).toHaveLength(1);
    });

    it('should handle content with unknown type', () => {
      const result: CallToolResult = {
        content: [
          { text: 'No type specified' } as unknown,
        ] as CallToolResult['content'],
      };

      const normalized = normalizeToolResponse(result);

      expect(normalized.contentBlocks[0]!.type).toBe('unknown');
    });
  });
});

describe('extractText', () => {
  describe('primitives', () => {
    it('should return empty string for null', () => {
      expect(extractText(null)).toBe('');
    });

    it('should return empty string for undefined', () => {
      expect(extractText(undefined)).toBe('');
    });

    it('should return the string directly', () => {
      expect(extractText('hello world')).toBe('hello world');
    });

    it('should convert numbers to string', () => {
      expect(extractText(42)).toBe('42');
    });

    it('should convert booleans to string', () => {
      expect(extractText(true)).toBe('true');
    });
  });

  describe('CallToolResult', () => {
    it('should extract text from CallToolResult', () => {
      const result: CallToolResult = {
        content: [{ type: 'text', text: 'Hello from tool' }],
      };

      expect(extractText(result)).toBe('Hello from tool');
    });

    it('should recognize CallToolResult by content array', () => {
      const result = {
        isError: false,
        content: [{ type: 'text', text: 'Success' }],
      };

      expect(extractText(result)).toBe('Success');
    });

    it('rejects objects with isError but no content array', () => {
      // Objects with only isError and no content should NOT be treated as CallToolResult
      // They fall through to generic object handling, not CallToolResult normalization
      const errorOnly = { isError: true };
      const errorFalseOnly = { isError: false };
      const withContent = { content: [], isError: true };
      const contentOnly = { content: [] };

      // isError alone: falls to generic object, returns JSON stringification
      expect(extractText(errorOnly)).toBe('{"isError":true}');
      expect(extractText(errorFalseOnly)).toBe('{"isError":false}');
      // content array present: correctly identified as CallToolResult
      expect(extractText(withContent)).toBe('');
      expect(extractText(contentOnly)).toBe('');
    });
  });

  describe('NormalizedToolResponse', () => {
    it('should extract text from NormalizedToolResponse', () => {
      const normalized = normalizeToolResponse({
        content: [{ type: 'text', text: 'Normalized text' }],
      });

      expect(extractText(normalized)).toBe('Normalized text');
    });
  });

  describe('content arrays', () => {
    it('should extract text from content block array', () => {
      const content = [
        { type: 'text', text: 'First' },
        { type: 'text', text: 'Second' },
      ];

      expect(extractText(content)).toBe('First\nSecond');
    });

    it('should stringify array if no text blocks found', () => {
      const content = [{ type: 'image', data: 'abc' }];

      expect(extractText(content)).toBe('[{"type":"image","data":"abc"}]');
    });
  });

  describe('generic objects', () => {
    it('should extract text from content property', () => {
      const obj = {
        content: [{ type: 'text', text: 'From content' }],
      };

      expect(extractText(obj)).toBe('From content');
    });

    it('should extract string structuredContent', () => {
      const obj = {
        structuredContent: 'Structured string',
      };

      expect(extractText(obj)).toBe('Structured string');
    });

    it('should stringify object structuredContent', () => {
      const obj = {
        structuredContent: { key: 'value' },
      };

      expect(extractText(obj)).toBe('{"key":"value"}');
    });

    it('should extract from text property', () => {
      const obj = { text: 'Direct text' };

      expect(extractText(obj)).toBe('Direct text');
    });

    it('should stringify object as fallback', () => {
      const obj = { foo: 'bar', baz: 123 };

      expect(extractText(obj)).toBe('{"foo":"bar","baz":123}');
    });
  });

  describe('priority handling', () => {
    it('should prefer content over structuredContent', () => {
      const obj = {
        content: [{ type: 'text', text: 'From content' }],
        structuredContent: 'From structured',
      };

      expect(extractText(obj)).toBe('From content');
    });

    it('should use structuredContent when content has no text', () => {
      const obj = {
        content: [{ type: 'image', data: 'abc' }],
        structuredContent: 'Fallback to structured',
      };

      // Content array exists but has no text blocks, extractText uses extractTextFromContentArray
      // which returns structuredContent when it's a CallToolResult-like object
      // Actually, since it's recognized as CallToolResult (has content array),
      // it normalizes it and uses structuredContent as fallback text
      expect(extractText(obj)).toBe('Fallback to structured');
    });
  });
});
