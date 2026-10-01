import { z } from 'zod';

/**
 * Types and schemas for the MCP skills extension
 * (`io.modelcontextprotocol/skills`, SEP-2640).
 *
 * The TypeScript SDK does not ship skills types yet, so MST defines the wire
 * shapes here. Schemas are deliberately loose (unknown fields pass through):
 * they parse what a server sent; {@link validateSkillEntry} reports what is
 * wrong with it.
 */

/** Extension identifier servers declare in `capabilities.extensions`. */
export const SKILLS_EXTENSION_ID = 'io.modelcontextprotocol/skills';

/** Per-skill limits every conforming host must support (SEP-2640 §Limits). */
export const SKILL_LIMITS = {
  maxResources: 512,
  maxTotalBytes: 16 * 1024 * 1024,
} as const;

/** One file of a skill, as listed in its entry. */
const SkillResourceEntrySchema = z.looseObject({
  uri: z.string(),
  digest: z.string(),
  size: z.number(),
});
export type SkillResourceEntry = z.infer<typeof SkillResourceEntrySchema>;

/** A `skills/list` / `skills/get` entry. */
export const SkillEntrySchema = z.looseObject({
  uri: z.string(),
  frontmatter: z.record(z.string(), z.unknown()),
  resources: z.union([z.array(SkillResourceEntrySchema), z.literal('dynamic')]),
});
export type SkillEntry = z.infer<typeof SkillEntrySchema>;

/** `skills/list` result. */
export const SkillsListResultSchema = z.looseObject({
  skills: z.array(z.unknown()),
  nextCursor: z.string().optional(),
});

/** `skills/get` result. */
export const SkillsGetResultSchema = z.looseObject({
  skill: z.unknown(),
});

/** `resources/directory/read` result. */
export const DirectoryReadResultSchema = z.looseObject({
  resources: z.array(
    z.looseObject({
      uri: z.string(),
      name: z.string().optional(),
      mimeType: z.string().optional(),
    })
  ),
  nextCursor: z.string().optional(),
});

/** Settings a server declares for the skills extension. */
export interface SkillsExtensionSettings {
  /** The server implements `resources/directory/read`. */
  directoryRead?: boolean;
}
