import {
  appendFile,
  link,
  mkdtemp,
  mkdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  diagnoseChatgptBinding,
  expectedChatgptOriginator,
  findChatgptTrace,
  parseChatgptTrace,
  snapshotChatgptSessions,
} from './chatgptTrace.js';

const marker = 'MCP_SERVER_TESTER_test';
function event(type: string, payload: Record<string, unknown>, ms = 1000) {
  return { timestamp: new Date(ms).toISOString(), type, payload };
}
function turn(id = 'turn', runMarker = marker) {
  return [
    event('event_msg', { type: 'task_started', turn_id: id }),
    event('turn_context', { turn_id: id, model: 'gpt-test', effort: 'low' }),
    event('event_msg', {
      type: 'item_completed',
      turn_id: id,
      item: {
        type: 'UserMessage',
        id: `user-${id}`,
        content: [
          {
            type: 'text',
            text: `Test [eval-run-marker:${runMarker.replaceAll('_', '\\_')}]`,
          },
        ],
      },
    }),
    event(
      'event_msg',
      {
        type: 'item_completed',
        turn_id: id,
        started_at_ms: 2000,
        completed_at_ms: 2200,
        item: {
          type: 'McpToolCall',
          id: `a-${id}`,
          server: 'alpha',
          tool: 'lookup',
          arguments: { query: 'test' },
          result: { content: [{ type: 'text', text: 'result-a' }] },
          duration: { secs: 0, nanos: 200000000 },
          status: 'completed',
        },
      },
      2200
    ),
    event(
      'event_msg',
      {
        type: 'item_completed',
        turn_id: id,
        started_at_ms: 2100,
        completed_at_ms: 2300,
        item: {
          type: 'McpToolCall',
          id: `b-${id}`,
          server: 'beta',
          tool: 'lookup',
          arguments: {},
          result: { content: [{ type: 'text', text: 'result-b' }] },
          duration: { secs: 0, nanos: 200000000 },
          status: 'completed',
        },
      },
      2300
    ),
    event('token_usage_record', {
      turn_id: id,
      response_id: 'r1',
      usage: { input_tokens: 10, output_tokens: 2 },
      turn_token_usage: { input_tokens: 10, output_tokens: 2 },
    }),
    event('token_usage_record', {
      turn_id: id,
      response_id: 'r2',
      usage: { input_tokens: 20, output_tokens: 3 },
      turn_token_usage: {
        input_tokens: 30,
        output_tokens: 5,
        cached_input_tokens: 8,
        reasoning_output_tokens: 1,
      },
      thread_token_usage: { input_tokens: 99999, output_tokens: 999 },
    }),
    event('event_msg', {
      type: 'token_count',
      info: { total_token_usage: { input_tokens: 99999, output_tokens: 999 } },
    }),
    event('event_msg', {
      type: 'item_completed',
      turn_id: id,
      item: {
        type: 'AgentMessage',
        id: `answer-${id}`,
        phase: 'final_answer',
        content: [{ type: 'Text', text: 'done' }],
      },
    }),
    event('response_item', {
      type: 'message',
      id: `answer-${id}`,
      role: 'assistant',
      phase: 'final_answer',
      content: [{ type: 'output_text', text: 'done' }],
    }),
    event(
      'event_msg',
      {
        type: 'task_complete',
        turn_id: id,
        duration_ms: 2000,
        time_to_first_token_ms: 100,
        last_agent_message: 'done',
      },
      3000
    ),
  ];
}
function serialize(
  events = turn(),
  sessionId = 'session',
  originator = 'codex_work_desktop'
) {
  return (
    [
      event('session_meta', {
        id: sessionId,
        originator,
      }),
      ...events,
    ]
      .map((record) => JSON.stringify(record))
      .join('\n') + '\n'
  );
}

function exactTurn(prompt: string, id = 'turn') {
  const records = turn(id);
  records[2] = event('event_msg', {
    type: 'item_completed',
    turn_id: id,
    item: {
      type: 'UserMessage',
      id: `user-${id}`,
      content: [{ text: prompt }],
    },
  });
  return records;
}

const exact = (prompt: string) => ({
  strategy: 'exact_prompt' as const,
  prompt,
});

