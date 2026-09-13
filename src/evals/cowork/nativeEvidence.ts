import { readFile, stat } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { isDeepStrictEqual } from 'node:util';
import type { HostEvent } from '../evalFrameworkTypes.js';
import {
  parseClaudeTrace,
  snapshotClaudeSessions,
  waitForClaudeTrace,
} from '../externalHost/builtins/anthropicClaude.js';
import type {
  CoworkEvidenceDiagnostics,
  CoworkEvidenceInput,
  CoworkEvidenceResult,
  CoworkNativeEvidence,
} from './types.js';
import { errorMessage, isRecord } from './deadline.js';

export function createCoworkNativeEvidence(options: {
  mcpServerPrefixes: Record<string, string>;
}): CoworkNativeEvidence {
  const prefixes = Object.entries(options.mcpServerPrefixes);
  if (
    prefixes.some(
      ([prefix, server]) =>
        !/^mcp__.+__$/.test(prefix) ||
        typeof server !== 'string' ||
        !server.trim()
    )
  ) {
    throw new TypeError(
      'MCP prefix mappings require mcp__<server>__ prefixes and server labels'
    );
  }
  // Overlapping namespaces must not authorize a different server by insertion order.
  if (
    prefixes.some(([prefix], i) =>
      prefixes.some(([other], j) => i !== j && other.startsWith(prefix))
    )
  ) {
    throw new TypeError('MCP prefix mappings must not overlap');
  }
  return {
    async snapshot(dataDir) {
      if (!isAbsolute(dataDir) || !(await stat(dataDir)).isDirectory())
        throw new TypeError(
          'an explicit absolute dataDir directory is required'
        );
      return snapshotClaudeSessions(dataDir);
    },
    async collect(input) {
      const diagnostics: CoworkEvidenceDiagnostics = {
        evidence: 'none',
        complete: false,
      };
      try {
        return await collectComplete(input, diagnostics);
      } catch (error) {
        const message = errorMessage(error);
        const code =
          error instanceof EvidenceError
            ? message
            : message.startsWith('Timed out') ||
                message.startsWith('No matching')
              ? 'timeout'
              : message.startsWith('Ambiguous Claude sessions')
                ? 'ambiguous_matching_sessions'
                : 'collection_failed';
        return unavailable(code, diagnostics);
      }
    },
  };

  async function collectComplete(
    input: CoworkEvidenceInput,
    diagnostics: CoworkEvidenceDiagnostics
  ): Promise<CoworkEvidenceResult> {
    const {
      dataDir,
      marker,
      snapshot,
      startedAtMs,
      timeoutMs,
      expectedPrompt,
    } = input;
    if (
      !isAbsolute(dataDir) ||
      !marker.trim() ||
      !(snapshot instanceof Map) ||
      !Number.isFinite(startedAtMs) ||
      !Number.isFinite(timeoutMs) ||
      timeoutMs <= 0 ||
      typeof expectedPrompt !== 'string' ||
      !expectedPrompt.includes(marker)
    ) {
      return unavailable('invalid_input', diagnostics);
    }
    // The shared wait consumes this same budget; strict evidence must not reset it.
    const deadline = Date.now() + timeoutMs;
    const collected = await waitForClaudeTrace({
      dataDir,
      marker,
      snapshot,
      startedAtMs,
      timeoutMs,
      correlation: {
        strategy: 'prompt_marker',
        includedInPrompt: true,
        marker,
      },
    });
    Object.assign(diagnostics, {
      sessionId: collected.candidate.id,
      cliSessionId: collected.candidate.metadata.cliSessionId,
      metadataPath: collected.candidate.metadataPath,
      auditPath: collected.auditPath,
      transcriptPath: collected.transcriptPath,
      parseWarningCount: collected.parseWarnings.length,
    });
    if (collected.candidate.metadata.initialMessage !== expectedPrompt)
      return unavailable('metadata_prompt_mismatch', diagnostics);
    if (!collected.transcriptPath && !collected.candidate.metadata.cliSessionId)
      return unavailable('transcript_unavailable', diagnostics);
    if (!collected.auditPath)
      return unavailable('audit_unavailable', diagnostics);
    let transcriptPath = collected.transcriptPath;
    while (Date.now() < deadline) {
      try {
        if (!transcriptPath) {
          transcriptPath = (await parseClaudeTrace(collected.candidate, marker))
            .transcriptPath;
          diagnostics.transcriptPath = transcriptPath;
        }
        const complete = await collectStreams(
          input,
          transcriptPath,
          collected.auditPath,
          diagnostics
        );
        return Date.now() < deadline
          ? complete
          : unavailable('timeout', diagnostics);
      } catch (error) {
        if (!(error instanceof PendingEvidenceError)) throw error;
        const remainingMs = deadline - Date.now();
        if (remainingMs <= 0) throw error;
        await delay(Math.min(50, remainingMs));
        if (Date.now() >= deadline) throw error;
      }
    }
    return unavailable('timeout', diagnostics);
  }

  async function collectStreams(
    { marker, expectedPrompt }: CoworkEvidenceInput,
    transcriptPath: string | undefined,
    auditPath: string,
    diagnostics: CoworkEvidenceDiagnostics
  ): Promise<CoworkEvidenceResult> {
    const transcriptStream = await readRunStream(
      transcriptPath,
      marker,
      'transcript'
    );
    const auditStream = await readRunStream(
      auditPath,
      marker,
      'audit',
      (e) => e.type === 'result'
    );
    const transcript = transcriptStream.events;
    const audit = auditStream.events;
    const terminal = transcript.find(isTerminal);
    const auditTerminal = audit.find((e) => e.type === 'result');
    if (audit.length === 0)
      return unavailable('terminal_unavailable', diagnostics);
    for (const [name, stream] of [
      ['audit', audit],
      ['transcript', transcript],
    ] as const) {
      if (
        stream.length > 0 &&
        promptText(stream.find((event) => event.type === 'user')) !==
          expectedPrompt
      )
        return unavailable(`${name}_prompt_mismatch`, diagnostics);
    }
    const seen = new Map<string, HostEvent>();
    const events: HostEvent[] = [];
    let duplicateCallCount = 0;
    // Transcript defines order. Audit only corroborates; it cannot append calls.
    for (const [stream, isAudit] of [
      [transcript, false],
      [audit, true],
    ] as const) {
      for (const record of stream) {
        for (const block of blocks(record).filter(
          (b) => b.type === 'tool_use'
        )) {
          if (
            record.type !== 'assistant' ||
            typeof block.name !== 'string' ||
            !block.name ||
            typeof block.id !== 'string' ||
            !block.id ||
            (block.input !== undefined && !isRecord(block.input))
          )
            throw new EvidenceError('invalid_tool_event');
          const nativeName = block.name;
          const matched = prefixes.find(([prefix]) =>
            nativeName.startsWith(prefix)
          );
          if (!matched && block.name.startsWith('mcp__'))
            throw new EvidenceError('unverified_mcp_server');
          const event: HostEvent = {
            kind: 'tool_call',
            source: matched ? 'mcp' : 'host',
            name: block.name,
            ...(matched ? { server: matched[1] } : {}),
            id: block.id,
            arguments: isRecord(block.input) ? block.input : {},
          };
          const previous = seen.get(block.id);
          if (isAudit && !previous && terminal)
            throw new EvidenceError('transcript_missing_call');
          if (previous) {
            if (!isDeepStrictEqual(previous, event))
              throw new EvidenceError('conflicting_call_id');
            duplicateCallCount++;
          } else {
            seen.set(block.id, event);
            if (!isAudit) events.push(event);
          }
        }
      }
    }
    if (!terminal && !transcriptStream.canGrow)
      return unavailable('transcript_incomplete', diagnostics);
    if (!auditTerminal && !auditStream.canGrow)
      return unavailable('terminal_unavailable', diagnostics);
    if (terminal?.type === 'result' && typeof terminal.result !== 'string')
      throw new EvidenceError('final_text_unavailable');
    if (!terminal)
      throw new PendingEvidenceError(
        transcriptPath ? 'transcript_incomplete' : 'transcript_unavailable'
      );
    if (!auditTerminal) throw new PendingEvidenceError('terminal_unavailable');
    const finalText =
      typeof terminal.result === 'string'
        ? terminal.result
        : blocks(terminal)
            .filter((b) => b.type === 'text')
            .map((b) => (typeof b.text === 'string' ? b.text : ''))
            .join('');
    const hostFailed =
      terminal.is_error === true || auditTerminal.is_error === true;
    return {
      trace: {
        finalText,
        events,
        ...(hostFailed ? { error: 'cowork_native:host_run_failed' } : {}),
      },
      diagnostics: {
        ...diagnostics,
        evidence: 'structured',
        complete: true,
        fullPromptConfirmed: true,
        requestId: nativeRequestId(terminal) ?? nativeRequestId(auditTerminal),
        auditEventCount: audit.length,
        transcriptEventCount: transcript.length,
        toolCallCount: events.length,
        duplicateCallCount,
      },
    };
  }
}

