import { createHash } from 'node:crypto';
import { parse as parseYaml } from 'yaml';
import { SKILL_LIMITS, type SkillEntry } from './skillsTypes.js';

/**
 * Pure helpers for SEP-2640 skill entries: validation, digests, and
 * frontmatter parsing.
 */

const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/;
const SKILL_MD_SUFFIX = '/SKILL.md';

/** A problem found in a skill entry. */
export interface SkillEntryProblem {
  severity: 'must' | 'should';
  message: string;
}

/** `sha256:<hex>` of raw bytes, the digest format SEP-2640 uses. */
export function skillDigest(bytes: Uint8Array): string {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

/**
 * The skill's root directory URI (`skill://<skill-path>`), or null when the
 * URI does not end in `/SKILL.md`.
 */
export function skillRootUri(skillMdUri: string): string | null {
  return skillMdUri.endsWith(SKILL_MD_SUFFIX)
    ? skillMdUri.slice(0, -SKILL_MD_SUFFIX.length)
    : null;
}

/** The skill name implied by the URI (final `<skill-path>` segment). */
export function skillNameFromUri(skillMdUri: string): string | null {
  const root = skillRootUri(skillMdUri);
  if (!root) return null;
  const segment = root.split('/').at(-1);
  return segment && !segment.includes(':') ? segment : null;
}

/**
 * Parses the YAML frontmatter at the top of a SKILL.md, or returns null when
 * the file does not start with a `---` block.
 */
export function parseSkillFrontmatter(
  markdown: string
): Record<string, unknown> | null {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(markdown);
  if (!match) return null;
  const parsed: unknown = parseYaml(match[1] ?? '');
  return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
    ? (parsed as Record<string, unknown>)
    : null;
}

/** Order-independent JSON for comparing frontmatter and entries. */
export function stableJson(value: unknown): string {
  return JSON.stringify(value, (_key, inner: unknown) =>
    inner && typeof inner === 'object' && !Array.isArray(inner)
      ? Object.fromEntries(
          Object.entries(inner as Record<string, unknown>).sort(([a], [b]) =>
            a.localeCompare(b)
          )
        )
      : inner
  );
}

/**
 * Validates one skill entry against SEP-2640's entry rules. Returns every
 * problem found; an empty list means the entry is valid.
 */
export function validateSkillEntry(entry: SkillEntry): SkillEntryProblem[] {
  const problems: SkillEntryProblem[] = [];
  const must = (message: string) =>
    problems.push({ severity: 'must', message });
  const should = (message: string) =>
    problems.push({ severity: 'should', message });

  const { name, description } = entry.frontmatter as {
    name?: unknown;
    description?: unknown;
  };
  if (typeof name !== 'string' || name.length === 0) {
    must('frontmatter.name is missing');
  }
  if (typeof description !== 'string' || description.length === 0) {
    must('frontmatter.description is missing');
  }

  const root = skillRootUri(entry.uri);
  if (!root) {
    must(`uri ${entry.uri} does not end in /SKILL.md`);
  } else if (typeof name === 'string' && skillNameFromUri(entry.uri) !== name) {
    must(
      `final skill-path segment of ${entry.uri} must equal frontmatter.name "${name}"`
    );
  }

  if (entry.resources === 'dynamic') return problems;

  const seen = new Set<string>();
  let total = 0;
  let listsSkillMd = false;
  for (const file of entry.resources) {
    if (seen.has(file.uri)) must(`${file.uri} is listed more than once`);
    seen.add(file.uri);
    if (file.uri === entry.uri) listsSkillMd = true;
    if (root && file.uri !== entry.uri && !file.uri.startsWith(`${root}/`)) {
      must(`${file.uri} is outside the skill directory ${root}`);
    }
    if (!DIGEST_PATTERN.test(file.digest)) {
      must(
        `${file.uri} digest "${file.digest}" is not sha256:<64 lowercase hex>`
      );
    }
    if (!Number.isInteger(file.size) || file.size < 0) {
      must(`${file.uri} size ${file.size} is not a non-negative integer`);
    } else {
      total += file.size;
    }
  }
  if (!listsSkillMd)
    must(`resources does not list the skill's own ${entry.uri}`);
  if (entry.resources.length > SKILL_LIMITS.maxResources) {
    should(
      `${entry.resources.length} resources exceeds the ${SKILL_LIMITS.maxResources}-file limit hosts must support`
    );
  }
  if (total > SKILL_LIMITS.maxTotalBytes) {
    should(
      `${total} bytes exceeds the ${SKILL_LIMITS.maxTotalBytes}-byte limit hosts must support`
    );
  }
  return problems;
}
