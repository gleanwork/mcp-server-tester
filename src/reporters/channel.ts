/**
 * The reporter channel: the contract between code that records results on a
 * Playwright test (fixtures, conformance, the eval runner) and the MCP
 * reporter that reads them back.
 *
 * Attachment names, payload types and read-side schemas live here, so a
 * shape change fails to compile on the writing side and fails validation,
 * not silently, on the reading side.
 */
import { z } from 'zod';
import type { TestInfo } from '@playwright/test';
import type { AuthType, MCPProtocolInfo } from '../types/index.js';
import type {
  EvalCaseResult,
  MCPConformanceCheck,
  MCPVariantExperimentData,
} from '../types/reporter.js';

/** Attachment names the reporter reads. Tool calls append the tool name. */
export const REPORTER_ATTACHMENT_NAMES = {
  evalResults: 'mcp-test-results',
  variantExperiment: 'mcp-variant-experiment',
  conformance: 'mcp-conformance-checks',
  listTools: 'mcp-list-tools',
  toolCall: 'mcp-call-',
} as const;

const JSON_CONTENT_TYPE = 'application/json';

/** Case results from runEvalDataset() or a variant experiment's surfaced run. */
export interface EvalResultsPayload {
  caseResults: EvalCaseResult[];
}

/** Results from runConformanceChecks() or runCrossEraChecks(). */
export interface ConformancePayload {
  operation: 'conformanceChecks' | 'crossEraChecks';
  pass: boolean;
  checks: MCPConformanceCheck[];
  toolCount: number;
  serverInfo?: { name?: string; version?: string };
  capabilities?: unknown;
  protocol?: MCPProtocolInfo;
  /** Groups checks in the report, e.g. "Cross-era: legacy ↔ 2026-07-28". */
  scope?: string;
  connections?: unknown[];
  authType?: AuthType;
  project?: string;
}

/** A fixture listTools() call. */
export interface ListToolsPayload {
  operation: 'listTools';
  toolCount: number;
  tools: Array<{ name: string; description?: string }>;
}

/** A fixture callTool() call, auto-tracked for tests without eval results. */
export interface ToolCallPayload {
  operation: 'callTool';
  toolName: string;
  args: Record<string, unknown>;
  result: unknown;
  durationMs: number;
  isError: boolean;
  authType?: AuthType;
  project?: string;
}

/** Everything that travels over the channel, discriminated by `kind`. */
export type ReporterAttachment =
  | { kind: 'evalResults'; data: EvalResultsPayload }
  | { kind: 'variantExperiment'; data: MCPVariantExperimentData }
  | { kind: 'conformance'; data: ConformancePayload }
  | { kind: 'listTools'; data: ListToolsPayload }
  | { kind: 'toolCall'; data: ToolCallPayload };

type Kind = ReporterAttachment['kind'];

/**
 * Read-side schemas: the fields the reporter relies on. Payloads stay open
 * (`looseObject`) so producers can add fields without breaking readers.
 */
const PAYLOAD_SCHEMAS: Record<Kind, z.ZodType> = {
  evalResults: z.looseObject({
    caseResults: z.array(z.looseObject({ id: z.string(), pass: z.boolean() })),
  }),
  variantExperiment: z.looseObject({}),
  conformance: z.looseObject({
    pass: z.boolean(),
    checks: z.array(z.looseObject({ name: z.string(), pass: z.boolean() })),
    toolCount: z.number(),
  }),
  listTools: z.looseObject({
    toolCount: z.number(),
    tools: z.array(z.looseObject({ name: z.string() })),
  }),
  toolCall: z.looseObject({
    toolName: z.string(),
    durationMs: z.number(),
    isError: z.boolean(),
  }),
};

/** Payloads the eval runner can be large; everything else is pretty-printed for the HTML report. */
const COMPACT_KINDS: ReadonlySet<Kind> = new Set([
  'evalResults',
  'variantExperiment',
]);

function attachmentName(attachment: ReporterAttachment): string {
  return attachment.kind === 'toolCall'
    ? `${REPORTER_ATTACHMENT_NAMES.toolCall}${attachment.data.toolName}`
    : REPORTER_ATTACHMENT_NAMES[attachment.kind];
}

/** Records data on a test for the MCP reporter. */
export async function attachReporterData(
  testInfo: Pick<TestInfo, 'attach'>,
  attachment: ReporterAttachment
): Promise<void> {
  const body = COMPACT_KINDS.has(attachment.kind)
    ? Buffer.from(JSON.stringify(attachment.data))
    : JSON.stringify(attachment.data, null, 2);
  await testInfo.attach(attachmentName(attachment), {
    contentType: JSON_CONTENT_TYPE,
    body,
  });
}

/** Which channel kind an attachment name belongs to, if any. */
export function reporterAttachmentKind(attachment: {
  name: string;
  contentType?: string;
}): Kind | undefined {
  if (attachment.contentType !== JSON_CONTENT_TYPE) return undefined;
  if (attachment.name.startsWith(REPORTER_ATTACHMENT_NAMES.toolCall))
    return 'toolCall';
  const kinds = Object.keys(REPORTER_ATTACHMENT_NAMES) as Kind[];
  return kinds.find(
    (kind) =>
      kind !== 'toolCall' && REPORTER_ATTACHMENT_NAMES[kind] === attachment.name
  );
}

/**
 * Reads an attachment's content as channel data.
 *
 * @throws When the content isn't JSON or doesn't match the kind's schema.
 */
export function parseReporterAttachment(
  kind: Kind,
  content: string
): ReporterAttachment {
  const data: unknown = JSON.parse(content);
  const result = PAYLOAD_SCHEMAS[kind].safeParse(data);
  if (!result.success)
    throw new Error(
      `Invalid ${kind} attachment: ${result.error.issues
        .map((issue) => `${issue.path.join('.') || '(root)'} ${issue.message}`)
        .join('; ')}`
    );
  return { kind, data } as ReporterAttachment;
}
