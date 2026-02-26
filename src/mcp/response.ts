import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

/**
 * A single content block from an MCP response
 */
export interface ContentBlock {
  type: string;
  text?: string;
  data?: unknown;
  mimeType?: string;
}

/**
 * Normalized representation of an MCP tool response
 *
 * This provides a consistent interface regardless of the response format
 * returned by the MCP server.
 */
export interface NormalizedToolResponse {
  /**
   * Extracted text content (concatenated from all text blocks)
   */
  text: string;

  /**
   * Original raw response from the MCP SDK
   */
  raw: CallToolResult;

  /**
   * Whether the tool call resulted in an error
   */
  isError: boolean;

  /**
   * Parsed content blocks from the response
   */
  contentBlocks: ContentBlock[];

  /**
   * Structured content if present (parsed JSON or raw data)
   */
  structuredContent: unknown;
}

/**
 * Normalizes an MCP CallToolResult into a consistent format
 *
 * @param result - Raw CallToolResult from the MCP SDK
 * @returns Normalized response with extracted text, content blocks, etc.
 *
 * @example
 * ```typescript
 * const result = await client.callTool({ name: 'read_file', arguments: { path: 'readme.txt' } });
 * const normalized = normalizeToolResponse(result);
 *
 * console.log(normalized.text);           // "Hello World"
 * console.log(normalized.isError);        // false
 * console.log(normalized.contentBlocks);  // [{ type: 'text', text: 'Hello World' }]
 * ```
 */
export function normalizeToolResponse(
  result: CallToolResult
): NormalizedToolResponse {
  const isError = result.isError ?? false;
  const contentBlocks: ContentBlock[] = [];
  const textParts: string[] = [];

  // Parse content array if present
  if (Array.isArray(result.content)) {
    for (const block of result.content) {
      if (block == null || typeof block !== 'object') {
        continue;
      }

      const b = block as Record<string, unknown>;
      const contentBlock: ContentBlock = {
        type: typeof b.type === 'string' ? b.type : 'unknown',
      };

      // Extract text if present
      if (typeof b.text === 'string') {
        contentBlock.text = b.text;
        textParts.push(b.text);
      }

      // Extract data/blob if present
      if (b.data !== undefined) {
        contentBlock.data = b.data;
      }

      // Extract mimeType if present
      if (typeof b.mimeType === 'string') {
        contentBlock.mimeType = b.mimeType;
      }

      contentBlocks.push(contentBlock);
    }
  }

  // Handle structuredContent
  let structuredContent: unknown = null;
  if (result.structuredContent !== undefined) {
    structuredContent = result.structuredContent;

    // If no text was extracted from content blocks, try to get text from structuredContent
    if (textParts.length === 0) {
      if (typeof result.structuredContent === 'string') {
        textParts.push(result.structuredContent);
      } else if (result.structuredContent != null) {
        // For objects/arrays, stringify for text representation
        textParts.push(JSON.stringify(result.structuredContent));
      }
    }
  }

  // Build final text by joining all parts
  const text = textParts.join('\n');

  return {
    text,
    raw: result,
    isError,
    contentBlocks,
    structuredContent,
  };
}

/**
 * Extracts just the text content from a normalized or raw response
 *
 * This is a convenience function that works with both:
 * - Raw CallToolResult from the MCP SDK
 * - NormalizedToolResponse from normalizeToolResponse()
 * - Plain strings or other legacy formats
 *
 * @param response - Response in any supported format
 * @returns Extracted text content
 */
export function extractText(response: unknown): string {
  // Handle null/undefined
  if (response == null) {
    return '';
  }

  // Plain string
  if (typeof response === 'string') {
    return response;
  }

  // Already normalized response
  if (isNormalizedResponse(response)) {
    return response.text;
  }

  // Raw CallToolResult - normalize it first
  if (isCallToolResult(response)) {
    return normalizeToolResponse(response).text;
  }

  // Array of content blocks (direct content)
  if (Array.isArray(response)) {
    return extractTextFromContentArray(response);
  }

  // Generic object - try common patterns
  if (typeof response === 'object') {
    const r = response as Record<string, unknown>;

    // Check for content array
    if (Array.isArray(r.content)) {
      return extractTextFromContentArray(r.content);
    }

    // Check for content as a direct string (single content block format)
    if (typeof r.content === 'string') {
      return r.content;
    }

    // Check for structuredContent
    if (r.structuredContent !== undefined) {
      if (typeof r.structuredContent === 'string') {
        return r.structuredContent;
      }
      return JSON.stringify(r.structuredContent);
    }

    // Check for direct text field
    if (typeof r.text === 'string') {
      return r.text;
    }

    // Fallback to JSON
    return JSON.stringify(r);
  }

  // Primitives (number, boolean, bigint, symbol)
  if (
    typeof response === 'number' ||
    typeof response === 'boolean' ||
    typeof response === 'bigint'
  ) {
    return String(response);
  }

  // Symbol or other edge cases
  return '';
}

/**
 * Type guard for NormalizedToolResponse
 */
function isNormalizedResponse(value: unknown): value is NormalizedToolResponse {
  if (value == null || typeof value !== 'object') {
    return false;
  }
  const v = value as Record<string, unknown>;
  return (
    typeof v.text === 'string' &&
    typeof v.isError === 'boolean' &&
    Array.isArray(v.contentBlocks) &&
    v.raw !== undefined
  );
}

/**
 * Type guard for CallToolResult
 */
function isCallToolResult(value: unknown): value is CallToolResult {
  if (value == null || typeof value !== 'object') {
    return false;
  }
  const v = value as Record<string, unknown>;
  // Per MCP spec, content is required in CallToolResult — isError alone is insufficient
  return Array.isArray(v.content);
}

/**
 * Extracts text from a content block array
 */
function extractTextFromContentArray(content: unknown[]): string {
  const textParts: string[] = [];

  for (const block of content) {
    if (block == null || typeof block !== 'object') {
      continue;
    }
    const b = block as Record<string, unknown>;
    if (b.type === 'text' && typeof b.text === 'string') {
      textParts.push(b.text);
    }
  }

  if (textParts.length > 0) {
    return textParts.join('\n');
  }

  // No text blocks found, stringify the whole array
  return JSON.stringify(content);
}
