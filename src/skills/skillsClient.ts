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

/** Everything one `skills/list` walk returned. */
export interface SkillsListing {
  /** Entries that parsed as skill entries. */
  skills: SkillEntry[];
  /** Raw entries that did not parse (missing uri, frontmatter, or resources). */
  invalid: unknown[];
  /** True when the walk stopped at `maxPages` with more pages available. */
  truncated: boolean;
}

/**
 * Calls `skills/list`, following `nextCursor` up to `maxPages` pages, and
 * keeps going past malformed entries so callers can report them.
 */
export async function listSkillsDetailed(
  client: Client,
  options: { maxPages?: number } = {}
): Promise<SkillsListing> {
  const maxPages = options.maxPages ?? DEFAULT_MAX_PAGES;
  const listing: SkillsListing = { skills: [], invalid: [], truncated: false };
  let cursor: string | undefined;
  for (let page = 0; page < maxPages; page++) {
    const result = await client.request(
      {
        method: 'skills/list',
        params: cursor ? { cursor } : {},
      },
      SkillsListResultSchema
    );
    for (const raw of result.skills) {
      const parsed = SkillEntrySchema.safeParse(raw);
      if (parsed.success) listing.skills.push(parsed.data);
      else listing.invalid.push(raw);
    }
    cursor = result.nextCursor;
    if (!cursor) return listing;
  }
  listing.truncated = true;
  return listing;
}

/**
 * Calls `skills/list` (paginated). Throws when an entry is malformed or the
 * listing has more than `maxPages` pages; use {@link listSkillsDetailed} to
 * inspect those cases instead.
 */
export async function listSkills(
  client: Client,
  options: { maxPages?: number } = {}
): Promise<SkillEntry[]> {
  const listing = await listSkillsDetailed(client, options);
  if (listing.invalid.length > 0) {
    throw new Error(
      `skills/list returned ${listing.invalid.length} malformed entr${listing.invalid.length === 1 ? 'y' : 'ies'}`
    );
  }
  if (listing.truncated) {
    throw new Error(
      `skills/list has more than ${options.maxPages ?? DEFAULT_MAX_PAGES} pages; pass a larger maxPages`
    );
  }
  return listing.skills;
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

/**
 * Calls `resources/directory/read` (only if the server declares it),
 * following `nextCursor` up to `maxPages` pages.
 */
export async function readSkillDirectory(
  client: Client,
  uri: string,
  options: { maxPages?: number } = {}
): Promise<{
  resources: Array<{ uri: string; name?: string; mimeType?: string }>;
}> {
  const maxPages = options.maxPages ?? DEFAULT_MAX_PAGES;
  const resources: Array<{ uri: string; name?: string; mimeType?: string }> =
    [];
  let cursor: string | undefined;
  for (let page = 0; page < maxPages; page++) {
    const result = await client.request(
      {
        method: 'resources/directory/read',
        params: cursor ? { uri, cursor } : { uri },
      },
      DirectoryReadResultSchema
    );
    resources.push(...result.resources);
    cursor = result.nextCursor;
    if (!cursor) return { resources };
  }
  throw new Error(
    `resources/directory/read ${uri} has more than ${maxPages} pages`
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
  // Prefer the requested URI; otherwise report what the server returned,
  // so verification compares the right bytes.
  const content =
    result.contents.find((item) => item.uri === uri) ?? result.contents[0];
  if (!content) throw new Error(`resources/read ${uri} returned no contents`);
  const returnedUri = content.uri || uri;
  if ('text' in content && typeof content.text === 'string') {
    return {
      uri: returnedUri,
      ...(content.mimeType ? { mimeType: content.mimeType } : {}),
      bytes: new TextEncoder().encode(content.text),
      text: content.text,
    };
  }
  if ('blob' in content && typeof content.blob === 'string') {
    return {
      uri: returnedUri,
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
    // A SKILL.md may be served as text or as a blob; both are UTF-8 bytes.
    const frontmatter = parseSkillFrontmatter(
      file.text ?? new TextDecoder().decode(file.bytes)
    );
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
