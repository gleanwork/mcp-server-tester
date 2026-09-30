/**
 * Unit tests for the snapshot validator: sanitizers, and comparison through
 * a snapshot store. The Playwright store is exercised end to end in
 * tests/snapshot.spec.ts, which needs a Playwright test context.
 */

import { describe, it, expect } from 'vitest';
import {
  BUILT_IN_PATTERNS,
  applySanitizers,
  validateSnapshot,
  type SnapshotStore,
} from './snapshot.js';

/** A snapshot store backed by a map; a missing snapshot fails. */
function memoryStore(snapshots: Record<string, string>): SnapshotStore & {
  seen: Array<{ name: string; content: string; negated?: boolean }>;
} {
  const seen: Array<{ name: string; content: string; negated?: boolean }> = [];
  return {
    seen,
    async match(name, content, options = {}) {
      seen.push({ name, content, ...options });
      const saved = snapshots[name];
      if (saved === undefined)
        return { pass: false, message: `No snapshot "${name}"` };
      return saved === content
        ? { pass: true, message: `Matches "${name}"` }
        : { pass: false, message: `"${name}" differs` };
    },
  };
}

describe('validateSnapshot', () => {
  const response = {
    content: [
      {
        type: 'text',
        text: 'id 123e4567-e89b-12d3-a456-426614174000 at 1700000000',
      },
    ],
  };

  it('compares the sanitized response text with the named snapshot', async () => {
    const store = memoryStore({ weather: 'id [UUID] at [TIMESTAMP]' });
    const result = await validateSnapshot(response, 'weather', {
      store,
      sanitizers: ['uuid', 'timestamp'],
    });
    expect(result).toEqual({
      pass: true,
      message: 'Matches "weather"',
      details: { snapshot: 'weather' },
    });
    expect(store.seen).toEqual([
      { name: 'weather', content: 'id [UUID] at [TIMESTAMP]' },
    ]);
  });

  it('asks the store for a negated comparison', async () => {
    const store = memoryStore({ weather: 'x' });
    await validateSnapshot('x', 'weather', { store, negated: true });
    expect(store.seen).toEqual([
      { name: 'weather', content: 'x', negated: true },
    ]);
  });

  it('compares raw text when there are no sanitizers', async () => {
    const store = memoryStore({ weather: 'id [UUID] at [TIMESTAMP]' });
    const result = await validateSnapshot(response, 'weather', { store });
    expect(result.pass).toBe(false);
    expect(result.message).toBe('"weather" differs');
  });

  it('reports what the store says about a missing snapshot', async () => {
    const result = await validateSnapshot(response, 'absent', {
      store: memoryStore({}),
    });
    expect(result).toMatchObject({
      pass: false,
      message: 'No snapshot "absent"',
    });
  });

  it('throws on an invalid sanitizer instead of reporting a mismatch', async () => {
    await expect(
      validateSnapshot(response, 'weather', {
        store: memoryStore({}),
        sanitizers: [{ pattern: '(' }],
      })
    ).rejects.toThrow('invalid regex pattern "("');
  });
});

describe('BUILT_IN_PATTERNS', () => {
  describe('timestamp', () => {
    it('replaces 10-digit Unix timestamps with [TIMESTAMP]', () => {
      const { pattern, replacement } = BUILT_IN_PATTERNS['timestamp']!;
      expect(
        'created at 1700000000 seconds'.replace(pattern, replacement)
      ).toBe('created at [TIMESTAMP] seconds');
    });

    it('replaces 13-digit millisecond timestamps with [TIMESTAMP]', () => {
      const { pattern, replacement } = BUILT_IN_PATTERNS['timestamp']!;
      expect('ts: 1700000000000 ms'.replace(pattern, replacement)).toBe(
        'ts: [TIMESTAMP] ms'
      );
    });
  });

  describe('uuid', () => {
    it('replaces a v4 UUID with [UUID]', () => {
      const { pattern, replacement } = BUILT_IN_PATTERNS['uuid']!;
      const input = 'id: 550e8400-e29b-41d4-a716-446655440000 done';
      expect(input.replace(pattern, replacement)).toBe('id: [UUID] done');
    });

    it('replaces multiple UUIDs in a single string', () => {
      const { pattern, replacement } = BUILT_IN_PATTERNS['uuid']!;
      const input =
        '550e8400-e29b-41d4-a716-446655440000 and 6ba7b810-9dad-11d1-80b4-00c04fd430c8';
      expect(input.replace(pattern, replacement)).toBe('[UUID] and [UUID]');
    });
  });

  describe('iso-date', () => {
    it('replaces a bare date string with [ISO_DATE]', () => {
      const { pattern, replacement } = BUILT_IN_PATTERNS['iso-date']!;
      expect('on 2024-01-15 the event'.replace(pattern, replacement)).toBe(
        'on [ISO_DATE] the event'
      );
    });

    it('replaces a full ISO datetime string with [ISO_DATE]', () => {
      const { pattern, replacement } = BUILT_IN_PATTERNS['iso-date']!;
      expect(
        'at 2024-01-15T10:30:00.000Z exactly'.replace(pattern, replacement)
      ).toBe('at [ISO_DATE] exactly');
    });
  });

  describe('objectId', () => {
    it('replaces a 24-char lowercase hex string with [OBJECT_ID]', () => {
      const { pattern, replacement } = BUILT_IN_PATTERNS['objectId']!;
      const input = 'doc: 507f1f77bcf86cd799439011 saved';
      expect(input.replace(pattern, replacement)).toBe(
        'doc: [OBJECT_ID] saved'
      );
    });
  });

  describe('jwt', () => {
    it('replaces a JWT token with [JWT]', () => {
      const { pattern, replacement } = BUILT_IN_PATTERNS['jwt']!;
      const token =
        'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIiwiaWF0IjoxNTE2MjM5MDIyfQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c';
      expect(`Bearer ${token}`.replace(pattern, replacement)).toBe(
        'Bearer [JWT]'
      );
    });
  });
});

