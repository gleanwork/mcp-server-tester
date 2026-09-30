/**
 * Expectation suggester - analyzes MCP tool responses and suggests appropriate expectations
 */

import type { Tool } from '@modelcontextprotocol/client';
import { extractText } from '../../mcp/response.js';

export interface ExpectationSuggestions {
  textContains: string[];
  regex: string[];
}

/**
 * Suggests expectations based on a tool response
 *
 * @param response - The tool response to analyze
 * @param tool - The tool that generated the response
 * @returns Suggested expectations
 */
export function suggestExpectations(
  response: unknown,
  tool: Tool
): ExpectationSuggestions {
  const suggestions: ExpectationSuggestions = {
    textContains: [],
    regex: [],
  };

  // Extract text from response
  const text = extractText(response);

  // Suggest text contains expectations
  suggestions.textContains = suggestTextContains(text, tool);

  // Suggest regex patterns
  suggestions.regex = suggestRegexPatterns(text, tool);

  return suggestions;
}

/**
 * Suggests text contains expectations by extracting key phrases
 */
function suggestTextContains(text: string, _tool: Tool): string[] {
  const suggestions: string[] = [];

  // Extract markdown headers (## Header, ### Header)
  const headerMatches = text.matchAll(/^(#{1,6})\s+(.+)$/gm);
  for (const match of headerMatches) {
    suggestions.push(`${match[1]} ${match[2]}`);
  }

  // Extract bold text (**text**)
  const boldMatches = text.matchAll(/\*\*([^*]+)\*\*/g);
  const boldTexts = Array.from(boldMatches, (m) => m[0]);
  if (boldTexts.length > 0 && boldTexts.length <= 5) {
    suggestions.push(...boldTexts.slice(0, 3)); // Limit to first 3
  }

  // Extract key-value pairs (Key: value)
  const kvMatches = text.matchAll(/^([A-Z][a-z\s]+):\s*(.+)$/gm);
  const kvPairs = Array.from(kvMatches, (m) => m[0]);
  if (kvPairs.length > 0 && kvPairs.length <= 5) {
    suggestions.push(...kvPairs.slice(0, 3)); // Limit to first 3
  }

  // If nothing found, extract first few words (up to 50 chars)
  if (suggestions.length === 0 && text.length > 10) {
    const firstLine = text.split('\n')[0];
    if (firstLine && firstLine.length > 0) {
      suggestions.push(firstLine.substring(0, 50));
    }
  }

  return [...new Set(suggestions)]; // Remove duplicates
}

/**
 * Suggests regex patterns based on common formats found in text
 */
function suggestRegexPatterns(text: string, _tool: Tool): string[] {
  const patterns: string[] = [];

  // Check for markdown headers
  if (/^#{1,6}\s+/m.test(text)) {
    patterns.push('^#{1,6}\\s+\\w+');
  }

  // Check for dates (YYYY-MM-DD)
  if (/\d{4}-\d{2}-\d{2}/.test(text)) {
    patterns.push('\\d{4}-\\d{2}-\\d{2}');
  }

  // Check for time (HH:MM or HH:MM:SS)
  if (/\d{1,2}:\d{2}(:\d{2})?/.test(text)) {
    patterns.push('\\d{1,2}:\\d{2}');
  }

  // Check for temperatures (e.g., 20°C, 68°F)
  if (/\d+°[CF]/.test(text)) {
    patterns.push('\\d+°[CF]');
  }

  // Check for URLs
  if (/https?:\/\/[^\s]+/.test(text)) {
    patterns.push('https?://[\\w.-]+');
  }

  // Check for email addresses
  if (/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/.test(text)) {
    patterns.push('[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\\.[a-zA-Z]{2,}');
  }

  // Check for percentages
  if (/\d+(\.\d+)?%/.test(text)) {
    patterns.push('\\d+(\\.\\d+)?%');
  }

  // Check for currency (e.g., $12.99, £50.00)
  if (/[$£€]\d+(\.\d{2})?/.test(text)) {
    patterns.push('[$£€]\\d+(\\.\\d{2})?');
  }

  // Check for bold markdown (**text**)
  if (/\*\*[^*]+\*\*/.test(text)) {
    patterns.push('\\*\\*\\w+:\\*\\*');
  }

  // Check for list items (- item or * item)
  if (/^[-*]\s+/m.test(text)) {
    patterns.push('^[-*]\\s+[\\w\\s]+');
  }

  // Check for numbered lists (1. item, 2. item)
  if (/^\d+\.\s+/m.test(text)) {
    patterns.push('^\\d+\\.\\s+');
  }

  // Check for phone numbers (various formats)
  if (/\(\d{3}\)\s*\d{3}-\d{4}|\d{3}-\d{3}-\d{4}|\d{10}/.test(text)) {
    patterns.push('\\d{3}[-.]?\\d{3}[-.]?\\d{4}');
  }

  // Check for IP addresses
  if (/\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}/.test(text)) {
    patterns.push('\\d{1,3}\\.\\d{1,3}\\.\\d{1,3}\\.\\d{1,3}');
  }

  return [...new Set(patterns)]; // Remove duplicates
}
