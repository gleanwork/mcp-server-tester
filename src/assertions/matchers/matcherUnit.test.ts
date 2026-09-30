import { describe, it, expect as vitestExpect } from 'vitest';
import { z } from 'zod';
import { expect as mcpExpect } from './index.js';

// ---------------------------------------------------------------------------
// Shared test data
// ---------------------------------------------------------------------------

// A plain array of text content blocks (direct mode)
const textResponse = [{ type: 'text', text: 'Hello world' }];

// An error response shaped like a CallToolResult with isError=true
const errorResponse = {
  content: [{ type: 'text', text: 'Error: something failed' }],
  isError: true,
};

// A success response shaped like a CallToolResult with isError=false
const okResponse = {
  content: [{ type: 'text', text: 'Operation succeeded' }],
  isError: false,
};

// ---------------------------------------------------------------------------
// toMatchToolResponse
// ---------------------------------------------------------------------------

describe('toMatchToolResponse', () => {
  it('passes when the received value exactly matches the expected value', () => {
    vitestExpect(() =>
      mcpExpect({ status: 'ok' }).toMatchToolResponse({ status: 'ok' })
    ).not.toThrow();
  });

  it('fails when the received value does not match the expected value', () => {
    vitestExpect(() =>
      mcpExpect({ status: 'ok' }).toMatchToolResponse({ status: 'fail' })
    ).toThrow();
  });

  it('passes on negation when values differ', () => {
    vitestExpect(() =>
      mcpExpect({ status: 'ok' }).not.toMatchToolResponse({ status: 'fail' })
    ).not.toThrow();
  });

  it('fails on negation when values are equal', () => {
    vitestExpect(() =>
      mcpExpect({ status: 'ok' }).not.toMatchToolResponse({ status: 'ok' })
    ).toThrow();
  });

  it('produces a useful error message on mismatch', () => {
    let thrownMessage = '';
    try {
      mcpExpect({ status: 'ok' }).toMatchToolResponse({ status: 'fail' });
    } catch (err) {
      thrownMessage = err instanceof Error ? err.message : String(err);
    }
    vitestExpect(thrownMessage).toContain('does not match');
  });
});

// ---------------------------------------------------------------------------
// toMatchToolSchema
// ---------------------------------------------------------------------------