class EvidenceError extends Error {}
class PendingEvidenceError extends EvidenceError {}

function unavailable(
  code: string,
  diagnostics: CoworkEvidenceDiagnostics
): CoworkEvidenceResult {
  return {
    trace: { finalText: '', events: [], error: `cowork_native:${code}` },
    diagnostics: {
      ...diagnostics,
      evidence: 'none',
      complete: false,
      failureKind: code,
    },
  };
}
function blocks(event: Record<string, unknown>): Record<string, unknown>[] {
  const content = isRecord(event.message) ? event.message.content : undefined;
  return Array.isArray(content) ? content.filter(isRecord) : [];
}
function promptText(
  event: Record<string, unknown> | undefined
): string | undefined {
  if (!event || !isRecord(event.message)) return undefined;
  if (typeof event.message.content === 'string') return event.message.content;
  if (!Array.isArray(event.message.content)) return undefined;
  const textBlocks = blocks(event).filter((b) => b.type === 'text');
  if (textBlocks.length === 0) return undefined;
  return textBlocks.map((b) => b.text).join('\n');
}
function isTerminal(event: Record<string, unknown>): boolean {
  return (
    event.type === 'result' ||
    (event.type === 'assistant' &&
      isRecord(event.message) &&
      event.message.stop_reason === 'end_turn')
  );
}
function nativeRequestId(event: Record<string, unknown>): string | undefined {
  const id = event.request_id ?? event.requestId;
  return typeof id === 'string' ? id : undefined;
}

