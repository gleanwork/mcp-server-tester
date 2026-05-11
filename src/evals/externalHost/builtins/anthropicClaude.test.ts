import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  buildClaudeTraceMetadata,
  findMatchingClaudeSessions,
  extractAccessibilityResponse,
  getClaudeDataDir,
  looksLikeClaudeChatSurface,
  parseClaudeTrace,
  snapshotClaudeSessions,
  waitForClaudeTrace,
  type SessionCandidate,
} from './anthropicClaude.js';

const COWORK_DRIVER = {
  provider: 'anthropic',
  product: 'claude',
  surface: 'cowork',
  runtime: 'desktop-app',
  platform: 'macos',
} as const;

async function writeJsonl(path: string, events: unknown[]): Promise<void> {
  await writeFile(
    path,
    events.map((event) => JSON.stringify(event)).join('\n'),
    'utf-8'
  );
}

describe('anthropicClaude trace parsing', () => {
  it('parses final answer, usage, tool calls, and artifacts from local Claude files', async () => {
    const root = await mkdtemp(join(tmpdir(), 'claude-trace-'));
    const sessionId = 'local_test';
    const cliSessionId = 'cli-session';
    const sessionDir = join(root, sessionId);
    const transcriptDir = join(
      sessionDir,
      '.claude',
      'projects',
      '-sessions-test'
    );
    await mkdir(transcriptDir, { recursive: true });

    const metadataPath = join(root, `${sessionId}.json`);
    await writeFile(
      metadataPath,
      JSON.stringify({
        sessionId,
        cliSessionId,
        initialMessage: 'marker MCP_SERVER_TESTER_TEST',
        cwd: '/sessions/test',
        createdAt: '2026-05-09T00:00:00.000Z',
      }),
      'utf-8'
    );

    await writeJsonl(join(sessionDir, 'audit.jsonl'), [
      {
        type: 'result',
        result: 'trace spike acknowledged.',
        requestId: 'req_123',
        duration_ms: 1234,
        duration_api_ms: 1000,
        total_cost_usd: 0.01,
        usage: {
          input_tokens: 10,
          output_tokens: 5,
          cache_read_input_tokens: 2,
        },
        timestamp: '2026-05-09T00:00:02.000Z',
      },
    ]);

    await writeJsonl(join(transcriptDir, `${cliSessionId}.jsonl`), [
      {
        type: 'assistant',
        message: {
          content: [
            {
              type: 'tool_use',
              id: 'toolu_1',
              name: 'mcp__server__search',
              input: { query: 'planning' },
            },
          ],
        },
      },
    ]);

    const candidate: SessionCandidate = {
      id: sessionId,
      metadataPath,
      sessionDir,
      statMtimeMs: Date.now(),
      metadata: {
        sessionId,
        cliSessionId,
        initialMessage: 'marker MCP_SERVER_TESTER_TEST',
        cwd: '/sessions/test',
      },
    };

    const trace = await parseClaudeTrace(candidate);

    expect(trace.finalAnswer).toBe('trace spike acknowledged.');
    expect(trace.requestId).toBe('req_123');
    expect(trace.usage).toMatchObject({
      inputTokens: 10,
      outputTokens: 5,
      totalCostUsd: 0.01,
      durationMs: 1234,
      durationApiMs: 1000,
      cacheReadInputTokens: 2,
    });
    expect(trace.toolCalls).toEqual([
      {
        id: 'toolu_1',
        name: 'search',
        arguments: { query: 'planning' },
      },
    ]);
    expect(trace.transcriptPath).toContain(`${cliSessionId}.jsonl`);
    expect(trace.isComplete).toBe(true);
    expect(trace.auditParsed).toBe(true);
    expect(trace.transcriptParsed).toBe(true);
    expect(trace.usageAvailable).toBe(true);
    expect(trace.costAvailable).toBe(true);
  });

  it('does not treat assistant text without a result event as a completed run', async () => {
    const root = await mkdtemp(join(tmpdir(), 'claude-pending-'));
    const sessionId = 'local_pending';
    const sessionDir = join(root, sessionId);
    await mkdir(sessionDir, { recursive: true });
    const metadataPath = join(root, `${sessionId}.json`);
    await writeFile(
      metadataPath,
      JSON.stringify({
        sessionId,
        initialMessage: 'marker MCP_SERVER_TESTER_PENDING',
        createdAt: new Date().toISOString(),
      }),
      'utf-8'
    );
    await writeJsonl(join(sessionDir, 'audit.jsonl'), [
      {
        type: 'assistant',
        message: {
          content: [{ type: 'text', text: 'partial assistant response' }],
        },
      },
    ]);

    const candidate: SessionCandidate = {
      id: sessionId,
      metadataPath,
      sessionDir,
      statMtimeMs: Date.now(),
      metadata: {
        sessionId,
        initialMessage: 'marker MCP_SERVER_TESTER_PENDING',
      },
    };

    const trace = await parseClaudeTrace(candidate);

    expect(trace.finalAnswer).toBe('partial assistant response');
    expect(trace.isComplete).toBe(false);
  });

  it('continues parsing valid JSONL events when one line is malformed', async () => {
    const root = await mkdtemp(join(tmpdir(), 'claude-jsonl-'));
    const sessionId = 'local_jsonl';
    const sessionDir = join(root, sessionId);
    await mkdir(sessionDir, { recursive: true });
    const metadataPath = join(root, `${sessionId}.json`);
    await writeFile(
      metadataPath,
      JSON.stringify({
        sessionId,
        initialMessage: 'marker MCP_SERVER_TESTER_JSONL',
      }),
      'utf-8'
    );
    await writeFile(
      join(sessionDir, 'audit.jsonl'),
      [
        JSON.stringify({ type: 'assistant', result: 'ignored' }),
        '{not-json',
        JSON.stringify({ type: 'result', result: 'final answer' }),
      ].join('\n'),
      'utf-8'
    );

    const candidate: SessionCandidate = {
      id: sessionId,
      metadataPath,
      sessionDir,
      statMtimeMs: Date.now(),
      metadata: {
        sessionId,
        initialMessage: 'marker MCP_SERVER_TESTER_JSONL',
      },
    };

    const trace = await parseClaudeTrace(candidate);

    expect(trace.finalAnswer).toBe('final answer');
    expect(trace.isComplete).toBe(true);
    expect(trace.parseWarnings.join('\n')).toContain(
      'discarded 1 malformed JSONL line'
    );
  });

  it('only marks evidence fields high confidence when the parsed trace supports them', async () => {
    const root = await mkdtemp(join(tmpdir(), 'claude-evidence-'));
    const sessionId = 'local_evidence';
    const sessionDir = join(root, sessionId);
    await mkdir(sessionDir, { recursive: true });
    const metadataPath = join(root, `${sessionId}.json`);
    await writeFile(
      metadataPath,
      JSON.stringify({
        sessionId,
        initialMessage: 'marker MCP_SERVER_TESTER_EVIDENCE',
      }),
      'utf-8'
    );
    await writeJsonl(join(sessionDir, 'audit.jsonl'), [
      {
        type: 'result',
        result: 'final answer',
        total_cost_usd: 0.01,
        usage: { input_tokens: 1, output_tokens: 2 },
      },
    ]);

    const trace = await parseClaudeTrace({
      id: sessionId,
      metadataPath,
      sessionDir,
      statMtimeMs: Date.now(),
      metadata: {
        sessionId,
        initialMessage: 'marker MCP_SERVER_TESTER_EVIDENCE',
      },
    });
    const metadata = buildClaudeTraceMetadata({
      config: {
        driver: COWORK_DRIVER,
        name: 'Claude Cowork Desktop',
      },
      context: {
        runId: 'run',
        caseId: 'case',
        scenario: 'scenario',
        submittedScenario: 'scenario',
        marker: 'MCP_SERVER_TESTER_EVIDENCE',
        correlation: {
          strategy: 'prompt_marker',
          marker: 'MCP_SERVER_TESTER_EVIDENCE',
          includedInPrompt: true,
        },
        timeoutMs: 1000,
        startedAtMs: Date.now(),
      },
      driver: COWORK_DRIVER,
      displayName: 'Claude Cowork Desktop',
      artifacts: [],
      trace,
      limitations: [],
    });

    expect(metadata.evidence?.finalAnswer).toEqual({
      source: 'host-local-transcript',
      confidence: 'high',
    });
    expect(metadata.evidence?.toolCalls).toEqual({
      source: 'none',
      confidence: 'unknown',
    });
    expect(metadata.evidence?.usage).toEqual({
      source: 'host-local-transcript',
      confidence: 'high',
    });
    expect(metadata.evidence?.cost).toEqual({
      source: 'host-local-transcript',
      confidence: 'high',
    });
    expect(metadata.traceConfidence).toBe('high');
    expect(metadata.traceLimitations?.join('\n')).toContain(
      'Tool-call evidence is unavailable'
    );
  });

  it('allows capability-local Claude data directory options to override driver-wide options', () => {
    expect(
      getClaudeDataDir(
        {
          driver: COWORK_DRIVER,
          options: { dataDir: '/global/claude' },
        },
        { with: { dataDir: '/capability/claude' } }
      )
    ).toBe('/capability/claude');
  });

  it('matches sessions by marker instead of timing alone', async () => {
    const root = await mkdtemp(join(tmpdir(), 'claude-match-'));
    const sessionDir = join(root, 'local_match');
    await mkdir(sessionDir, { recursive: true });
    const metadataPath = join(root, 'local_match.json');

    await writeFile(
      metadataPath,
      JSON.stringify({
        sessionId: 'local_match',
        initialMessage: 'hello MCP_SERVER_TESTER_MATCH',
        createdAt: new Date().toISOString(),
      }),
      'utf-8'
    );
    await writeJsonl(join(sessionDir, 'audit.jsonl'), [
      { type: 'result', result: 'done' },
    ]);

    const matches = await findMatchingClaudeSessions({
      dataDir: root,
      marker: 'MCP_SERVER_TESTER_MATCH',
      snapshot: new Map(),
      startedAtMs: Date.now() - 1000,
    });

    expect(matches).toHaveLength(1);
    expect(matches[0]?.finalAnswer).toBe('done');
  });

  it('handles numeric Claude metadata timestamps when checking recency', async () => {
    const root = await mkdtemp(join(tmpdir(), 'claude-numeric-time-'));
    const sessionDir = join(root, 'local_numeric_time');
    await mkdir(sessionDir, { recursive: true });
    await writeFile(
      join(root, 'local_numeric_time.json'),
      JSON.stringify({
        sessionId: 'local_numeric_time',
        initialMessage: 'hello MCP_SERVER_TESTER_NUMERIC_TIME',
        createdAt: Date.now(),
      }),
      'utf-8'
    );
    await writeJsonl(join(sessionDir, 'audit.jsonl'), [
      { type: 'result', result: 'numeric timestamp done' },
    ]);

    const snapshot = await snapshotClaudeSessions(root);
    const matches = await findMatchingClaudeSessions({
      dataDir: root,
      marker: 'MCP_SERVER_TESTER_NUMERIC_TIME',
      snapshot,
      startedAtMs: Date.now() - 1000,
    });

    expect(matches).toHaveLength(1);
    expect(matches[0]?.finalAnswer).toBe('numeric timestamp done');
  });

  it('snapshots existing sessions so old unchanged files are ignored', async () => {
    const root = await mkdtemp(join(tmpdir(), 'claude-snapshot-'));
    await mkdir(join(root, 'local_old'), { recursive: true });
    await writeFile(
      join(root, 'local_old.json'),
      JSON.stringify({
        sessionId: 'local_old',
        initialMessage: 'MCP_SERVER_TESTER_OLD',
      }),
      'utf-8'
    );

    const snapshot = await snapshotClaudeSessions(root);
    const matches = await findMatchingClaudeSessions({
      dataDir: root,
      marker: 'MCP_SERVER_TESTER_OLD',
      snapshot,
      startedAtMs: Date.now(),
    });

    expect(matches).toEqual([]);
  });

  it('detects reused sessions when audit files change after the snapshot', async () => {
    const root = await mkdtemp(join(tmpdir(), 'claude-reuse-'));
    const sessionDir = join(root, 'local_reuse');
    await mkdir(sessionDir, { recursive: true });
    await writeFile(
      join(root, 'local_reuse.json'),
      JSON.stringify({
        sessionId: 'local_reuse',
        initialMessage: 'MCP_SERVER_TESTER_REUSE',
      }),
      'utf-8'
    );

    const snapshot = await snapshotClaudeSessions(root);
    await writeJsonl(join(sessionDir, 'audit.jsonl'), [
      { type: 'result', result: 'reuse done' },
    ]);

    const matches = await findMatchingClaudeSessions({
      dataDir: root,
      marker: 'MCP_SERVER_TESTER_REUSE',
      snapshot,
      startedAtMs: Date.now(),
    });

    expect(matches).toHaveLength(1);
    expect(matches[0]?.finalAnswer).toBe('reuse done');
  });

  it('does not use a pre-marker result as completion for a reused session', async () => {
    const root = await mkdtemp(join(tmpdir(), 'claude-reuse-marker-'));
    const sessionId = 'local_reuse_marker';
    const sessionDir = join(root, sessionId);
    await mkdir(sessionDir, { recursive: true });
    const metadataPath = join(root, `${sessionId}.json`);
    await writeFile(
      metadataPath,
      JSON.stringify({
        sessionId,
        initialMessage: 'old run',
      }),
      'utf-8'
    );
    await writeJsonl(join(sessionDir, 'audit.jsonl'), [
      { type: 'result', result: 'old completed answer' },
      {
        type: 'assistant',
        message: {
          content: [
            {
              type: 'text',
              text: 'MCP_SERVER_TESTER_REUSED_MARKER partial new response',
            },
          ],
        },
      },
    ]);

    const trace = await parseClaudeTrace(
      {
        id: sessionId,
        metadataPath,
        sessionDir,
        statMtimeMs: Date.now(),
        metadata: {
          sessionId,
          initialMessage: 'old run',
        },
      },
      'MCP_SERVER_TESTER_REUSED_MARKER'
    );

    expect(trace.finalAnswer).toBe(
      'MCP_SERVER_TESTER_REUSED_MARKER partial new response'
    );
    expect(trace.isComplete).toBe(false);
  });

  it('does not use a pre-marker result when metadata contains the marker but the audit is still pending', async () => {
    const root = await mkdtemp(join(tmpdir(), 'claude-metadata-marker-'));
    const sessionId = 'local_metadata_marker';
    const sessionDir = join(root, sessionId);
    await mkdir(sessionDir, { recursive: true });
    const metadataPath = join(root, `${sessionId}.json`);
    await writeFile(
      metadataPath,
      JSON.stringify({
        sessionId,
        initialMessage: 'MCP_SERVER_TESTER_METADATA_MARKER prompt',
      }),
      'utf-8'
    );
    await writeJsonl(join(sessionDir, 'audit.jsonl'), [
      { type: 'result', result: 'old completed answer' },
      {
        type: 'assistant',
        message: {
          content: [
            {
              type: 'text',
              text: 'MCP_SERVER_TESTER_METADATA_MARKER partial new response',
            },
          ],
        },
      },
    ]);

    const trace = await parseClaudeTrace(
      {
        id: sessionId,
        metadataPath,
        sessionDir,
        statMtimeMs: Date.now(),
        metadata: {
          sessionId,
          initialMessage: 'MCP_SERVER_TESTER_METADATA_MARKER prompt',
        },
      },
      'MCP_SERVER_TESTER_METADATA_MARKER'
    );

    expect(trace.finalAnswer).toBe(
      'MCP_SERVER_TESTER_METADATA_MARKER partial new response'
    );
    expect(trace.isComplete).toBe(false);
  });

  it('does not combine a transcript marker with a pre-marker audit result', async () => {
    const root = await mkdtemp(join(tmpdir(), 'claude-cross-source-marker-'));
    const sessionId = 'local_cross_source_marker';
    const cliSessionId = 'cli-cross-source';
    const sessionDir = join(root, sessionId);
    const transcriptDir = join(sessionDir, '.claude', 'projects', '-project');
    await mkdir(transcriptDir, { recursive: true });
    const metadataPath = join(root, `${sessionId}.json`);
    await writeFile(
      metadataPath,
      JSON.stringify({
        sessionId,
        cliSessionId,
        initialMessage: 'old run',
      }),
      'utf-8'
    );
    await writeJsonl(join(sessionDir, 'audit.jsonl'), [
      { type: 'result', result: 'old completed answer' },
    ]);
    await writeJsonl(join(transcriptDir, `${cliSessionId}.jsonl`), [
      {
        type: 'assistant',
        message: {
          content: [
            {
              type: 'text',
              text: 'MCP_SERVER_TESTER_CROSS_SOURCE partial new response',
            },
          ],
        },
      },
    ]);

    const trace = await parseClaudeTrace(
      {
        id: sessionId,
        metadataPath,
        sessionDir,
        statMtimeMs: Date.now(),
        metadata: {
          sessionId,
          cliSessionId,
          initialMessage: 'old run',
        },
      },
      'MCP_SERVER_TESTER_CROSS_SOURCE'
    );

    expect(trace.finalAnswer).toBe(
      'MCP_SERVER_TESTER_CROSS_SOURCE partial new response'
    );
    expect(trace.isComplete).toBe(false);
  });

  it('normalizes MCP tool names when server names contain underscores', async () => {
    const root = await mkdtemp(join(tmpdir(), 'claude-tool-name-'));
    const sessionId = 'local_tool_name';
    const cliSessionId = 'cli-session';
    const sessionDir = join(root, sessionId);
    const transcriptDir = join(sessionDir, '.claude', 'projects', '-project');
    await mkdir(transcriptDir, { recursive: true });
    const metadataPath = join(root, `${sessionId}.json`);
    await writeFile(
      metadataPath,
      JSON.stringify({
        sessionId,
        cliSessionId,
        initialMessage: 'marker MCP_SERVER_TESTER_TOOL',
      }),
      'utf-8'
    );
    await writeJsonl(join(sessionDir, 'audit.jsonl'), [
      { type: 'result', result: 'done' },
    ]);
    await writeJsonl(join(transcriptDir, `${cliSessionId}.jsonl`), [
      {
        type: 'assistant',
        message: {
          content: [
            {
              type: 'tool_use',
              id: 'toolu_1',
              name: 'mcp__my_server__search',
              input: { query: 'planning' },
            },
          ],
        },
      },
    ]);

    const trace = await parseClaudeTrace({
      id: sessionId,
      metadataPath,
      sessionDir,
      statMtimeMs: Date.now(),
      metadata: {
        sessionId,
        cliSessionId,
        initialMessage: 'marker MCP_SERVER_TESTER_TOOL',
      },
    });

    expect(trace.toolCalls[0]?.name).toBe('search');
  });

  it('waits for a terminal result event before returning a matched trace', async () => {
    const root = await mkdtemp(join(tmpdir(), 'claude-wait-result-'));
    const sessionDir = join(root, 'local_wait');
    await mkdir(sessionDir, { recursive: true });
    await writeFile(
      join(root, 'local_wait.json'),
      JSON.stringify({
        sessionId: 'local_wait',
        initialMessage: 'MCP_SERVER_TESTER_WAIT',
        createdAt: new Date().toISOString(),
      }),
      'utf-8'
    );
    await writeJsonl(join(sessionDir, 'audit.jsonl'), [
      {
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'partial' }] },
      },
    ]);

    const tracePromise = waitForClaudeTrace({
      dataDir: root,
      marker: 'MCP_SERVER_TESTER_WAIT',
      correlation: {
        strategy: 'prompt_marker',
        marker: 'MCP_SERVER_TESTER_WAIT',
        includedInPrompt: true,
      },
      snapshot: new Map(),
      timeoutMs: 2_500,
      startedAtMs: Date.now() - 1000,
    });

    await new Promise((resolve) => setTimeout(resolve, 900));
    await writeJsonl(join(sessionDir, 'audit.jsonl'), [
      {
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'partial' }] },
      },
      { type: 'result', result: 'complete' },
    ]);

    await expect(tracePromise).resolves.toMatchObject({
      finalAnswer: 'complete',
      isComplete: true,
    });
  });

  it('waits briefly for an expected embedded transcript after the result event', async () => {
    const root = await mkdtemp(join(tmpdir(), 'claude-wait-transcript-'));
    const sessionId = 'local_wait_transcript';
    const cliSessionId = 'cli-session';
    const sessionDir = join(root, sessionId);
    const transcriptDir = join(sessionDir, '.claude', 'projects', '-project');
    await mkdir(transcriptDir, { recursive: true });
    await writeFile(
      join(root, `${sessionId}.json`),
      JSON.stringify({
        sessionId,
        cliSessionId,
        initialMessage: 'MCP_SERVER_TESTER_TRANSCRIPT',
        createdAt: new Date().toISOString(),
      }),
      'utf-8'
    );
    await writeJsonl(join(sessionDir, 'audit.jsonl'), [
      { type: 'result', result: 'complete' },
    ]);

    const tracePromise = waitForClaudeTrace({
      dataDir: root,
      marker: 'MCP_SERVER_TESTER_TRANSCRIPT',
      correlation: {
        strategy: 'prompt_marker',
        marker: 'MCP_SERVER_TESTER_TRANSCRIPT',
        includedInPrompt: true,
      },
      snapshot: new Map(),
      timeoutMs: 3_500,
      startedAtMs: Date.now() - 1000,
    });

    await new Promise((resolve) => setTimeout(resolve, 900));
    await writeJsonl(join(transcriptDir, `${cliSessionId}.jsonl`), [
      {
        type: 'assistant',
        message: {
          content: [
            {
              type: 'tool_use',
              id: 'toolu_1',
              name: 'mcp__server__search',
              input: { query: 'planning' },
            },
          ],
        },
      },
    ]);

    await expect(tracePromise).resolves.toMatchObject({
      finalAnswer: 'complete',
      transcriptParsed: true,
      toolCalls: [{ name: 'search', arguments: { query: 'planning' } }],
    });
  });

  it('discovers nested Claude local-agent session metadata', async () => {
    const root = await mkdtemp(join(tmpdir(), 'claude-nested-'));
    const nested = join(root, 'workspace', 'project');
    await mkdir(join(nested, 'local_nested'), { recursive: true });
    await writeFile(
      join(nested, 'local_nested.json'),
      JSON.stringify({
        sessionId: 'local_nested',
        initialMessage: 'MCP_SERVER_TESTER_NESTED',
        createdAt: new Date().toISOString(),
      }),
      'utf-8'
    );
    await writeJsonl(join(nested, 'local_nested', 'audit.jsonl'), [
      { type: 'result', result: 'nested done' },
    ]);

    const matches = await findMatchingClaudeSessions({
      dataDir: root,
      marker: 'MCP_SERVER_TESTER_NESTED',
      snapshot: new Map(),
      startedAtMs: Date.now() - 1000,
    });

    expect(matches).toHaveLength(1);
    expect(matches[0]?.finalAnswer).toBe('nested done');
  });

  it('can match a single fresh Claude local-agent session without a prompt marker', async () => {
    const root = await mkdtemp(join(tmpdir(), 'claude-no-marker-'));
    const sessionDir = join(root, 'local_no_marker');
    await mkdir(sessionDir, { recursive: true });
    await writeFile(
      join(root, 'local_no_marker.json'),
      JSON.stringify({
        sessionId: 'local_no_marker',
        initialMessage: 'plain prompt without marker',
        createdAt: new Date().toISOString(),
      }),
      'utf-8'
    );
    await writeJsonl(join(sessionDir, 'audit.jsonl'), [
      { type: 'result', result: 'plain prompt done' },
    ]);

    const matches = await findMatchingClaudeSessions({
      dataDir: root,
      marker: 'MCP_SERVER_TESTER_NOT_IN_PROMPT',
      correlation: {
        strategy: 'none',
        marker: 'MCP_SERVER_TESTER_NOT_IN_PROMPT',
        includedInPrompt: false,
      },
      snapshot: new Map(),
      startedAtMs: Date.now() - 1000,
    });

    expect(matches).toHaveLength(1);
    expect(matches[0]?.finalAnswer).toBe('plain prompt done');
  });

  it('extracts final answer from accessibility fallback text', () => {
    expect(
      extractAccessibilityResponse(
        [
          'You said: Please reply with exactly: external host integration acknowledged.',
          '[eval-run-marker:MCP_SERVER_TESTER_TEST]',
          'Claude responded: external host integration acknowledged.',
          'Write a message...',
        ].join('\n')
      )
    ).toBe('external host integration acknowledged.');
  });

  it('extracts final answer from comma-separated accessibility fallback text', () => {
    expect(
      extractAccessibilityResponse(
        'You said: prompt [eval-run-marker:MCP_SERVER_TESTER_TEST], Claude responded: external host integration acknowledged., Write a message...'
      )
    ).toBe('external host integration acknowledged.');
  });

  it('recognizes the regular Claude Chat surface from visible controls', () => {
    expect(
      looksLikeClaudeChatSurface(
        [
          'New chat',
          'Projects',
          'Artifacts',
          'Ask your org',
          'Write a message...',
        ].join('\n')
      )
    ).toBe(true);
  });

  it('does not classify a local-agent surface from generic composer text alone', () => {
    expect(
      looksLikeClaudeChatSurface(
        ['Claude Code', 'Session', 'Write a message...'].join('\n')
      )
    ).toBe(false);
  });
});
