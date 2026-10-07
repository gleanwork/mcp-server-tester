import { describe, it, expect } from 'vitest';
import { suggestAssertions } from './assertionSuggester.js';
import type { Tool } from '@modelcontextprotocol/client';

const dummyTool: Tool = {
  name: 'test_tool',
  description: 'A test tool',
  inputSchema: { type: 'object' as const, properties: {} },
};

function makeResponse(text: string): unknown {
  return { content: [{ type: 'text', text }] };
}

describe('suggestAssertions', () => {
  describe('textContains suggestions', () => {
    it('extracts markdown headers', () => {
      const { textContains } = suggestAssertions(
        makeResponse('## Weather Report\n\nSome content'),
        dummyTool
      );
      expect(textContains).toContain('## Weather Report');
    });

    it('extracts bold text when 5 or fewer instances', () => {
      const { textContains } = suggestAssertions(
        makeResponse('**Temperature:** 20°C\n**Humidity:** 60%'),
        dummyTool
      );
      expect(textContains.some((s) => s.startsWith('**'))).toBe(true);
    });

    it('falls back to first line when nothing else matches', () => {
      const { textContains } = suggestAssertions(
        makeResponse('Simple plain text response'),
        dummyTool
      );
      expect(textContains.length).toBeGreaterThan(0);
      expect(textContains[0]).toContain('Simple plain text');
    });

    it('returns empty array for very short response', () => {
      const { textContains } = suggestAssertions(makeResponse('ok'), dummyTool);
      expect(textContains).toHaveLength(0);
    });
  });

  describe('regex pattern suggestions', () => {
    it('suggests date pattern for YYYY-MM-DD dates', () => {
      const { regex } = suggestAssertions(
        makeResponse('Updated on 2024-03-15'),
        dummyTool
      );
      expect(regex).toContain('\\d{4}-\\d{2}-\\d{2}');
    });

    it('suggests URL pattern for http/https links', () => {
      const { regex } = suggestAssertions(
        makeResponse('Visit https://example.com for details'),
        dummyTool
      );
      expect(regex).toContain('https?://[\\w.-]+');
    });

    it('suggests email pattern for email addresses', () => {
      const { regex } = suggestAssertions(
        makeResponse('Contact us at support@example.com'),
        dummyTool
      );
      expect(regex).toContain(
        '[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\\.[a-zA-Z]{2,}'
      );
    });

    it('suggests percentage pattern', () => {
      const { regex } = suggestAssertions(
        makeResponse('Success rate: 99.5%'),
        dummyTool
      );
      expect(regex).toContain('\\d+(\\.\\d+)?%');
    });

    it('suggests currency pattern for $', () => {
      const { regex } = suggestAssertions(
        makeResponse('Price: $12.99'),
        dummyTool
      );
      expect(regex).toContain('[$£€]\\d+(\\.\\d{2})?');
    });

    it('suggests list item pattern for markdown lists', () => {
      const { regex } = suggestAssertions(
        makeResponse('- item one\n- item two'),
        dummyTool
      );
      expect(regex).toContain('^[-*]\\s+[\\w\\s]+');
    });

    it('suggests numbered list pattern', () => {
      const { regex } = suggestAssertions(
        makeResponse('1. First item\n2. Second item'),
        dummyTool
      );
      expect(regex).toContain('^\\d+\\.\\s+');
    });

    it('suggests IP address pattern', () => {
      const { regex } = suggestAssertions(
        makeResponse('Server at 192.168.1.100'),
        dummyTool
      );
      expect(regex).toContain('\\d{1,3}\\.\\d{1,3}\\.\\d{1,3}\\.\\d{1,3}');
    });

    it('returns no duplicates', () => {
      const { regex } = suggestAssertions(
        makeResponse('Date: 2024-01-01, Price: $9.99, Rate: 50%'),
        dummyTool
      );
      const unique = new Set(regex);
      expect(regex.length).toBe(unique.size);
    });
  });
});
