import { z } from 'zod';
import type { MCPConfig } from '../../config/mcpConfig.js';
import {
  CloudConnectorsSchema,
  type CloudConnectorConfig,
  type CloudConnectorPlan,
  type verifyCloudConnectorEvents,
} from './claudeAiConnectors.js';

export const COWORK_CLOUD_CONTROL_PROTOCOL = 'mst.cowork-cloud-control/v1';
/** Includes the JSONL newline. Oversized evidence fails rather than truncates. */
export const COWORK_CLOUD_CONTROL_MAX_FRAME_BYTES = 16 * 1024 * 1024;
/** Longest `error` a response may carry, in UTF-16 code units. */
export const COWORK_CLOUD_CONTROL_MAX_ERROR_LENGTH = 1024;
const header = {
  protocol: z.literal(COWORK_CLOUD_CONTROL_PROTOCOL),
  id: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
};
const sessionId = z
  .string()
  .regex(/^cse_[0-9A-Za-z_]+$/)
  .max(256);
export const CoworkCloudControlRequestSchema = z.discriminatedUnion('method', [
  z.object({ ...header, method: z.literal('prepare') }).strict(),
  z
    .object({
      ...header,
      method: z.literal('beginTask'),
      prompt: z.string().max(1_000_000),
    })
    .strict(),
  z.object({ ...header, method: z.literal('bindTask'), sessionId }).strict(),
  z.object({ ...header, method: z.literal('confirmTaskComplete') }).strict(),
  z.object({ ...header, method: z.literal('verify') }).strict(),
  z.object({ ...header, method: z.literal('restore') }).strict(),
  z.object({ ...header, method: z.literal('listSessions') }).strict(),
  z.object({ ...header, method: z.literal('events'), sessionId }).strict(),
]);
export type CoworkCloudControlRequest = z.infer<
  typeof CoworkCloudControlRequestSchema
>;
export const CoworkCloudControlResponseSchema = z.discriminatedUnion('ok', [
  z.object({ ...header, ok: z.literal(true), result: z.unknown() }).strict(),
  z
    .object({
      ...header,
      ok: z.literal(false),
      error: z.string().max(COWORK_CLOUD_CONTROL_MAX_ERROR_LENGTH),
    })
    .strict(),
]);
export type CoworkCloudControlResponse = z.infer<
  typeof CoworkCloudControlResponseSchema
>;
export type CoworkCloudControlCommand =
  CoworkCloudControlRequest extends infer Request
    ? Request extends CoworkCloudControlRequest
      ? Omit<Request, 'protocol' | 'id'>
      : never
    : never;

export interface CoworkAccountIdentity {
  accountId: string;
  organizationId: string;
}
export interface CoworkCloudPreparation {
  plan: CloudConnectorPlan;
  serverLabels: Record<string, string>;
  remoteServerNames: string[];
  requestedConnectors?: CloudConnectorConfig;
  effectiveConnectors: CloudConnectorConfig;
  servers: MCPConfig[];
  writes?: Readonly<Record<string, 'unguarded' | 'live'>>;
  model?: string;
}
export type CoworkCloudVerification = ReturnType<
  typeof verifyCloudConnectorEvents
>;

/** Validate the source reply before using its policy for worker HITL. */
export const CoworkCloudPreparationSchema = z
  .object({
    plan: z
      .object({
        accountId: z.string().min(1),
        organizationId: z.string().min(1),
        patch: z.record(z.string(), z.boolean().nullable()),
        allowedTools: z.array(z.string()),
        blockedTools: z.array(z.string()),
        managedServers: z.array(z.string()),
        serverDisplayNames: z.record(z.string(), z.string()),
        failOnApproval: z.boolean(),
      })
      .strict(),
    serverLabels: z.record(z.string(), z.string()),
    remoteServerNames: z.array(z.string()),
    requestedConnectors: CloudConnectorsSchema.optional(),
    effectiveConnectors: CloudConnectorsSchema,
    servers: z.array(
      z
        .object({
          transport: z.literal('http'),
          serverUrl: z.string(),
          label: z.string().optional(),
        })
        .strict()
    ),
    writes: z.record(z.string(), z.enum(['unguarded', 'live'])).optional(),
    model: z.string().optional(),
  })
  .strict();
