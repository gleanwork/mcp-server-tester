/**
 * Where MST's JSON Schemas are published: the package's `schema/` directory
 * on unpkg, at the newest 2.x release. Every schema's `$id` is this base and
 * its path under `schema/`, so a 2.x release can add fields without
 * changing an ID; a breaking change moves the file to a new `v<n>/` path.
 */
export const SCHEMA_BASE =
  'https://unpkg.com/@gleanwork/mcp-server-tester@2/schema/';

/** The `$id` of the schema at `path` under `schema/`. */
export function schemaId(path: string): string {
  return `${SCHEMA_BASE}${path}`;
}