describe.each([
  { surface: undefined, originator: 'codex_work_desktop' },
  { surface: 'chatgpt-work' as const, originator: 'codex_work_desktop' },
  { surface: 'codex' as const, originator: 'Codex Desktop' },
])('native originator policy ($surface)', ({ surface, originator }) => {
  it('accepts only the configured surface identity for exact and marker selectors', () => {
    expect(expectedChatgptOriginator(surface)).toBe(originator);
    for (const [records, selector] of [
      [exactTurn('Find docs'), exact('Find docs')],
      [exactTurn('Find docs\n'), exact('Find docs')],
      [turn(), marker],
    ] as const) {
      const trace = parseChatgptTrace(
        serialize(records, 'session', originator),
        selector,
        1000,
        2000,
        { surface }
      );
      expect(trace).toMatchObject({ complete: true, response: 'done' });
      expect(trace?.error).toBeUndefined();
    }
  });

  it.each(
    [
      'codex_work_desktop',
      'Codex Desktop',
      'codex_cli_rs',
      'codex_cli',
      'codex',
      'codex_desktop',
      'codex desktop',
      'Codex desktop',
      'CODEX DESKTOP',
      'Codex Desktop ',
      ' Codex Desktop',
      'Codex_Work_Desktop',
      'codex_work_desktop\n',
    ].filter((candidate) => candidate !== originator)
  )('rejects cross-surface, CLI, and variant originator %j', (candidate) => {
    for (const selector of [exact('Find docs'), marker]) {
      const records =
        typeof selector === 'string' ? turn() : exactTurn('Find docs');
      expect(
        parseChatgptTrace(
          serialize(records, 'session', candidate),
          selector,
          0,
          Infinity,
          { surface }
        )
      ).toBeUndefined();
    }
  });

  it('preserves exact-prompt and timestamp limits', () => {
    for (const prompt of [
      'find docs',
      ' Find docs',
      'Find docs ',
      'Find docs\n\n',
      'Find docs \n',
    ]) {
      expect(
        parseChatgptTrace(
          serialize(exactTurn(prompt), 'session', originator),
          exact('Find docs'),
          0,
          Infinity,
          { surface }
        )
      ).toBeUndefined();
    }
    const content = serialize(exactTurn('Find docs'), 'session', originator);
    expect(
      parseChatgptTrace(content, exact('Find docs'), 1001, Infinity, {
        surface,
      })
    ).toBeUndefined();
    expect(
      parseChatgptTrace(content, exact('Find docs'), 0, 999, { surface })
    ).toBeUndefined();
  });

  it('threads policy through discovery without accepting baseline or changing bindings', async () => {
    const root = await mkdtemp(join(tmpdir(), 'chatgpt-surface-'));
    try {
      const path = join(root, 'rollout-new.jsonl');
      const baseline = await snapshotChatgptSessions(root);
      await writeFile(
        path,
        serialize(exactTurn('Find docs'), 'session', originator)
      );
      const found = await findChatgptTrace(
        root,
        baseline,
        exact('Find docs'),
        1000,
        { surface, observedBeforeMs: 2000, requireFreshSession: true }
      );
      expect(found?.trace.response).toBe('done');
      const existing = await snapshotChatgptSessions(root);
      await appendFile(path, '\n');
      expect(
        await findChatgptTrace(root, existing, exact('Find docs'), 0, {
          surface,
        })
      ).toBeUndefined();
      await expect(
        findChatgptTrace(root, baseline, exact('Find docs'), 0, {
          surface,
          bound: { path, sessionId: 'other-session', turnId: 'turn' },
        })
      ).rejects.toThrow('Bound ChatGPT');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

it('keeps the observed Codex abort terminal but unsuccessful', async () => {
  // Minimized/redacted shape from preserved run 35881948713, not a completed run.
  const content = await readFile(
    new URL('./fixtures/codexDesktopAborted.jsonl', import.meta.url),
    'utf8'
  );
  expect(parseChatgptTrace(content, exact('Find documents.'))).toBeUndefined();
  const trace = parseChatgptTrace(
    content,
    exact('Find documents.'),
    Date.parse('2026-09-23T15:34:00Z'),
    Date.parse('2026-09-23T15:36:01Z'),
    { surface: 'codex' }
  );
  expect(trace).toMatchObject({
    promptMatch: 'native_terminal_lf',
    model: 'gpt-5.6-terra',
    reasoningEffort: 'medium',
    complete: true,
    error: 'ChatGPT turn was aborted.',
    telemetry: { resultCount: 0 },
  });
  expect(trace?.response).toBeUndefined();
  expect(trace?.usage).toBeUndefined();
});

describe('marker-free native correlation', () => {
  it('records the native single-terminal-LF form without general whitespace folding', () => {
    const trace = parseChatgptTrace(
      serialize(exactTurn('Find docs\n')),
      exact('Find docs')
    )!;
    expect(trace.promptMatch).toBe('native_terminal_lf');
    expect(trace.nativePromptSha256).toBe(
      createHash('sha256').update('Find docs\n').digest('hex')
    );
    expect(
      parseChatgptTrace(
        serialize(exactTurn('Find docs\n\n')),
        exact('Find docs')
      )
    ).toBeUndefined();
    expect(
      parseChatgptTrace(
        serialize(exactTurn('Find docs \n')),
        exact('Find docs')
      )
    ).toBeUndefined();
    expect(
      parseChatgptTrace(serialize(exactTurn('Find docs')), exact('Find docs\n'))
    ).toBeUndefined();
    expect(
      parseChatgptTrace(
        serialize(exactTurn('Find docs\n')),
        exact('Find docs\n')
      )?.promptMatch
    ).toBe('exact');
  });
  it('matches the unchanged native user prompt with no marker', () => {
    const prompt = '  Find snake_case docs — α\nSecond line.  ';
    const trace = parseChatgptTrace(
      serialize(exactTurn(prompt)),
      exact(prompt),
      1000,
      2000
    );
    expect(trace).toMatchObject({
      sessionId: 'session',
      turnId: 'turn',
      complete: true,
      response: 'done',
    });
    expect(trace!.usage?.inputTokens).toBe(30);
  });
  it.each([
    'find docs',
    ' Find docs',
    'Find docs ',
    'Find docs\nextra',
    'prefix Find docs',
  ])('does not fuzzy-match %j', (other) => {
    expect(
      parseChatgptTrace(serialize(exactTurn(other)), exact('Find docs'))
    ).toBeUndefined();
  });
  it('does not remove Markdown escapes or normalize Unicode to manufacture equality', () => {
    expect(
      parseChatgptTrace(
        serialize(exactTurn('snake\\_case')),
        exact('snake_case')
      )
    ).toBeUndefined();
    expect(
      parseChatgptTrace(serialize(exactTurn('cafe\u0301')), exact('café'))
    ).toBeUndefined();
  });
  it('requires the authoritative native UserMessage, not an assistant/tool/context echo', () => {
    const records = exactTurn('Find docs');
    records[2] = event('response_item', {
      type: 'message',
      role: 'user',
      content: [{ text: 'Find docs' }],
    });
    expect(
      parseChatgptTrace(serialize(records), exact('Find docs'))
    ).toBeUndefined();
    records[2] = event('event_msg', {
      type: 'item_completed',
      item: { type: 'AgentMessage', content: [{ text: 'Find docs' }] },
    });
    expect(
      parseChatgptTrace(serialize(records), exact('Find docs'))
    ).toBeUndefined();
  });
  it('rejects stale/future messages, multiple matching turns, and follow-up prompts', () => {
    const records = serialize(exactTurn('Find docs'));
    expect(
      parseChatgptTrace(records, exact('Find docs'), 1001)
    ).toBeUndefined();
    expect(
      parseChatgptTrace(records, exact('Find docs'), 0, 999)
    ).toBeUndefined();
    expect(() =>
      parseChatgptTrace(
        serialize([
          ...exactTurn('Find docs', 'one'),
          ...exactTurn('Find docs', 'two'),
        ]),
        exact('Find docs')
      )
    ).toThrow('Ambiguous');
    expect(() =>
      parseChatgptTrace(
        serialize([
          ...exactTurn('Prior question', 'one'),
          ...exactTurn('Find docs', 'two'),
        ]),
        exact('Find docs')
      )
    ).toThrow('initial user message');
    expect(() => parseChatgptTrace(records, exact('   '))).toThrow('non-empty');
  });
  it('only reads fresh files, and attributes repeated queries to separate sessions across baselines', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mst-chatgpt-exact-'));
    try {
      const old = join(root, 'rollout-old.jsonl');
      await writeFile(old, 'private old data, not JSONL\n');
      const before = await snapshotChatgptSessions(root);
      await writeFile(old, 'changed old data, still not JSONL\n');
      const first = join(root, 'rollout-first.jsonl');
      await writeFile(first, serialize(exactTurn('Same query'), 'first'));
      expect(
        (await findChatgptTrace(root, before, exact('Same query'), 0))?.trace
          .sessionId
      ).toBe('first');
      const between = await snapshotChatgptSessions(root);
      await writeFile(
        join(root, 'rollout-second.jsonl'),
        serialize(exactTurn('Same query', 'two'), 'second')
      );
      expect(
        (await findChatgptTrace(root, between, exact('Same query'), 0))?.trace
          .sessionId
      ).toBe('second');
      await expect(
        findChatgptTrace(root, before, exact('Same query'), 0)
      ).rejects.toThrow('Ambiguous');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  it('keeps a bound session/turn stable and still rejects a later duplicate session', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mst-chatgpt-bound-'));
    try {
      const path = join(root, 'rollout-first.jsonl');
      const baseline = await snapshotChatgptSessions(root);
      await writeFile(path, serialize(exactTurn('Same query').slice(0, -1)));
      const first = (await findChatgptTrace(
        root,
        baseline,
        exact('Same query'),
        0
      ))!;
      expect(first.trace.complete).toBe(false);
      const bound = {
        path,
        sessionId: first.trace.sessionId,
        turnId: first.trace.turnId,
      };
      await writeFile(path, serialize(exactTurn('Same query')));
      expect(
        (
          await findChatgptTrace(root, baseline, exact('Same query'), 0, {
            bound,
          })
        )?.trace.complete
      ).toBe(true);
      const duplicate = join(root, 'rollout-duplicate.jsonl');
      await writeFile(
        duplicate,
        serialize(exactTurn('Same query\n', 'other'), 'other')
      );
      await expect(
        findChatgptTrace(root, baseline, exact('Same query'), 0, { bound })
      ).rejects.toThrow('Ambiguous');
      await rm(duplicate);
      await writeFile(
        path,
        serialize(exactTurn('Same query', 'switched'), 'switched')
      );
      await expect(
        findChatgptTrace(root, baseline, exact('Same query'), 0, { bound })
      ).rejects.toThrow('Bound ChatGPT');
      await rm(path);
      await expect(
        findChatgptTrace(root, baseline, exact('Same query'), 0, { bound })
      ).rejects.toThrow('Bound ChatGPT');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('ChatGPT native telemetry', () => {
  it('classifies confirmed built-in CUA calls as host tools and separates MCP timing', () => {
    const records = turn();
    const item = records[3]!.payload.item as Record<string, unknown>;
    item.server = 'cua_repl';
    item.tool = 'js';
    item.status = 'failed';
    const trace = parseChatgptTrace(serialize(records), marker)!;
    expect(trace.toolCalls[0]).toMatchObject({
      source: 'host',
      server: 'cua_repl',
      name: 'js',
      rawName: 'cua_repl.js',
      isError: true,
    });
    expect(trace.toolCalls[1]).toMatchObject({
      source: 'mcp',
      server: 'beta',
      name: 'lookup',
    });
    expect(trace).toMatchObject({ mcpDurationMs: 200, llmDurationMs: 1700 });
    expect(trace.telemetry).toMatchObject({
      toolCallCount: 2,
      toolErrorCount: 1,
      mcpToolCallCount: 1,
      mcpToolErrorCount: 0,
      hostToolCallCount: 1,
      hostToolErrorCount: 1,
      mcpWallDurationMs: 200,
      hostToolDurationMs: 200,
      toolWallDurationMs: 300,
      toolProvenance: [
        {
          id: 'a-turn',
          source: 'host',
          nativeServer: 'cua_repl',
          nativeTool: 'js',
        },
        {
          id: 'b-turn',
          source: 'mcp',
          nativeServer: 'beta',
          nativeTool: 'lookup',
        },
      ],
    });
    expect(
      parseChatgptTrace(
        serialize(records).replace('codex_work_desktop', 'codex_cli'),
        marker
      )
    ).toBeUndefined();
  });
  it('captures native command execution and web search as host tools with their errors and timing', () => {
    const records = turn();
    records[3] = event(
      'event_msg',
      {
        type: 'item_completed',
        turn_id: 'turn',
        started_at_ms: 2000,
        completed_at_ms: 2200,
        item: {
          type: 'CommandExecution',
          id: 'command',
          command: ['cat', 'SKILL.md'],
          cwd: '/fixture',
          source: 'unified_exec_startup',
          stdout: '',
          stderr: 'access denied',
          exit_code: 1,
          status: 'failed',
        },
      },
      2200
    );
    records[4] = event(
      'event_msg',
      {
        type: 'item_completed',
        turn_id: 'turn',
        started_at_ms: 2100,
        completed_at_ms: 2300,
        item: {
          type: 'Extension',
          kind: 'web.search',
          id: 'web',
          query: 'documentation',
          action: { type: 'search' },
          results: [{ title: 'Docs', url: 'https://example.test' }],
        },
      },
      2300
    );
    const trace = parseChatgptTrace(serialize(records), marker)!;
    expect(trace.toolCalls).toMatchObject([
      {
        source: 'host',
        name: 'CommandExecution',
        rawName: 'CommandExecution',
        isError: true,
        durationMs: 200,
        arguments: { command: ['cat', 'SKILL.md'] },
      },
      {
        source: 'host',
        name: 'web.search',
        rawName: 'Extension.web.search',
        isError: false,
        durationMs: 200,
        arguments: { query: 'documentation', action: { type: 'search' } },
      },
    ]);
    expect(trace.toolCalls[0]!.server).toBeUndefined();
    expect(trace.toolCalls[0]!.output).toContain('access denied');
    expect(trace.toolCalls[1]!.output).toContain('https://example.test');
    expect(trace).toMatchObject({ mcpDurationMs: 0, llmDurationMs: 1700 });
    expect(trace.telemetry).toMatchObject({
      mcpToolCallCount: 0,
      hostToolCallCount: 2,
      hostToolErrorCount: 1,
      mcpWallDurationMs: 0,
      hostToolDurationMs: 400,
      toolWallDurationMs: 300,
      toolProvenance: [
        {
          nativeItemType: 'CommandExecution',
          nativeTool: 'CommandExecution',
          source: 'host',
        },
        {
          nativeItemType: 'Extension',
          nativeTool: 'web.search',
          source: 'host',
        },
      ],
    });
    records.splice(5, 0, records[3]);
    expect(
      parseChatgptTrace(serialize(records), marker)!.toolCalls
    ).toHaveLength(2);
  });
  it('does not fabricate records for malformed native host actions', () => {
    const records = turn();
    records[3] = event('event_msg', {
      type: 'item_completed',
      item: { type: 'CommandExecution', id: 'bad-command' },
    });
    expect(() => parseChatgptTrace(serialize(records), marker)).toThrow(
      'Malformed native host command'
    );
    records[3] = event('event_msg', {
      type: 'item_completed',
      item: { type: 'Extension', kind: 'web.search', id: 'bad-web' },
    });
    expect(() => parseChatgptTrace(serialize(records), marker)).toThrow(
      'Malformed native host web'
    );
  });
  it('reports zero MCP calls and elapsed MCP time for host-only execution', () => {
    const records = turn();
    for (const index of [3, 4]) {
      const item = records[index]!.payload.item as Record<string, unknown>;
      item.server = 'cua_repl';
      item.tool = 'js';
    }
    const trace = parseChatgptTrace(serialize(records), marker)!;
    expect(trace).toMatchObject({ mcpDurationMs: 0, llmDurationMs: 1700 });
    expect(trace.telemetry).toMatchObject({
      mcpToolCallCount: 0,
      hostToolCallCount: 2,
      mcpWallDurationMs: 0,
      hostToolDurationMs: 400,
      toolWallDurationMs: 300,
    });
  });
  it('does not classify from a generic tool name, untrusted result metadata, or an unknown built-in API', () => {
    const records = turn();
    const item = records[3]!.payload.item as Record<string, unknown>;
    item.tool = 'js';
    item.result = {
      _meta: { 'codex/toolSurface': { kind: 'computerUse' } },
      content: [],
    };
    expect(
      parseChatgptTrace(serialize(records), marker)!.toolCalls[0]
    ).toMatchObject({ source: 'mcp', server: 'alpha' });
    item.server = 'cua_repl';
    item.tool = 'unknown_future_tool';
    expect(
      parseChatgptTrace(serialize(records), marker)!.toolCalls[0]
    ).toMatchObject({ source: 'mcp', server: 'cua_repl' });
    delete item.server;
    expect(() => parseChatgptTrace(serialize(records), marker)).toThrow(
      'Malformed native MCP'
    );
  });
  it('extracts exact-turn tools, messages and usage without double counting parallel time', () => {
    const trace = parseChatgptTrace(serialize(), marker)!;
    expect(trace).toMatchObject({
      sessionId: 'session',
      turnId: 'turn',
      model: 'gpt-test',
      reasoningEffort: 'low',
      complete: true,
      response: 'done',
      mcpDurationMs: 400,
      llmDurationMs: 1700,
    });
    expect(trace.usage).toMatchObject({
      inputTokens: 30,
      outputTokens: 5,
      cacheReadInputTokens: 8,
      reasoningOutputTokens: 1,
      durationMs: 2000,
    });
    expect(trace.usage?.totalCostUsd).toBeUndefined();
    expect(trace.telemetry).toMatchObject({
      apiCallCount: 2,
      toolCallCount: 2,
      mcpWallDurationMs: 300,
      timeToFirstTokenMs: 100,
    });
    expect(trace.toolCalls[0]).toMatchObject({
      name: 'lookup',
      server: 'alpha',
      arguments: { query: 'test' },
      durationMs: 200,
      isError: false,
    });
    expect(trace.toolCalls[0]?.output).toContain('result-a');
    expect(trace.conversationHistory.map((message) => message.role)).toEqual([
      'user',
      'tool',
      'tool',
      'assistant',
    ]);
  });

  it('does not mix prior or subsequent turns into the marked turn', () => {
    const trace = parseChatgptTrace(
      serialize([
        ...turn('old', 'old-marker'),
        ...turn(),
        ...turn('new', 'new-marker'),
      ]),
      marker
    )!;
    expect(trace.toolCalls).toHaveLength(2);
    expect(trace.usage?.inputTokens).toBe(30);
    expect(trace.turnId).toBe('turn');
  });

  it('rejects ambiguous turns and old matching prompts', () => {
    expect(() =>
      parseChatgptTrace(serialize([...turn(), ...turn('duplicate')]), marker)
    ).toThrow('Ambiguous');
    expect(parseChatgptTrace(serialize(), marker, 5000)).toBeUndefined();
    expect(parseChatgptTrace(serialize(), 'other')).toBeUndefined();
  });

  it('does not correlate from tool output or assistant text', () => {
    const events = turn();
    events[2] = event('event_msg', {
      type: 'item_completed',
      turn_id: 'turn',
      item: {
        type: 'AgentMessage',
        id: 'fake',
        content: [{ type: 'Text', text: `[eval-run-marker:${marker}]` }],
      },
    });
    expect(parseChatgptTrace(serialize(events), marker)).toBeUndefined();
  });

  it('ignores partial last records but rejects malformed completed records', () => {
    expect(
      parseChatgptTrace(serialize() + '{"partial":', marker)?.complete
    ).toBe(true);
    expect(() => parseChatgptTrace(serialize() + '{bad}\n', marker)).toThrow(
      'Malformed'
    );
  });

  it('does not call a final answer complete until task_complete', () => {
    expect(
      parseChatgptTrace(serialize(turn().slice(0, -1)), marker)?.complete
    ).toBe(false);
  });

  it('preserves tool errors and reports their count', () => {
    const records = turn();
    records[3] = event('event_msg', {
      type: 'item_completed',
      turn_id: 'turn',
      item: {
        type: 'McpToolCall',
        id: 'a-turn',
        server: 'alpha',
        tool: 'lookup',
        arguments: {},
        status: 'failed',
        error: { message: 'fixture failed' },
      },
    });
    const trace = parseChatgptTrace(serialize(records), marker)!;
    expect(
      trace.toolCalls.find((call) => call.server === 'alpha')
    ).toMatchObject({ isError: true, output: '{"message":"fixture failed"}' });
    expect(trace.telemetry.toolErrorCount).toBe(1);
    expect(trace.mcpDurationMs).toBeUndefined();
  });

  it('preserves the final answer as native Markdown', () => {
    const records = turn();
    records[records.length - 1] = event('event_msg', {
      type: 'task_complete',
      turn_id: 'turn',
      duration_ms: 2000,
      last_agent_message: String.raw`a\_b`,
    });
    expect(parseChatgptTrace(serialize(records), marker)?.response).toBe(
      String.raw`a\_b`
    );
  });

  it('ignores replayed older cumulative token totals', () => {
    const records = turn();
    records.splice(-1, 0, records[5]!);
    expect(
      parseChatgptTrace(serialize(records), marker)?.usage?.inputTokens
    ).toBe(30);
  });

  it('reports aborted turns', () => {
    const events = turn().slice(0, -1);
    events.push(event('event_msg', { type: 'turn_aborted', turn_id: 'turn' }));
    const trace = parseChatgptTrace(serialize(events), marker)!;
    expect(trace.complete).toBe(true);
    expect(trace.error).toContain('aborted');
  });

  it('does not invent usage or cost when native token records are missing', () => {
    const trace = parseChatgptTrace(
      serialize(
        turn().filter((record) => record.type !== 'token_usage_record')
      ),
      marker
    )!;
    expect(trace.usage).toBeUndefined();
    expect(trace.telemetry.totalCostUsd).toBeUndefined();
  });

  it('deduplicates repeated native items and response IDs', () => {
    const events = turn();
    events.splice(5, 0, events[3]!);
    events.splice(-1, 0, events[7]!);
    const trace = parseChatgptTrace(serialize(events), marker)!;
    expect(trace.toolCalls).toHaveLength(2);
    expect(trace.telemetry.apiCallCount).toBe(2);
  });

  it('never exposes reasoning or host instruction records as conversation text', () => {
    const events = turn();
    events.splice(
      3,
      0,
      event('response_item', {
        type: 'reasoning',
        encrypted_content: 'secret',
      }),
      event('response_item', {
        type: 'message',
        role: 'developer',
        content: [{ text: 'host instruction' }],
      })
    );
    expect(
      JSON.stringify(parseChatgptTrace(serialize(events), marker))
    ).not.toMatch(/secret|host instruction/);
  });
});

it('rejects a matching marker submitted into a pre-existing chat when freshness is required', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mst-chatgpt-fresh-'));
  try {
    const file = join(root, 'rollout-existing.jsonl');
    await writeFile(file, serialize(turn('old', 'old-marker')));
    const baseline = await snapshotChatgptSessions(root);
    await writeFile(file, serialize([...turn('old', 'old-marker'), ...turn()]));
    expect(
      (await findChatgptTrace(root, baseline, marker, 0))?.trace.turnId
    ).toBe('turn');
    await expect(
      findChatgptTrace(root, baseline, marker, 0, { requireFreshSession: true })
    ).rejects.toThrow('instead of a fresh chat');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it('discovers only changed/new rollout files and rejects duplicate sessions', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mst-chatgpt-trace-'));
  try {
    const day = join(root, '2026', '09', '18');
    await mkdir(day, { recursive: true });
    await writeFile(join(day, 'rollout-old.jsonl'), 'not a transcript\n');
    const before = await snapshotChatgptSessions(root);
    await writeFile(join(day, 'rollout-new.jsonl'), serialize());
    expect(
      (await findChatgptTrace(root, before, marker, 0))?.trace.response
    ).toBe('done');
    await writeFile(join(day, 'rollout-second.jsonl'), serialize());
    await expect(findChatgptTrace(root, before, marker, 0)).rejects.toThrow(
      'Ambiguous'
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

describe('UNVERIFIED binding diagnostics', () => {
  async function fixture() {
    const home = await mkdtemp(join(tmpdir(), 'chatgpt-diagnostic-'));
    const root = join(home, '.codex', 'sessions');
    await mkdir(root, { recursive: true });
    return {
      home,
      root,
      options: { isolatedLinuxHome: home, expectedRoot: root },
    };
  }

  it('reports new and modified baseline metadata without accepting either', async () => {
    const { home, root, options } = await fixture();
    try {
      const old = join(root, 'rollout-old.jsonl');
      await writeFile(old, serialize([]));
      const baseline = await snapshotChatgptSessions(root);
      const prompt = 'PRIVATE submitted prompt';
      await appendFile(
        old,
        exactTurn(prompt)
          .map((record) => JSON.stringify(record))
          .join('\n') + '\n'
      );
      const fresh = join(root, 'rollout-new.jsonl');
      await writeFile(
        fresh,
        serialize(exactTurn(prompt)).replace(
          'codex_work_desktop',
          'unconfirmed-linux-origin'
        )
      );
      const { metadata, candidatePaths } = await diagnoseChatgptBinding(
        root,
        baseline,
        prompt,
        options
      );
      expect(metadata).toMatchObject({
        status: 'UNVERIFIED',
        authoritative: false,
        rootExists: true,
        currentFileCount: 2,
        freshFileCount: 1,
        modifiedBaselineCount: 1,
        metadataRead: 'isolated-linux',
        expectedRootRelativeToHome: '.codex/sessions',
        originatorCount: { codex_work_desktop: 1, other: 1 },
        nativeUserMessageCount: 2,
        userTurnCount: 2,
      });
      expect(metadata.nativeUserMessageSha256).toEqual([
        metadata.submittedSha256,
        metadata.submittedSha256,
      ]);
      expect(candidatePaths.sort()).toEqual([fresh, old].sort());
      expect(JSON.stringify(metadata)).not.toContain(prompt);
      expect(JSON.stringify(metadata)).not.toContain(home);
      expect(JSON.stringify(metadata)).not.toContain(
        'unconfirmed-linux-origin'
      );
      expect(
        await findChatgptTrace(root, baseline, exact(prompt), 0, {
          requireFreshSession: true,
        })
      ).toBeUndefined();
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it('counts only exact known originators without selecting a surface from native metadata', async () => {
    const { home, root, options } = await fixture();
    try {
      const origins = [
        'Codex Desktop',
        'codex_work_desktop',
        'codex_cli_rs',
        'codex desktop',
        'Codex Desktop ',
        'private-origin',
      ];
      for (const [index, originator] of origins.entries()) {
        await writeFile(
          join(root, `rollout-${index}.jsonl`),
          serialize([], 'session', originator)
        );
      }
      const { metadata } = await diagnoseChatgptBinding(
        root,
        new Map(),
        'private prompt',
        { ...options, surface: 'codex' }
      );
      expect(metadata).toMatchObject({
        authoritative: false,
        expectedNativeOriginator: 'Codex Desktop',
        originatorCount: {
          'Codex Desktop': 1,
          codex_work_desktop: 1,
          other: 4,
        },
      });
      expect(JSON.stringify(metadata)).not.toMatch(
        /private-origin|private prompt|codex_cli_rs|codex desktop/
      );
      const work = await diagnoseChatgptBinding(
        root,
        new Map(),
        'private prompt',
        options
      );
      expect(work.metadata.expectedNativeOriginator).toBe('codex_work_desktop');
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it('does not inspect content or return candidates without isolated Linux attestation', async () => {
    const { home, root } = await fixture();
    try {
      const path = join(root, 'rollout-old.jsonl');
      await writeFile(path, serialize([]));
      const baseline = await snapshotChatgptSessions(root);
      await appendFile(path, 'not even JSON\n');
      await writeFile(join(root, 'rollout-new.jsonl'), serialize());
      const { metadata, candidatePaths } = await diagnoseChatgptBinding(
        root,
        baseline,
        'prompt'
      );
      expect(metadata).toMatchObject({
        metadataRead: 'disabled',
        currentFileCount: 2,
        freshFileCount: 1,
        modifiedBaselineCount: 1,
        recordTypes: {},
        originatorCount: {},
        malformedRecordCount: 0,
      });
      expect(candidatePaths).toEqual([]);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it('never reads unchanged isolated baseline content and caps total diagnostic bytes', async () => {
    const { home, root, options } = await fixture();
    try {
      await writeFile(
        join(root, 'rollout-unchanged.jsonl'),
        serialize(exactTurn('old private text'))
      );
      const baseline = await snapshotChatgptSessions(root);
      const content =
        JSON.stringify({
          type: 'response_item',
          payload: { role: 'assistant', content: 'private'.repeat(450_000) },
        }) + '\n';
      for (let i = 0; i < 3; i++)
        await writeFile(join(root, `rollout-new-${i}.jsonl`), content);
      const { metadata, candidatePaths } = await diagnoseChatgptBinding(
        root,
        baseline,
        'prompt',
        options
      );
      expect(metadata).toMatchObject({
        baselineFileCount: 1,
        currentFileCount: 4,
        freshFileCount: 3,
        modifiedBaselineCount: 0,
        truncated: true,
        skippedFileCount: 1,
        nativeUserMessageCount: 0,
        originatorCount: {},
      });
      expect(candidatePaths).toHaveLength(2);
      expect(
        candidatePaths.some((path) => path.endsWith('unchanged.jsonl'))
      ).toBe(false);
      expect(metadata.recordTypes.response_item).toBe(2);
      expect(metadata.nativeUserMessageSha256).toEqual([]);
      expect(JSON.stringify(metadata)).not.toContain('private');
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it('reports a missing root without claiming no execution occurred', async () => {
    const { home, root, options } = await fixture();
    try {
      await rm(root, { recursive: true });
      const { metadata, candidatePaths } = await diagnoseChatgptBinding(
        root,
        new Map(),
        'prompt',
        options
      );
      expect(metadata.rootExists).toBe(false);
      expect(metadata.currentFileCount).toBe(0);
      expect(candidatePaths).toEqual([]);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it('rejects symlinked roots, ancestors, file links, hardlinks, and unexpected roots', async () => {
    const { home, root, options } = await fixture();
    try {
      const outside = join(home, 'private');
      await mkdir(outside);
      const source = join(outside, 'rollout-private.jsonl');
      await writeFile(source, serialize());
      await symlink(source, join(root, 'rollout-symlink.jsonl'));
      await link(source, join(root, 'rollout-hardlink.jsonl'));
      await symlink(outside, join(root, '2026'));
      const result = await diagnoseChatgptBinding(
        root,
        new Map(),
        'prompt',
        options
      );
      expect(result.candidatePaths).toEqual([]);
      expect(result.metadata.skippedFileCount).toBe(1);
      const wrongRoot = await diagnoseChatgptBinding(
        outside,
        new Map(),
        'prompt',
        options
      );
      expect(wrongRoot.metadata.metadataRead).toBe('unavailable');
      expect(wrongRoot.candidatePaths).toEqual([]);
      await rm(join(home, '.codex'), { recursive: true });
      await symlink(outside, join(home, '.codex'));
      const linkedRoot = await diagnoseChatgptBinding(
        root,
        new Map(),
        'prompt',
        options
      );
      expect(linkedRoot.metadata.metadataRead).toBe('unavailable');
      expect(linkedRoot.candidatePaths).toEqual([]);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it('caps files, file bytes and hashes; emits only allowlisted labels for poisoned records', async () => {
    const { home, root, options } = await fixture();
    try {
      const records = [
        event('session_meta', { originator: '__proto__' }),
        event('PRIVATE secret type', {}),
      ];
      for (let i = 0; i < 80; i++)
        records.push(exactTurn(`secret-${i}`, `turn-${i}`)[2]!);
      const content =
        records.map((record) => JSON.stringify(record)).join('\n') +
        '\nBAD\n{"unfinished":';
      await writeFile(join(root, 'rollout-00.jsonl'), content);
      await writeFile(
        join(root, 'rollout-01-big.jsonl'),
        'x'.repeat(4 * 1024 * 1024 + 1)
      );
      for (let i = 2; i < 20; i++)
        await writeFile(join(root, `rollout-${i}.jsonl`), serialize([]));
      const { metadata, candidatePaths } = await diagnoseChatgptBinding(
        root,
        new Map(),
        'prompt',
        options
      );
      expect(metadata.truncated).toBe(true);
      expect(metadata.skippedFileCount).toBeGreaterThanOrEqual(4);
      expect(candidatePaths.length).toBeLessThanOrEqual(16);
      expect(candidatePaths.some((path) => path.endsWith('big.jsonl'))).toBe(
        false
      );
      expect(metadata.nativeUserMessageSha256).toHaveLength(64);
      expect(metadata.nativeUserMessageCount).toBe(80);
      expect(metadata.recordTypes.other).toBe(1);
      expect(metadata.originatorCount.other).toBe(1);
      expect(metadata.malformedRecordCount).toBe(1);
      expect(JSON.stringify(metadata)).not.toContain('secret-');
      expect(JSON.stringify(metadata)).not.toContain('__proto__');
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
});
