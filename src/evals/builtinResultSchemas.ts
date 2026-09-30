import { z, type ZodType } from 'zod';
import { SkillEntrySchema } from '../skills/skillsTypes.js';
import { validateSkillEntry } from '../skills/skillEntry.js';

/**
 * Schemas datasets can reference by name in `expect.schema` without
 * registering them, for results of `request` cases. User-provided `schemas`
 * with the same name take precedence.
 */

/** A skill entry that satisfies SEP-2640's entry rules. */
const ValidSkillEntrySchema = SkillEntrySchema.superRefine((entry, context) => {
  for (const problem of validateSkillEntry(entry)) {
    if (problem.severity === 'must') {
      context.addIssue({ code: 'custom', message: problem.message });
    }
  }
});

export const BUILTIN_RESULT_SCHEMAS: Readonly<Record<string, ZodType>> = {
  /** A `skills/list` / `skills/get` entry (SEP-2640). */
  SkillEntry: ValidSkillEntrySchema,
  /** A `skills/list` result. */
  SkillsListResult: z.looseObject({
    skills: z.array(ValidSkillEntrySchema),
    nextCursor: z.string().optional(),
  }),
  /** A `skills/get` result. */
  SkillsGetResult: z.looseObject({ skill: ValidSkillEntrySchema }),
  /** A `server/discover` result (2026-07-28). */
  DiscoverResult: z.looseObject({
    supportedVersions: z.array(z.string()).min(1),
    capabilities: z.record(z.string(), z.unknown()),
  }),
};
