import type {
  ToolMetadataOverride,
  ToolOverrideVariant,
} from './evalRunner.js';
import { buildToolSurface } from './toolSurface.js';
import type { ListedServerTools } from './toolSurface.js';

/** What a candidate's id may look like: it names a variant and a directory. */
const CANDIDATE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/** The fields of a tool a candidate may replace. */
const OVERRIDE_FIELDS = new Set(['name', 'description', 'inputSchema']);

/** Keys of a JSON Schema object whose values are schemas. */
const SCHEMA_VALUED = new Set([
  'items',
  'additionalProperties',
  'additionalItems',
  'unevaluatedProperties',
  'unevaluatedItems',
  'propertyNames',
  'contains',
  'not',
  'if',
  'then',
  'else',
]);
/** Keys whose values are maps of name to schema. */
const SCHEMA_MAPS = new Set([
  'properties',
  'patternProperties',
  '$defs',
  'definitions',
  'dependentSchemas',
]);
/** Keys whose values are lists of schemas. */
const SCHEMA_LISTS = new Set(['allOf', 'anyOf', 'oneOf', 'prefixItems']);

/** Annotation keys that only describe a schema: a candidate may rewrite them. */
const TEXT_KEYS = new Set(['description', 'title']);

/**
 * A JSON Schema with its `description` and `title` text removed at every
 * level, and nothing else: what calls must keep. A parameter that happens to
 * be called `description` stays, because it is a key of `properties`.
 */
export function schemaStructure(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(schemaStructure);
  if (schema === null || typeof schema !== 'object') return schema;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(
    schema as Record<string, unknown>
  )) {
    if (TEXT_KEYS.has(key) && typeof value === 'string') continue;
    if (SCHEMA_MAPS.has(key) && value && typeof value === 'object') {
      out[key] = Object.fromEntries(
        Object.entries(value as Record<string, unknown>).map(([name, sub]) => [
          name,
          schemaStructure(sub),
        ])
      );
    } else if (SCHEMA_LISTS.has(key) && Array.isArray(value)) {
      out[key] = value.map(schemaStructure);
    } else if (SCHEMA_VALUED.has(key)) {
      out[key] = schemaStructure(value);
    } else {
      out[key] = value;
    }
  }
  return out;
}

/** JSON-equal, with object keys in any order. */
function sameJson(a: unknown, b: unknown): boolean {
  return canonical(a) === canonical(b);
}

function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) =>
    item && typeof item === 'object' && !Array.isArray(item)
      ? Object.fromEntries(
          Object.entries(item).sort(([a], [b]) => a.localeCompare(b))
        )
      : item
  );
}

/** Where a candidate's tool keys may point, and what it must not repeat. */
export interface CandidateRules {
  /** The tools the servers serve, before any variant. */
  servedTools: readonly ListedServerTools[];
  /**
   * The tools candidates may change: names on their servers, or
   * `server.tool`. Undefined: every served tool.
   */
  editableTools?: readonly string[];
  /** Ids that are taken: earlier candidates' and the base variant's name. */
  takenIds: ReadonlySet<string>;
}

/** Candidates as checked: the ones that may run, and what is wrong with the rest. */
export interface CheckedCandidates {
  variants: ToolOverrideVariant[];
  /** One line per problem, naming the candidate and the tool. */
  problems: string[];
}

/**
 * Checks candidate tool metadata before it runs. A candidate may change only
 * editable tools, and only their name, their description, and the
 * `description` and `title` text inside their input schema: the server
 * receives every call under the original name and schema, so a change to a
 * parameter, a type, an enum or `required` would measure rejected calls
 * instead of the metadata. Renames follow the tool-surface rules.
 */
