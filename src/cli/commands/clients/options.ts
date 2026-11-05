/** Client option defaults for the CLI and generated docs, from the options schema. */
import type { ZodType } from 'zod';
import { optionsSchema } from '../discoveryPlugins.js';

interface OptionSchema {
  default?: unknown;
  'x-defaultDescription'?: string;
  not?: Record<string, unknown>;
  [key: string]: unknown;
}

interface ClientOptionsSchema {
  properties?: Record<string, OptionSchema | boolean>;
  required?: string[];
  unavailable?: string;
  [key: string]: unknown;
}

function removed(option: OptionSchema | boolean): boolean {
  return (
    option === false ||
    (typeof option === 'object' &&
      option.not !== undefined &&
      Object.keys(option.not).length === 0)
  );
}

/**
 * JSON Schema defaults describe omission; they never parse or fill in options.
 * A runtime-dependent default is described by `x-defaultDescription`, rather
 * than evaluated on the coordinator. A plugin with no declaration stays unknown.
 */
export function clientOptionsSchema(schema: ZodType): ClientOptionsSchema {
  const options = optionsSchema(schema, 'client') as ClientOptionsSchema;
  if (!options.properties) return options;
  return {
    ...options,
    properties: Object.fromEntries(
      Object.entries(options.properties).map(([name, option]) => {
        if (name === 'type' || removed(option)) return [name, option];
        const field = typeof option === 'boolean' ? {} : option;
        return [
          name,
          Object.hasOwn(field, 'default') ||
          field['x-defaultDescription'] !== undefined
            ? field
            : {
                ...field,
                'x-defaultDescription': options.required?.includes(name)
                  ? 'required'
                  : 'not declared',
              },
        ];
      })
    ),
  };
}

/** Every usable option, with the same default in text output and the docs. */
export function clientOptionRows(options: ClientOptionsSchema): string[][] {
  return Object.entries(options.properties ?? {}).flatMap(([name, option]) => {
    if (name === 'type' || removed(option) || typeof option === 'boolean')
      return [];
    const value = Object.hasOwn(option, 'default')
      ? JSON.stringify(option.default)
      : (option['x-defaultDescription'] ?? 'not declared');
    return [[name, value]];
  });
}
