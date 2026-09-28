import { describe, it, expect } from 'vitest';
import {
  parseSkillFrontmatter,
  skillDigest,
  skillNameFromUri,
  skillRootUri,
  stableJson,
  validateSkillEntry,
} from './skillEntry.js';
import type { SkillEntry } from './skillsTypes.js';

const DIGEST = `sha256:${'a'.repeat(64)}`;

function entry(overrides: Partial<SkillEntry> = {}): SkillEntry {
  return {
    uri: 'skill://acme/billing/refunds/SKILL.md',
    frontmatter: { name: 'refunds', description: 'Process refunds' },
    resources: [
      {
        uri: 'skill://acme/billing/refunds/SKILL.md',
        digest: DIGEST,
        size: 10,
      },
      {
        uri: 'skill://acme/billing/refunds/examples/email.md',
        digest: DIGEST,
        size: 5,
      },
    ],
    ...overrides,
  };
}

const messages = (e: SkillEntry) => validateSkillEntry(e).map((p) => p.message);

describe('skill URIs', () => {
  it('derives the root and name from a SKILL.md URI', () => {
    expect(skillRootUri('skill://acme/billing/refunds/SKILL.md')).toBe(
      'skill://acme/billing/refunds'
    );
    expect(skillNameFromUri('skill://acme/billing/refunds/SKILL.md')).toBe(
      'refunds'
    );
    expect(skillNameFromUri('skill://git-workflow/SKILL.md')).toBe(
      'git-workflow'
    );
    expect(skillRootUri('skill://x/README.md')).toBeNull();
  });
});

describe('validateSkillEntry', () => {
  it('accepts a valid entry and a dynamic entry', () => {
    expect(validateSkillEntry(entry())).toEqual([]);
    expect(validateSkillEntry(entry({ resources: 'dynamic' }))).toEqual([]);
  });

  it('requires name and description', () => {
    expect(messages(entry({ frontmatter: { name: 'refunds' } }))).toContain(
      'frontmatter.description is missing'
    );
  });

  it('requires the final path segment to equal the name', () => {
    expect(
      messages(entry({ frontmatter: { name: 'returns', description: 'd' } }))
    ).toEqual([
      expect.stringContaining('must equal frontmatter.name "returns"'),
    ]);
  });

  it('flags missing SKILL.md, duplicates, stray files, digests, and sizes', () => {
    const problems = messages(
      entry({
        resources: [
          {
            uri: 'skill://acme/billing/refunds/a.md',
            digest: 'md5:x',
            size: -1,
          },
          { uri: 'skill://acme/billing/refunds/a.md', digest: DIGEST, size: 1 },
          { uri: 'skill://other/b.md', digest: DIGEST, size: 1 },
        ],
      })
    );
    expect(problems).toEqual(
      expect.arrayContaining([
        expect.stringContaining('digest "md5:x"'),
        expect.stringContaining('size -1'),
        expect.stringContaining('listed more than once'),
        expect.stringContaining('outside the skill directory'),
        expect.stringContaining("does not list the skill's own"),
      ])
    );
  });

  it('reports limits as should-level problems', () => {
    const big = entry({
      resources: [
        {
          uri: 'skill://acme/billing/refunds/SKILL.md',
          digest: DIGEST,
          size: 17 * 1024 * 1024,
        },
      ],
    });
    expect(validateSkillEntry(big)).toEqual([
      { severity: 'should', message: expect.stringContaining('byte limit') },
    ]);
  });
});

describe('parseSkillFrontmatter', () => {
  it('parses YAML frontmatter', () => {
    expect(
      parseSkillFrontmatter(
        "---\nname: refunds\ndescription: Do refunds\nmetadata:\n  version: '2'\n---\n# Body"
      )
    ).toEqual({
      name: 'refunds',
      description: 'Do refunds',
      metadata: { version: '2' },
    });
  });

  it('returns null without a frontmatter block', () => {
    expect(parseSkillFrontmatter('# No frontmatter')).toBeNull();
  });
});

describe('skillDigest / stableJson', () => {
  it('computes sha256 digests in SEP-2640 format', () => {
    expect(skillDigest(new TextEncoder().encode('abc'))).toBe(
      'sha256:ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'
    );
  });

  it('ignores key order', () => {
    expect(stableJson({ a: 1, b: { c: 2, d: 3 } })).toBe(
      stableJson({ b: { d: 3, c: 2 }, a: 1 })
    );
  });
});
