import type { Client, ReadResourceResult } from '@modelcontextprotocol/client';
import {
  DirectoryReadResultSchema,
  SKILLS_EXTENSION_ID,
  SkillEntrySchema,
  SkillsGetResultSchema,
  SkillsListResultSchema,
  type SkillEntry,
  type SkillsExtensionSettings,
} from './skillsTypes.js';
import {
  parseSkillFrontmatter,
  skillDigest,
  stableJson,
} from './skillEntry.js';

/** Default cap on `skills/list` pages. */
const DEFAULT_MAX_PAGES = 64;

/**
 * Returns the server's skills extension settings, or null when the server
 * does not declare `io.modelcontextprotocol/skills`.
 */
export function getSkillsExtension(
  client: Client
): SkillsExtensionSettings | null {
  const extensions = (
    client.getServerCapabilities() as
      | { extensions?: Record<string, unknown> }
      | undefined
  )?.extensions;
  const settings = extensions?.[SKILLS_EXTENSION_ID];
  return settings && typeof settings === 'object'
    ? (settings as SkillsExtensionSettings)
    : null;
}

/** Calls `skills/list`, following `nextCursor` up to `maxPages` pages. */
export async function listSkills(
  client: Client,
  options: { maxPages?: number } = {}
): Promise<SkillEntry[]> {
  const maxPages = options.maxPages ?? DEFAULT_MAX_PAGES;
  const skills: SkillEntry[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < maxPages; page++) {
    const result = await client.request(
      {
        method: 'skills/list',
        params: cursor ? { cursor } : {},
      },
      SkillsListResultSchema
    );
    for (const raw of result.skills) skills.push(SkillEntrySchema.parse(raw));
    cursor = result.nextCursor;
    if (!cursor) return skills;
  }
  throw new Error(`skills/list returned more than ${maxPages} pages`);
}

/** Calls `skills/get` for a skill's SKILL.md URI. */
export async function getSkill(
  client: Client,
  uri: string
): Promise<SkillEntry> {
  const result = await client.request(
    { method: 'skills/get', params: { uri } },
    SkillsGetResultSchema
  );
  return SkillEntrySchema.parse(result.skill);
}

/** Calls `resources/directory/read` (only if the server declares it). */
export async function readSkillDirectory(client: Client, uri: string) {
  return client.request(
    { method: 'resources/directory/read', params: { uri } },
    DirectoryReadResultSchema
  );
}

/** The raw bytes and text of a file read with `resources/read`. */
export interface SkillFileContent {
  uri: string;
  mimeType?: string;
  bytes: Uint8Array;
  /** Present for text contents. */
  text?: string;
}

/** Reads one file with `resources/read` and returns its raw bytes. */
export async function readSkillFile(
  client: Client,
  uri: string
): Promise<SkillFileContent> {
  const result: ReadResourceResult = await client.readResource({ uri });
  const content =
    result.contents.find((item) => item.uri === uri) ?? result.contents[0];
  if (!content) throw new Error(`resources/read ${uri} returned no contents`);
  if ('text' in content && typeof content.text === 'string') {
    return {
      uri,
      ...(content.mimeType ? { mimeType: content.mimeType } : {}),
      bytes: new TextEncoder().encode(content.text),
      text: content.text,
    };
  }
  if ('blob' in content && typeof content.blob === 'string') {
    return {
      uri,
      ...(content.mimeType ? { mimeType: content.mimeType } : {}),
      bytes: Uint8Array.from(Buffer.from(content.blob, 'base64')),
    };
  }
  throw new Error(`resources/read ${uri} returned neither text nor blob`);
}

/**
 * Checks a read file against the entry it was loaded from (SEP-2640
 * §Integrity and verification). Returns problems; empty means verified.
 * For a SKILL.md it also compares the parsed frontmatter with the entry's.
 */
export function verifySkillFile(
  entry: SkillEntry,
  file: SkillFileContent
): string[] {
  const problems: string[] = [];
  if (entry.resources !== 'dynamic') {
    const listed = entry.resources.find(
      (resource) => resource.uri === file.uri
    );
    if (!listed) {
      problems.push(`${file.uri} is not listed in the skill's resources`);
    } else {
      if (listed.size !== file.bytes.byteLength) {
        problems.push(
          `${file.uri} is ${file.bytes.byteLength} bytes; entry says ${listed.size}`
        );
      }
      const digest = skillDigest(file.bytes);
      if (listed.digest !== digest) {
        problems.push(
          `${file.uri} digest ${digest} does not match entry ${listed.digest}`
        );
      }
    }
  }
  if (file.uri === entry.uri) {
    const frontmatter =
      file.text !== undefined ? parseSkillFrontmatter(file.text) : null;
    if (!frontmatter) {
      problems.push(`${file.uri} does not start with YAML frontmatter`);
    } else if (stableJson(frontmatter) !== stableJson(entry.frontmatter)) {
      problems.push(
        `${file.uri} frontmatter ${stableJson(frontmatter)} differs from the entry's ${stableJson(entry.frontmatter)}`
      );
    }
  }
  return problems;
}