/** Delivered user records alone establish the boundary, never queue copies. */
async function readRunStream(
  path: string | undefined,
  marker: string,
  source: string,
  terminalPredicate = isTerminal
): Promise<{
  events: Record<string, unknown>[];
  canGrow: boolean;
}> {
  if (!path) return { events: [], canGrow: true };
  let events: Record<string, unknown>[];
  try {
    const text = await readFile(path, 'utf8');
    events = text
      .split('\n')
      .filter((line) => line.trim())
      .map((line) => {
        const event: unknown = JSON.parse(line);
        if (!isRecord(event)) throw new SyntaxError('invalid native record');
        return event;
      });
  } catch (error) {
    throw new EvidenceError(
      `${source}_${error instanceof SyntaxError ? 'malformed' : 'unavailable'}`
    );
  }
  const start = events.findIndex(
    (e) =>
      e.type === 'user' &&
      e.isReplay !== true &&
      promptText(e)?.includes(marker)
  );
  if (start < 0) return { events: [], canGrow: events.length === 0 };
  let scoped = events.slice(start);
  const first = scoped[0]!;
  const nextPrompt = scoped.findIndex(
    (event, index) =>
      index > 0 &&
      event.type === 'user' &&
      promptText(event) !== undefined &&
      !(
        event.isReplay === true &&
        typeof first.uuid === 'string' &&
        event.uuid === first.uuid &&
        isDeepStrictEqual(event.message, first.message)
      )
  );
  // UI and SDK session_id values may differ for a same-UUID replay.
  if (nextPrompt >= 0) scoped = scoped.slice(0, nextPrompt);
  const end = scoped.findIndex(terminalPredicate);
  return {
    events: end < 0 ? scoped : scoped.slice(0, end + 1),
    canGrow: end < 0 && nextPrompt < 0,
  };
}
