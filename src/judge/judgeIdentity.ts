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

/**
 * The identity of the judge `reference` names, run with `options` (before
 * its schema parses them). It covers:
 *
 * - the judge, with a built-in named the same with or without `mst/judge/`;
 * - its `version`, or, when it declares none, its plugin's package version;
 * - its options as its schema parses them, so a default counts the same as
 *   the value written out. Options the schema rejects are hashed as given.
 */
export function judgeIdentity(
  reference: string,
  definition: IdentifiedJudge,
  options: Record<string, unknown>
): string {
  const parsed = parseExtensionReference(reference);
  const builtin =
    parsed.namespace === undefined || parsed.namespace === BUILTIN_NAMESPACE;
  const plugin =
    builtin || definition.version !== undefined
      ? undefined
      : installedPlugin(parsed.namespace!)?.meta.version;
  const result = definition.schema.safeParse(options);
  return contentHash({
    judge: builtin ? parsed.name : reference,
    version: definition.version ?? null,
    pluginVersion: plugin ?? null,
    options: result.success ? result.data : options,
  });
}