describe('toMatchToolSchema', () => {
  const CountSchema = z.object({ count: z.number() });

  it('passes when the value conforms to the Zod schema', () => {
    vitestExpect(() =>
      mcpExpect({ count: 5 }).toMatchToolSchema(CountSchema)
    ).not.toThrow();
  });

  it('fails when the value does not conform to the Zod schema', () => {
    vitestExpect(() =>
      mcpExpect({ count: 'not-a-number' }).toMatchToolSchema(CountSchema)
    ).toThrow();
  });

  it('passes on negation when the value fails schema validation', () => {
    vitestExpect(() =>
      mcpExpect({ count: 'bad' }).not.toMatchToolSchema(CountSchema)
    ).not.toThrow();
  });

  it('fails on negation when the value passes schema validation', () => {
    vitestExpect(() =>
      mcpExpect({ count: 5 }).not.toMatchToolSchema(CountSchema)
    ).toThrow();
  });

  it('produces a useful error message on schema mismatch', () => {
    let thrownMessage = '';
    try {
      mcpExpect({ count: 'bad' }).toMatchToolSchema(CountSchema);
    } catch (err) {
      thrownMessage = err instanceof Error ? err.message : String(err);
    }
    // The message should mention the schema failure in some way
    vitestExpect(thrownMessage.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// toContainToolText
// ---------------------------------------------------------------------------

describe('toContainToolText', () => {
  it('passes when the response contains the expected substring', () => {
    vitestExpect(() =>
      mcpExpect(textResponse).toContainToolText('Hello')
    ).not.toThrow();
  });

  it('fails when the response does not contain the expected substring', () => {
    vitestExpect(() =>
      mcpExpect(textResponse).toContainToolText('goodbye')
    ).toThrow();
  });

  it('passes when the response contains all expected substrings from an array', () => {
    vitestExpect(() =>
      mcpExpect(textResponse).toContainToolText(['Hello', 'world'])
    ).not.toThrow();
  });

  it('fails when any expected substring from an array is missing', () => {
    vitestExpect(() =>
      mcpExpect(textResponse).toContainToolText(['Hello', 'missing'])
    ).toThrow();
  });

  it('passes on negation when the expected text is absent', () => {
    vitestExpect(() =>
      mcpExpect(textResponse).not.toContainToolText('goodbye')
    ).not.toThrow();
  });

  it('fails on negation when the expected text is present', () => {
    vitestExpect(() =>
      mcpExpect(textResponse).not.toContainToolText('Hello')
    ).toThrow();
  });

  it('produces a useful error message listing the missing text', () => {
    let thrownMessage = '';
    try {
      mcpExpect(textResponse).toContainToolText('nothere');
    } catch (err) {
      thrownMessage = err instanceof Error ? err.message : String(err);
    }
    vitestExpect(thrownMessage).toContain('nothere');
  });

  it('supports case-insensitive matching via options', () => {
    vitestExpect(() =>
      mcpExpect(textResponse).toContainToolText('HELLO', {
        caseSensitive: false,
      })
    ).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// toMatchToolPattern
// ---------------------------------------------------------------------------

describe('toMatchToolPattern', () => {
  const orderResponse = [{ type: 'text', text: 'Order #12345' }];

  it('passes when the response text matches a string pattern', () => {
    vitestExpect(() =>
      mcpExpect(orderResponse).toMatchToolPattern('#\\d+')
    ).not.toThrow();
  });

  it('fails when the response text does not match the string pattern', () => {
    vitestExpect(() =>
      mcpExpect(orderResponse).toMatchToolPattern('#[A-Z]+')
    ).toThrow();
  });

  it('passes when the response text matches a RegExp', () => {
    vitestExpect(() =>
      mcpExpect(orderResponse).toMatchToolPattern(/Order #\d+/)
    ).not.toThrow();
  });

  it('fails when the response text does not match a RegExp', () => {
    vitestExpect(() =>
      mcpExpect(orderResponse).toMatchToolPattern(/Invoice #\d+/)
    ).toThrow();
  });

  it('passes when all patterns in an array match', () => {
    vitestExpect(() =>
      mcpExpect(orderResponse).toMatchToolPattern(['Order', '#\\d+'])
    ).not.toThrow();
  });

  it('fails when any pattern in an array does not match', () => {
    vitestExpect(() =>
      mcpExpect(orderResponse).toMatchToolPattern(['Order', 'Invoice'])
    ).toThrow();
  });

  it('passes on negation when no pattern matches', () => {
    vitestExpect(() =>
      mcpExpect(orderResponse).not.toMatchToolPattern('Invoice')
    ).not.toThrow();
  });

  it('fails on negation when the pattern matches', () => {
    vitestExpect(() =>
      mcpExpect(orderResponse).not.toMatchToolPattern('#\\d+')
    ).toThrow();
  });

  it('produces a useful error message on pattern mismatch', () => {
    let thrownMessage = '';
    try {
      mcpExpect(orderResponse).toMatchToolPattern('Invoice');
    } catch (err) {
      thrownMessage = err instanceof Error ? err.message : String(err);
    }
    vitestExpect(thrownMessage.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// toBeToolError
// ---------------------------------------------------------------------------

describe('toBeToolError', () => {
  it('passes when the response has isError: true', () => {
    vitestExpect(() => mcpExpect(errorResponse).toBeToolError()).not.toThrow();
  });

  it('fails when the response does not have isError: true', () => {
    vitestExpect(() => mcpExpect(okResponse).toBeToolError()).toThrow();
  });

  it('passes on negation when the response is not an error', () => {
    vitestExpect(() => mcpExpect(okResponse).not.toBeToolError()).not.toThrow();
  });

  it('fails on negation when the response is an error', () => {
    vitestExpect(() => mcpExpect(errorResponse).not.toBeToolError()).toThrow();
  });

  it('passes when the error message contains the expected string', () => {
    vitestExpect(() =>
      mcpExpect(errorResponse).toBeToolError('something failed')
    ).not.toThrow();
  });

  it('fails when the error message does not contain the expected string', () => {
    vitestExpect(() =>
      mcpExpect(errorResponse).toBeToolError('completely different message')
    ).toThrow();
  });

  it('produces a useful error message when expecting an error but got success', () => {
    let thrownMessage = '';
    try {
      mcpExpect(okResponse).toBeToolError();
    } catch (err) {
      thrownMessage = err instanceof Error ? err.message : String(err);
    }
    vitestExpect(thrownMessage).toContain('error');
  });
});

// ---------------------------------------------------------------------------
// toHaveToolResponseSize
// ---------------------------------------------------------------------------

describe('toHaveToolResponseSize', () => {
  // textResponse = [{ type: 'text', text: 'Hello world' }]
  // Serialized as JSON with 2-space indent — well over 1 byte, well under 10 000 bytes

  it('passes when the response is under the maxBytes limit', () => {
    vitestExpect(() =>
      mcpExpect(textResponse).toHaveToolResponseSize({ maxBytes: 10_000 })
    ).not.toThrow();
  });

  it('fails when the response exceeds the maxBytes limit', () => {
    vitestExpect(() =>
      mcpExpect(textResponse).toHaveToolResponseSize({ maxBytes: 1 })
    ).toThrow();
  });

  it('passes when the response is above the minBytes threshold', () => {
    vitestExpect(() =>
      mcpExpect(textResponse).toHaveToolResponseSize({ minBytes: 1 })
    ).not.toThrow();
  });

  it('fails when the response is below the minBytes threshold', () => {
    vitestExpect(() =>
      mcpExpect(textResponse).toHaveToolResponseSize({ minBytes: 1_000_000 })
    ).toThrow();
  });

  it('passes when the response is within both minBytes and maxBytes', () => {
    vitestExpect(() =>
      mcpExpect(textResponse).toHaveToolResponseSize({
        minBytes: 1,
        maxBytes: 10_000,
      })
    ).not.toThrow();
  });

  it('passes on negation when the response exceeds the maxBytes limit', () => {
    vitestExpect(() =>
      mcpExpect(textResponse).not.toHaveToolResponseSize({ maxBytes: 1 })
    ).not.toThrow();
  });

  it('fails on negation when the response is within the maxBytes limit', () => {
    vitestExpect(() =>
      mcpExpect(textResponse).not.toHaveToolResponseSize({ maxBytes: 10_000 })
    ).toThrow();
  });

  it('produces a useful error message when the size limit is exceeded', () => {
    let thrownMessage = '';
    try {
      mcpExpect(textResponse).toHaveToolResponseSize({ maxBytes: 1 });
    } catch (err) {
      thrownMessage = err instanceof Error ? err.message : String(err);
    }
    vitestExpect(thrownMessage).toContain('maximum');
  });
});

// ---------------------------------------------------------------------------
// toSatisfyToolPredicate
// ---------------------------------------------------------------------------

describe('toSatisfyToolPredicate', () => {
  const valueResponse = [{ type: 'text', text: 'value: 42' }];

  it('passes when the predicate returns true', async () => {
    await vitestExpect(
      mcpExpect(valueResponse).toSatisfyToolPredicate((_resp, text) =>
        text.includes('42')
      )
    ).resolves.not.toThrow();
  });

  it('fails when the predicate returns false', async () => {
    await vitestExpect(
      mcpExpect(valueResponse).toSatisfyToolPredicate((_resp, text) =>
        text.includes('99')
      )
    ).rejects.toThrow();
  });

  it('passes when the predicate returns an object with pass: true', async () => {
    await vitestExpect(
      mcpExpect(valueResponse).toSatisfyToolPredicate((_resp, text) => ({
        pass: text.includes('42'),
        message: 'Expected 42 in response',
      }))
    ).resolves.not.toThrow();
  });

  it('fails when the predicate returns an object with pass: false', async () => {
    await vitestExpect(
      mcpExpect(valueResponse).toSatisfyToolPredicate((_resp, text) => ({
        pass: text.includes('99'),
        message: 'Expected 99 in response',
      }))
    ).rejects.toThrow();
  });

  // .not negates the predicate, as for every other matcher.
  it('fails on negation when the predicate returns true', async () => {
    await vitestExpect(
      mcpExpect(valueResponse).not.toSatisfyToolPredicate((_resp, text) =>
        text.includes('42')
      )
    ).rejects.toThrow('Expected response NOT to satisfy custom predicate');
  });

  it('passes on negation when the predicate returns false', async () => {
    await vitestExpect(
      mcpExpect(valueResponse).not.toSatisfyToolPredicate((_resp, text) =>
        text.includes('99')
      )
    ).resolves.not.toThrow();
  });

  it('fails with or without .not when the predicate throws', async () => {
    function crash(): boolean {
      throw new Error('boom');
    }
    await vitestExpect(
      mcpExpect(valueResponse).toSatisfyToolPredicate(crash)
    ).rejects.toThrow('Predicate threw error: boom');
    await vitestExpect(
      mcpExpect(valueResponse).not.toSatisfyToolPredicate(crash)
    ).rejects.toThrow('Predicate threw error: boom');
  });

  it('passes with an async predicate that resolves to true', async () => {
    await vitestExpect(
      mcpExpect(valueResponse).toSatisfyToolPredicate(async (_resp, text) =>
        Promise.resolve(text.includes('42'))
      )
    ).resolves.not.toThrow();
  });

  it('fails with an async predicate that resolves to false', async () => {
    await vitestExpect(
      mcpExpect(valueResponse).toSatisfyToolPredicate(async (_resp, text) =>
        Promise.resolve(text.includes('99'))
      )
    ).rejects.toThrow();
  });

  it('includes the custom message in failure output when the predicate uses object result', async () => {
    let thrownMessage = '';
    try {
      await mcpExpect(valueResponse).toSatisfyToolPredicate((_resp, text) => ({
        pass: text.includes('99'),
        message: 'Custom failure: expected 99',
      }));
    } catch (err) {
      thrownMessage = err instanceof Error ? err.message : String(err);
    }
    vitestExpect(thrownMessage).toContain('Custom failure: expected 99');
  });
});