describe('applySanitizers', () => {
  it('applies a single built-in sanitizer by name', () => {
    const result = applySanitizers('ts: 1700000000 end', ['timestamp']);
    expect(result).toBe('ts: [TIMESTAMP] end');
  });

  it('applies multiple built-in sanitizers in sequence', () => {
    const input = 'id: 550e8400-e29b-41d4-a716-446655440000 ts: 1700000000 end';
    const result = applySanitizers(input, ['uuid', 'timestamp']);
    expect(result).toBe('id: [UUID] ts: [TIMESTAMP] end');
  });

  it('silently skips an unknown built-in sanitizer name', () => {
    const input = 'hello world';
    // No error thrown, string unchanged
    expect(() =>
      applySanitizers(input, ['not-a-real-sanitizer' as 'timestamp'])
    ).not.toThrow();
    expect(
      applySanitizers(input, ['not-a-real-sanitizer' as 'timestamp'])
    ).toBe(input);
  });

  it('applies a custom regex sanitizer with a string pattern', () => {
    const result = applySanitizers('foo-123-bar', [
      { pattern: '\\d+', replacement: '[NUM]' },
    ]);
    expect(result).toBe('foo-[NUM]-bar');
  });

  it('applies a custom regex sanitizer with a RegExp object', () => {
    const result = applySanitizers('price: $9.99', [
      { pattern: /\$[\d.]+/, replacement: '[PRICE]' },
    ]);
    expect(result).toBe('price: [PRICE]');
  });

  it('applies a custom regex sanitizer with a custom replacement string', () => {
    const result = applySanitizers('user@example.com', [
      { pattern: /[^@]+@[^@]+/, replacement: '[EMAIL]' },
    ]);
    expect(result).toBe('[EMAIL]');
  });

  it('uses [SANITIZED] as the default replacement when no replacement is specified', () => {
    const result = applySanitizers('secret value here', [
      { pattern: /secret value/ },
    ]);
    expect(result).toBe('[SANITIZED] here');
  });

  it('removes a top-level field from a valid JSON string', () => {
    const input = JSON.stringify({ id: 'abc123', name: 'Alice' }, null, 2);
    const result = applySanitizers(input, [{ remove: ['id'] }]);
    const parsed = JSON.parse(result) as Record<string, unknown>;
    expect(parsed).not.toHaveProperty('id');
    expect(parsed.name).toBe('Alice');
  });

  it("removes a nested field using dot notation (e.g. 'a.b')", () => {
    const input = JSON.stringify(
      { meta: { createdAt: '2024-01-01', author: 'Bob' } },
      null,
      2
    );
    const result = applySanitizers(input, [{ remove: ['meta.createdAt'] }]);
    const parsed = JSON.parse(result) as { meta: Record<string, unknown> };
    expect(parsed.meta).not.toHaveProperty('createdAt');
    expect(parsed.meta.author).toBe('Bob');
  });

  it('does not error when removing a non-existent field path', () => {
    const input = JSON.stringify({ name: 'Alice' }, null, 2);
    expect(() =>
      applySanitizers(input, [{ remove: ['does.not.exist'] }])
    ).not.toThrow();
    const result = applySanitizers(input, [{ remove: ['does.not.exist'] }]);
    const parsed = JSON.parse(result) as Record<string, unknown>;
    expect(parsed.name).toBe('Alice');
  });

  it('silently skips field removal when the input is not valid JSON', () => {
    const input = 'this is plain text, not JSON';
    expect(() =>
      applySanitizers(input, [{ remove: ['someField'] }])
    ).not.toThrow();
    expect(applySanitizers(input, [{ remove: ['someField'] }])).toBe(input);
  });

  it('applies multiple sanitizers in order (regex then field removal)', () => {
    const obj = {
      token: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0In0.abc123',
      name: 'Carol',
    };
    // Start with a JSON string containing a JWT, then strip the token field
    const input = JSON.stringify(obj, null, 2);

    // First sanitizer: replace JWTs in the raw text
    // Second sanitizer: remove the token field entirely
    const result = applySanitizers(input, ['jwt', { remove: ['token'] }]);

    const parsed = JSON.parse(result) as Record<string, unknown>;
    expect(parsed).not.toHaveProperty('token');
    expect(parsed.name).toBe('Carol');
  });

  it('throws a descriptive error for an invalid regex string', () => {
    // The implementation wraps new RegExp() in a try/catch and re-throws
    // with a clear message so callers know which pattern caused the problem.
    expect(() =>
      applySanitizers('some input', [{ pattern: '[invalid regex' }])
    ).toThrow(/invalid regex pattern/);
  });

  it('returns the string unchanged when the sanitizers array is empty', () => {
    const input = 'unchanged content';
    expect(applySanitizers(input, [])).toBe('unchanged content');
  });
});