export function checkCandidates(
  input: unknown,
  rules: CandidateRules
): CheckedCandidates {
  const problems: string[] = [];
  const variants: ToolOverrideVariant[] = [];
  if (!Array.isArray(input)) {
    return {
      variants,
      problems: [
        'Candidates must be a JSON array of variants: [{ "id": ..., "description": ..., "tools": { "<tool>": { "description": ... } } }].',
      ],
    };
  }
  const seen = new Set<string>();
  for (const [index, raw] of input.entries()) {
    const label = `Candidate ${index + 1}`;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      problems.push(`${label} is not an object.`);
      continue;
    }
    const candidate = raw as Record<string, unknown>;
    const id = candidate.id;
    if (typeof id !== 'string' || !CANDIDATE_ID.test(id)) {
      problems.push(
        `${label}'s id must be 1-64 letters, digits, ".", "_" or "-", starting with a letter or digit; got ${JSON.stringify(id)}.`
      );
      continue;
    }
    const name = `Candidate "${id}"`;
    const before = problems.length;
    if (rules.takenIds.has(id) || seen.has(id))
      problems.push(
        `${name}: the id is taken (by an earlier candidate or the base variant). Give each candidate a new id.`
      );
    seen.add(id);
    for (const key of Object.keys(candidate))
      if (!['id', 'description', 'tools'].includes(key))
        problems.push(
          `${name}: unknown field "${key}" (a candidate has id, description and tools).`
        );
    if (
      candidate.description !== undefined &&
      typeof candidate.description !== 'string'
    )
      problems.push(`${name}: description must be a string.`);
    const tools = candidate.tools;
    if (
      !tools ||
      typeof tools !== 'object' ||
      Array.isArray(tools) ||
      Object.keys(tools).length === 0
    ) {
      problems.push(
        `${name}: tools must map at least one tool to its metadata.`
      );
      continue;
    }
    const overrides = tools as Record<string, unknown>;
    for (const [key, override] of Object.entries(overrides))
      problems.push(
        ...checkOverride(name, key, override, rules, Object.keys(overrides))
      );
    if (problems.length > before) continue;
    const variant: ToolOverrideVariant = {
      id,
      ...(typeof candidate.description === 'string'
        ? { description: candidate.description }
        : {}),
      tools: overrides as Record<string, ToolMetadataOverride>,
    };
    // Keys that match no tool or several, invalid renames and collisions.
    try {
      buildToolSurface(rules.servedTools, variant);
    } catch (error) {
      problems.push(
        `${name}: ${error instanceof Error ? error.message : String(error)}`
      );
      continue;
    }
    variants.push(variant);
  }
  return { variants, problems };
}

function checkOverride(
  name: string,
  key: string,
  override: unknown,
  rules: CandidateRules,
  keys: readonly string[]
): string[] {
  const where = `${name}, tool "${key}"`;
  if (!override || typeof override !== 'object' || Array.isArray(override))
    return [`${where}: the metadata must be an object.`];
  const fields = override as Record<string, unknown>;
  const problems: string[] = [];
  for (const field of Object.keys(fields))
    if (!OVERRIDE_FIELDS.has(field))
      problems.push(
        `${where}: "${field}" can't change (only name, description and inputSchema text can).`
      );
  for (const field of ['name', 'description'] as const)
    if (
      fields[field] !== undefined &&
      (typeof fields[field] !== 'string' || fields[field] === '')
    )
      problems.push(`${where}: ${field} must be a non-empty string.`);
  const served = servedTool(key, rules.servedTools, keys);
  if (!served) return problems; // buildToolSurface names the key.
  if (rules.editableTools && !isEditable(served, rules.editableTools))
    problems.push(
      `${where}: the optimization can't change this tool. Editable tools: ${rules.editableTools.join(', ')}.`
    );
  if (fields.inputSchema !== undefined) {
    if (
      !fields.inputSchema ||
      typeof fields.inputSchema !== 'object' ||
      Array.isArray(fields.inputSchema)
    )
      problems.push(`${where}: inputSchema must be an object.`);
    else if (
      !sameJson(
        schemaStructure(fields.inputSchema),
        schemaStructure(served.tool.inputSchema)
      )
    )
      problems.push(
        `${where}: inputSchema changes more than description and title text. Keep its parameters, types, enums, required list and structure as the server serves them.`
      );
  }
  return problems;
}

/**
 * The served tool a key names (a bare name, or `server.tool`), when exactly
 * one. As buildToolSurface resolves it: a bare key skips a tool that another
 * of the candidate's `keys` names by its qualified key.
 */
export function servedTool(
  key: string,
  listed: readonly ListedServerTools[],
  keys: readonly string[] = []
): { server?: string; tool: ListedServerTools['tools'][number] } | undefined {
  const entries = listed.flatMap(({ server, tools }) =>
    tools.map((tool) => ({ server, tool }))
  );
  const qualified = entries.filter(
    ({ server, tool }) =>
      server !== undefined && `${server}.${tool.name}` === key
  );
  if (qualified.length === 1) return qualified[0];
  const bare = entries.filter(
    ({ server, tool }) =>
      tool.name === key &&
      (server === undefined || !keys.includes(`${server}.${tool.name}`))
  );
  return bare.length === 1 ? bare[0] : undefined;
}

function isEditable(
  served: { server?: string; tool: { name: string } },
  editable: readonly string[]
): boolean {
  return editable.some(
    (entry) =>
      entry === served.tool.name ||
      (served.server !== undefined &&
        entry === `${served.server}.${served.tool.name}`)
  );
}

/**
 * Checks that every editable tool names exactly one served tool, so a typo
 * fails when the optimization starts rather than when a candidate runs.
 */
export function checkEditableTools(
  editable: readonly string[],
  listed: readonly ListedServerTools[]
): void {
  const missing = editable.filter((key) => !servedTool(key, listed));
  if (missing.length === 0) return;
  const names = listed.flatMap(({ server, tools }) =>
    tools.map((tool) =>
      listed.length > 1 && server ? `${server}.${tool.name}` : tool.name
    )
  );
  throw new Error(
    `No single served tool is called ${missing.map((key) => `"${key}"`).join(', ')}. The servers serve: ${names.join(', ') || '(no tools)'}.`
  );
}
