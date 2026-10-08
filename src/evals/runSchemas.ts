import { z } from 'zod';
import { RUN_SCHEMAS } from './runFormat.js';

/** Where the published run-format schemas live, by file kind. */
function runSchemaId(kind: keyof typeof RUN_SCHEMAS): string {
  return `https://unpkg.com/@gleanwork/mcp-server-tester/schema/run/v1/${kind}.schema.json`;
}

/** The JSON Schema of one run-format file kind, as `schema/run/v1/` publishes it. */
export function runJsonSchema(
  kind: keyof typeof RUN_SCHEMAS
): Record<string, unknown> {
  return {
    $id: runSchemaId(kind),
    ...(z.toJSONSchema(RUN_SCHEMAS[kind], {
      target: 'draft-7',
      io: 'output',
    }) as Record<string, unknown>),
  };
}
