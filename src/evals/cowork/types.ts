import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { MCPConfig } from '../../config/mcpConfig.js';
import type { HostRunResult } from '../evalFrameworkTypes.js';
import type { ClaudeSessionSnapshot } from '../externalHost/builtins/anthropicClaude.js';

/** One persistent runtime must service the entire launch/control/cleanup lifecycle. */
export interface CoworkCuaTransport {
  call(
    name: string,
    args: Record<string, unknown>,
    timeoutMs: number
  ): Promise<CallToolResult>;
}

export interface CoworkComposer {
  value?: string;
}

export interface CoworkControlState {
  pageUrl?: string;
  composer?: CoworkComposer;
  automaticallyApprove: boolean;
}

/** Implementations must not score or change approval settings. */
export interface CoworkControl {
  openUrl(url: string): Promise<void>;
  observe(): Promise<CoworkControlState>;
  /** Replace the entire draft. Clipboard use must restore all original formats. */
  paste(text: string): Promise<void>;
  /** Replace the entire draft, with renderer delivery verification. */
  setValue(text: string): Promise<void>;
  pressReturn(): Promise<void>;
  clickSend(): Promise<void>;
}

export interface CoworkControlContext {
  pid: number;
  windowId: number;
  /** Shares the host's execution deadline and pending-operation tracking. */
  call(
    name: string,
    args: Record<string, unknown>
  ): Promise<Record<string, unknown>>;
}

export type CoworkInputMode = 'keyboard' | 'accessibility';
export type CoworkComposerVerification =
  | 'normalized-full'
  | 'first-line'
  | 'long-prefix';

/** Durable write-ahead receipt. Persist before submission, not after it. */
export interface CoworkCheckpoint {
  status: 'armed';
  marker: string;
  startedAtMs: number;
  deadline: number;
  pid: number;
  windowId: number;
  baselineSessions: Array<{ metadataPath: string; mtimeMs: number }>;
  promptSha256: string;
  inputMode: CoworkInputMode;
  verification: CoworkComposerVerification;
}

/** Private diagnostic side channel; never convert these values to HostEvents. */
export interface CoworkEvidenceDiagnostics {
  evidence: 'structured' | 'none';
  complete: boolean;
  failureKind?: string;
  sessionId?: string;
  cliSessionId?: string;
  metadataPath?: string;
  auditPath?: string;
  transcriptPath?: string;
  requestId?: string;
  parseWarningCount?: number;
  auditEventCount?: number;
  transcriptEventCount?: number;
  toolCallCount?: number;
  duplicateCallCount?: number;
  fullPromptConfirmed?: boolean;
}

export interface CoworkEvidenceInput {
  dataDir: string;
  marker: string;
  snapshot: ClaudeSessionSnapshot;
  startedAtMs: number;
  timeoutMs: number;
  /** Required even when AX can read the full composer. */
  expectedPrompt: string;
}

export interface CoworkEvidenceResult {
  trace: HostRunResult;
  diagnostics: CoworkEvidenceDiagnostics;
}

export interface CoworkNativeEvidence {
  snapshot(dataDir: string): Promise<ClaudeSessionSnapshot>;
  collect(input: CoworkEvidenceInput): Promise<CoworkEvidenceResult>;
}

export interface CoworkRunDiagnostics {
  marker: string;
  startedAtMs: number;
  stage: string;
  submitArmed: boolean;
  quarantined: boolean;
  diagnostics?: CoworkEvidenceDiagnostics;
  submitAcknowledgementError?: string;
}

export interface CoworkHostOptions {
  /** Caller-owned connection. Do not close or swap it during run(). */
  cua: CoworkCuaTransport;
  /** Explicit absolute native local-agent-mode-sessions directory. */
  dataDir: string;
  /** Already provisioned native servers, not instructions to install/connect them. */
  expectedServers: MCPConfig[];
  /** Verified native mcp__<namespace>__ prefixes mapped to expected server labels. */
  mcpServerPrefixes: Record<string, string>;
  checkpoint(this: void, receipt: CoworkCheckpoint): Promise<void>;
  /** Store privately. Do not persist raw clipboard data. */
  record?(this: void, record: CoworkRunDiagnostics): void | Promise<void>;
  /** Replaceable control backend; it must use this same owned process/runtime. */
  createControl?(this: void, context: CoworkControlContext): CoworkControl;
  /** Replaceable native collector. Must enforce the same full-prompt contract. */
  evidence?: CoworkNativeEvidence;
  isProcessAlive?(this: void, pid: number): boolean | Promise<boolean>;
  /** Registry name only; no reserved root host configuration is installed. */
  name?: string;
}
