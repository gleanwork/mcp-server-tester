/**
 * Configured default models, written into judge options (ADR 0015).
 *
 * A judge whose options name no `model` runs on its own built-in default,
 * which its version covers. When `models` in `mst.config.json` or the eval
 * config names one for it, MST writes that model into the options before the
 * judge's identity is computed, so the identity, `run.json` and every score
 * record the model that graded. Judges say which entry of `models` applies
 * to them with `modelSlot`; a judge without it keeps its own defaults.
 */
import {
  builtinModel,
  configuredModel,
  type JudgeModelSlot,
  type ModelDefaults,
} from '../llm/modelDefaults.js';

/** The part of a judge or pairwise judge definition the defaults need. */
interface ModelDefaulted {
  readonly modelSlot?: (
    options: Record<string, unknown>
  ) => JudgeModelSlot | undefined;
}

function isOptions(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * The configured model to write into `options`, or undefined when they name
 * one, nothing is configured for them, or the judge takes no defaults.
 */
export function configuredJudgeModel(
  definition: ModelDefaulted,
  options: Record<string, unknown>,
  models: ModelDefaults | undefined
): string | undefined {
  if (!models || options.model !== undefined || !definition.modelSlot)
    return undefined;
  const slot = definition.modelSlot(options);
  return slot ? configuredModel(slot, models) : undefined;
}

/**
 * The slot of the built-in model a judge runs on, given options with any
 * configured model already written in: its options name no model, and MST
 * has a built-in one for its slot. Undefined otherwise.
 */
export function builtinJudgeSlot(
  definition: ModelDefaulted,
  options: Record<string, unknown>
): JudgeModelSlot | undefined {
  if (options.model !== undefined || !definition.modelSlot) return undefined;
  const slot = definition.modelSlot(options);
  return slot && builtinModel(slot) !== undefined ? slot : undefined;
}

/**
 * A jury's members' options: the judge's `options` with each member's over
 * them. Undefined when `jury` isn't a list.
 */
function juryMemberOptions(
  options: Record<string, unknown>,
  jury: unknown
): Array<Record<string, unknown> | undefined> | undefined {
  if (!Array.isArray(jury)) return undefined;
  return jury.map((member: unknown) =>
    isOptions(member) ? { ...options, ...member } : undefined
  );
}

/**
 * A jury's members with the configured model written into each member whose
 * options (the judge's `options` with the member's over them) name none.
 * Each member gets its own, as members may name different providers.
 * Undefined when no member changes, or `jury` isn't a list.
 */
export function juryWithConfiguredModels(
  definition: ModelDefaulted,
  options: Record<string, unknown>,
  jury: unknown,
  models: ModelDefaults | undefined
): unknown[] | undefined {
  const members = juryMemberOptions(options, jury);
  if (!models || !members) return undefined;
  let changed = false;
  const written = (jury as unknown[]).map((member: unknown, index) => {
    const merged = members[index];
    if (!merged) return member;
    const model = configuredJudgeModel(definition, merged, models);
    if (model === undefined) return member;
    changed = true;
    return { ...(member as Record<string, unknown>), model };
  });
  return changed ? written : undefined;
}

/** The slots of the built-in models a jury's members run on. */
export function juryBuiltinSlots(
  definition: ModelDefaulted,
  options: Record<string, unknown>,
  jury: unknown
): JudgeModelSlot[] {
  return (juryMemberOptions(options, jury) ?? []).flatMap((merged) => {
    const slot = merged ? builtinJudgeSlot(definition, merged) : undefined;
    return slot ? [slot] : [];
  });
}
