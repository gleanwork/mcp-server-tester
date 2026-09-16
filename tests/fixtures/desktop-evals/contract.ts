import { JSONRPCMessageSchema } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';

export const DesktopRecordSchema = z.object({
  reference: z.string(),
  title: z.string(),
  verificationCode: z.string(),
});

export const DesktopSeedSchema = z.object({
  runId: z.string(),
  serverLabel: z.string(),
  serverName: z.string(),
  records: z.array(DesktopRecordSchema),
});

export const DesktopRuntimeSchema = z.object({
  version: z.literal(1),
  seed: DesktopSeedSchema,
  ledgerPath: z.string(),
});

export const DesktopLedgerEntrySchema = z.object({
  version: z.literal(1),
  runId: z.string(),
  serverLabel: z.string(),
  serverName: z.string(),
  sessionId: z.string(),
  sequence: z.number().int().positive(),
  direction: z.enum(['request', 'response']),
  message: JSONRPCMessageSchema,
});

export type DesktopRecord = z.infer<typeof DesktopRecordSchema>;
export type DesktopSeed = z.infer<typeof DesktopSeedSchema>;
export type DesktopRuntime = z.infer<typeof DesktopRuntimeSchema>;
export type DesktopLedgerEntry = z.infer<typeof DesktopLedgerEntrySchema>;
