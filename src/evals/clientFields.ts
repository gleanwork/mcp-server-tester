import { z } from 'zod';
import type { TaggedConfig } from './evalConfig.js';

/** The client a run uses when nothing names one. */
export const DEFAULT_CLIENT = 'claude-code';

/** A client's own options: what the named client takes beyond its model. */
export type ClientOptions = Record<string, unknown>;

/**
 * How an eval config, variant or case names the client under test: the client, the
 * model it uses, and the client's own options.
 */
export interface ClientFields {
  /**
   * The client under test: `mst`, `claude-code`, `cowork`, `chatgpt`, or a
   * plugin's `namespace/name`.
   */
  client?: string;
  /** The model the client uses. */
  model?: string;
  /** The client's own options, such as Cowork's `appVersion`. */
  clientOptions?: ClientOptions;
}

const OWN_FIELDS: Record<string, string> = {
  type: 'Name the client with `client`, not `clientOptions.type`.',
  client: 'Name the client with `client`, not `clientOptions.client`.',
  model: 'Set the model with `model`, not `clientOptions.model`.',
};

/** Zod fields for `client`, `model` and `clientOptions`, and the old `host`. */
export const clientFieldSchemas = {
  client: z.string().min(1).optional(),
  model: z.string().optional(),
  clientOptions: z
    .record(z.string(), z.unknown())
    .superRefine((options, context) => {
      for (const [key, message] of Object.entries(OWN_FIELDS)) {
        if (key in options)
          context.addIssue({ code: 'custom', path: [key], message });
      }
    })
    .optional(),
  host: z
    .never({
      message:
        '`host` is now `client` (the client’s name), `model` and `clientOptions` (its other options)',
    })
    .optional(),
};

/**
 * The client an eval config declares, as the name and options MST resolves.
 * The eval config's `model` is a default every client may take, so it isn't
 * part of the declaration. Undefined when the eval config names no client.
 */
export function clientOf(
  level: Pick<ClientFields, 'client' | 'clientOptions'> | undefined
): TaggedConfig | undefined {
  if (level?.client === undefined && level?.clientOptions === undefined)
    return undefined;
  return { ...level.clientOptions, type: level.client ?? DEFAULT_CLIENT };
}

/**
 * A variant's or case's change to the client it inherits: a different client,
 * model or options. Options of a different client than the inherited one
 * don't carry over (see `inheritClient`).
 */
export function clientPatchOf(
  level: ClientFields | undefined
): Partial<TaggedConfig> | undefined {
  if (
    level?.client === undefined &&
    level?.model === undefined &&
    level?.clientOptions === undefined
  )
    return undefined;
  return {
    ...level.clientOptions,
    ...(level.model !== undefined ? { model: level.model } : {}),
    ...(level.client !== undefined ? { type: level.client } : {}),
  };
}

/** A resolved client declaration as the fields that declare it. */
export function clientFieldsOf(declaration: TaggedConfig): ClientFields {
  const { type, model, ...options } = declaration;
  return {
    client: type,
    ...(typeof model === 'string' ? { model } : {}),
    ...(Object.keys(options).length > 0 ? { clientOptions: options } : {}),
  };
}
