/**
 * The options an extension takes (a client, a judge), from its options
 * schema: their defaults for the CLI and the generated docs, and the table
 * `mst clients show` and `mst judges show` print.
 */
import type { ZodType } from 'zod';
import { formatTable, optionsSchema } from './discoveryPlugins.js';

interface OptionSchema {
  default?: unknown;
  'x-defaultDescription'?: string;
  not?: Record<string, unknown>;
  enum?: unknown[];
  const?: unknown;
  type?: string | string[];
  anyOf?: Array<OptionSchema | boolean>;
  [key: string]: unknown;
}

export interface ExtensionOptionsSchema {
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
 * than evaluated on the coordinator. An option with neither is `not declared`,
 * so an extension with no declaration stays unknown.
 */
export function extensionOptionsSchema(
  schema: ZodType,
  kind: string
): ExtensionOptionsSchema {
  const options = optionsSchema(schema, kind) as ExtensionOptionsSchema;
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

/** The usable options' rows, with their accepted values. */
function usableOptions(
  options: ExtensionOptionsSchema
): Array<[name: string, value: string, accepts: string | undefined]> {
  return Object.entries(options.properties ?? {}).flatMap(([name, option]) => {
    if (name === 'type' || removed(option) || typeof option === 'boolean')
      return [];
    const value = Object.hasOwn(option, 'default')
      ? JSON.stringify(option.default)
      : (option['x-defaultDescription'] ?? 'not declared');
    return [[name, value, acceptedValues(option)]];
  });
}

/** Every usable option, with the same default in text output and the docs. */
export function optionRows(options: ExtensionOptionsSchema): string[][] {
  return usableOptions(options).map(([name, value]) => [name, value]);
}

/** One branch of a choice, as a person reads it: a value or its kind. */
function choiceText(option: OptionSchema | boolean): string[] {
  if (typeof option === 'boolean') return [];
  if (option.enum) return option.enum.map(String);
  if (Object.hasOwn(option, 'const')) return [String(option.const)];
  const type = Array.isArray(option.type) ? option.type[0] : option.type;
  if (type === undefined) return [];
  return [type === 'object' || type === 'array' ? `an ${type}` : `a ${type}`];
}

/**
 * The values an option accepts, when its schema names them: an enum, or a
 * choice with at least one named value (`correctness, ..., or an object`).
 */
function acceptedValues(option: OptionSchema): string | undefined {
  if (option.enum) return option.enum.map(String).join(', ');
  const branches = option.anyOf;
  if (
    !branches?.some(
      (branch) =>
        typeof branch === 'object' &&
        (branch.enum !== undefined || Object.hasOwn(branch, 'const'))
    )
  )
    return undefined;
  const values = branches.flatMap(choiceText);
  return values.length > 1
    ? `${values.slice(0, -1).join(', ')}, or ${values.at(-1)}`
    : values[0];
}

/**
 * The `Options` section of `show`: each option, its default and the values
 * it takes, in a table that wraps to `width`. A schema that isn't one flat
 * object, such as a union, is printed as JSON Schema.
 */
export function optionsSection(
  options: ExtensionOptionsSchema,
  kind: string,
  width: number
): string[] {
  const rows = usableOptions(options);
  if (!rows.length) {
    const body =
      options.unavailable ??
      (options.properties
        ? 'none declared'
        : `This ${kind}'s options take more than one shape. Its JSON Schema:\n${JSON.stringify(options, null, 2)}`);
    return ['', 'Options', ...body.split('\n').map((line) => `  ${line}`)];
  }
  const table = formatTable(
    [
      ['Option', 'Default'],
      ...rows.map(([name, value, accepts]) => [
        name,
        accepts === undefined ? value : `${value}\none of: ${accepts}`,
      ]),
    ],
    width - 2
  );
  const timed = rows.some(([name]) => name === 'timeout');
  return [
    '',
    timed ? 'Options (timeout in ms)' : 'Options',
    ...table.split('\n').map((line) => `  ${line}`),
  ];
}
