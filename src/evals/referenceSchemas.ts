import { z } from 'zod';
import { builtinShortName } from '../plugins/extensions.js';
import type { KindSegment } from '../plugins/plugin.js';

/**
 * An extension reference of `kind`, as a config or dataset writes it. A
 * built-in written in full (`mst/judge/rubric`) reads as its short name
 * (`rubric`); a plugin's `<namespace>/<kind>/<name>` is kept, and the
 * lookup checks it.
 */
export function referenceSchema(kind: KindSegment) {
  return z
    .string()
    .min(1)
    .transform((reference, context) => {
      try {
        return builtinShortName(reference, kind);
      } catch (error) {
        context.addIssue({ code: 'custom', message: (error as Error).message });
        return z.NEVER;
      }
    });
}

/** `{ "type": <reference>, ...options }` for an extension of `kind`. */
export function taggedReferenceSchema(kind: KindSegment) {
  return z.object({ type: referenceSchema(kind) }).passthrough();
}

/** A bare reference or a tagged object, for an extension of `kind`. */
export function extensionReferenceSchema(kind: KindSegment) {
  return z.union([referenceSchema(kind), taggedReferenceSchema(kind)]);
}
