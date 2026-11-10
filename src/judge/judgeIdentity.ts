/**
 * A judge's identity: a hash of everything that decides its verdict besides
 * the trial it grades (ADR 0009). A calibration measures one identity, so
 * the identity must change whenever the judge could grade differently.
 */
import { createHash } from 'node:crypto';
import type { ZodType } from 'zod';
import { installedPlugin } from '../plugins/extensions.js';
import {
  BUILTIN_NAMESPACE,
  parseExtensionReference,
} from '../plugins/plugin.js';
import { settingsFor, type SettingsSections } from '../plugins/settings.js';

/** What a judge or pairwise judge definition contributes to its identity. */
interface IdentifiedJudge {
  readonly schema: ZodType;
  readonly version?: string;
}

/**
 * The SHA-256 of a value's JSON with its object keys sorted: the same for
 * the same content, whatever order its keys were written in.
 */
export function contentHash(value: unknown): string {
  return createHash('sha256')
    .update(JSON.stringify(sortKeys(value)))
    .digest('hex');
}

/** `value` with every object's keys in sorted order, for stable JSON. */
export function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((k) => [k, sortKeys((value as Record<string, unknown>)[k])])
    );
  return value;
}

/** Whether `reference` names a built-in judge, with or without `mst/judge/`. */
function isBuiltin(reference: string): boolean {
  const { namespace } = parseExtensionReference(reference);
  return namespace === undefined || namespace === BUILTIN_NAMESPACE;
}

/**
 * The version that stands for the judge in its identity: the one it
 * declares or, for a plugin judge that declares none, its plugin's package
 * version. Undefined when it has neither.
 */
function judgeVersion(
  reference: string,
  definition: IdentifiedJudge
): string | undefined {
  if (definition.version !== undefined || isBuiltin(reference))
    return definition.version;
  return installedPlugin(parseExtensionReference(reference).namespace!)?.meta
    .version;
}

/**
 * Whether MST can see the judge's version change: a built-in's, one the
 * judge declares, or its plugin's package version. Without one, the judge's
 * identity can stay the same while it grades differently, so a calibration
 * of it can't tell when it goes stale (ADR 0009: unversioned).
 */
export function judgeIsVersioned(
  reference: string,
  definition: IdentifiedJudge
): boolean {
  return (
    isBuiltin(reference) || judgeVersion(reference, definition) !== undefined
  );
}

/**
 * The judge's version and whether it is unversioned, as `mst judges` lists
 * them and `run.json` records them: the version a person reads, beside the
 * identity hash.
 */
export function judgeVersionFields(
  reference: string,
  definition: IdentifiedJudge
): { version?: string; unversioned?: true } {
  const version = judgeVersion(reference, definition);
  return {
    ...(version !== undefined ? { version } : {}),
    ...(judgeIsVersioned(reference, definition)
      ? {}
      : { unversioned: true as const }),
  };
}

/**
 * The identity of the judge `reference` names, run with `options` (before
 * its schema parses them). It covers:
 *
 * - the judge, with a built-in named the same with or without `mst/judge/`;
 * - its `version`, or, when it declares none, its plugin's package version;
 * - its options as its schema parses them, so a default counts the same as
 *   the value written out. Options the schema rejects are hashed as given;
 * - how MST turns its answers into a verdict (`policy`): a pointwise judge's
 *   pass threshold and repetitions, a pairwise judge's repetitions;
 * - its plugin's settings (ADR 0008), from the eval's `settings`, which a
 *   judge receives and can grade by (a model, a project). Only when there
 *   are some, so a judge whose plugin has none keeps the identity it had.
 */
export function judgeIdentity(
  reference: string,
  definition: IdentifiedJudge,
  options: Record<string, unknown>,
  policy: JudgeVerdictPolicy,
  settings: SettingsSections | undefined
): string {
  const parsed = parseExtensionReference(reference);
  const builtin = isBuiltin(reference);
  const plugin =
    definition.version !== undefined
      ? undefined
      : judgeVersion(reference, definition);
  const result = definition.schema.safeParse(options);
  const pluginSettings = settingsFor(settings, reference);
  return contentHash({
    judge: builtin ? parsed.name : reference,
    version: definition.version ?? null,
    pluginVersion: plugin ?? null,
    options: result.success ? result.data : options,
    policy,
    ...(pluginSettings && Object.keys(pluginSettings).length
      ? { settings: pluginSettings }
      : {}),
  });
}

/**
 * What decides a verdict outside the judge: the score a pointwise judge's
 * answer must reach to pass, and how many times a judge runs per verdict.
 */
export interface JudgeVerdictPolicy {
  threshold?: number;
  reps: number;
}
