import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { describeError } from './describeError.js';

describe('describeError', () => {
  it("lists a Zod failure's issues", () => {
    const result = z
      .object({ name: z.string() })
      .strict()
      .safeParse({ nam: 1 });
    const message = describeError(result.error);
    expect(message.startsWith('Invalid configuration:\n')).toBe(true);
    expect(message).toContain('Unrecognized key');
    expect(message).not.toContain('"code"');
  });

  it("gives an Error's message, or the value", () => {
    expect(describeError(new Error('Not found.'))).toBe('Not found.');
    expect(describeError('plain')).toBe('plain');
    expect(describeError(undefined)).toBe('undefined');
  });
});
