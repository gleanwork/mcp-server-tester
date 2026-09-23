import {
  appendFile,
  mkdtemp,
  mkdir,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
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
  it('accepts the Linux native Markdown-escaped form of the exact prompt only', () => {
    const linux = { nativeMarkdownEscapes: true };
    // Observed on Linux ChatGPT Work 26.915.31945.
    const prompt = 'run text(ALL_TOOLS.filter(t => /glean/i.test(t.name)))';
    const stored = 'run text(ALL\\_TOOLS.filter(t => /glean/i.test(t.name)))\n';
    const trace = parseChatgptTrace(
      serialize(exactTurn(stored)),
      exact(prompt),
      0,
      Infinity,
      linux
    )!;
    expect(trace.promptMatch).toBe('native_markdown_escaped');
    // macOS (default policy) stays strict.
    expect(
      parseChatgptTrace(serialize(exactTurn(stored)), exact(prompt))
    ).toBeUndefined();
    expect(trace.nativePromptSha256).toBe(
      createHash('sha256').update(stored).digest('hex')
    );
    for (const other of [
      'run text(ALL\\_TOOLS.filter(t => /glean/i.test(t.names)))',
      'run text(ALL\\TOOLS.filter(t => /glean/i.test(t.name)))',
      'run text(ALL\\_TOOLS.filter(t => /glean/i.test(t.name)))\n\n',
    ])
      expect(
        parseChatgptTrace(
          serialize(exactTurn(other)),
          exact(prompt),
          0,
          Infinity,
          linux
        )
      ).toBeUndefined();
    // A literal backslash in the prompt must be stored escaped, not bare.
    expect(
      parseChatgptTrace(
        serialize(exactTurn('a\\\\b')),
        exact('a\\b'),
        0,
        Infinity,
        linux
      )?.promptMatch
    ).toBe('native_markdown_escaped');
  });

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

  describe('native rewrite of a truncated record under the same ordinal', () => {
    // Observed on Linux ChatGPT Work 26.915.31945: a truncated record, then the
    // same record complete with the ordinal the truncated one would have had.
    const numbered = () =>
      serialize()
        .trimEnd()
        .split('\n')
        .map((line, ordinal) =>
          JSON.stringify({ ...JSON.parse(line), ordinal })
        );
    const truncate = (line: string) =>
      line.slice(0, Math.floor(line.length / 2));

    it('uses the rewritten record and records a limitation', () => {
      const lines = numbered();
      lines.splice(4, 0, truncate(lines[4]!));
      const trace = parseChatgptTrace(lines.join('\n') + '\n', marker);
      expect(trace?.complete).toBe(true);
      expect(trace?.limitations).toContain(
        '1 truncated native record(s) were rewritten by the host under the same ordinal; the rewritten record was used.'
      );
    });

    it.each([
      [
        'the next record skips an ordinal',
        (l: string[]) => l.splice(4, 1, truncate(l[4]!)),
      ],
      [
        'two malformed records in a row',
        (l: string[]) => l.splice(4, 0, '{bad', '{bad'),
      ],
      ['the first record', (l: string[]) => l.splice(0, 0, '{bad')],
      ['the last complete record', (l: string[]) => l.push('{bad')],
    ])('fails closed when the malformed line is followed by %s', (_, edit) => {
      const lines = numbered();
      edit(lines);
      expect(() => parseChatgptTrace(lines.join('\n') + '\n', marker)).toThrow(
        'Malformed complete JSONL record'
      );
    });
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

/**
 * Redacted synthetic records with the observed native shapes of package
 * 26.915.31945: response_item function_call / custom_tool_call pairs,
 * token_usage_record, and task_complete. No McpToolCall item is emitted.
 */
describe('ChatGPT native response_item tool calls', () => {
  const T = 'native-turn';
  const base = 1_790_000_000; // epoch seconds, as in create_time
  const meta = (at: number, extra: Record<string, unknown> = {}) => ({
    internal_chat_message_metadata_passthrough: {
      turn_id: T,
      create_time: base + at,
      ...extra,
    },
  });
  const at = (seconds: number) => (base + seconds) * 1000;
  function nativeTurn(body: Array<ReturnType<typeof event>>, done = true) {
    return [
      event('event_msg', { type: 'task_started', turn_id: T }, at(0)),
      event('turn_context', { turn_id: T, model: 'gpt-test', effort: 'low' }),
      event(
        'event_msg',
        {
          type: 'item_completed',
          turn_id: T,
          item: {
            type: 'UserMessage',
            id: 'user',
            content: [{ type: 'text', text: 'Find docs.\n' }],
          },
        },
        at(0)
      ),
      ...body,
      event(
        'token_usage_record',
        {
          turn_id: T,
          response_id: 'resp-1',
          usage: { input_tokens: 100, output_tokens: 10 },
          turn_token_usage: {
            input_tokens: 100,
            cached_input_tokens: 40,
            cache_write_input_tokens: 0,
            output_tokens: 10,
            reasoning_output_tokens: 3,
            total_tokens: 110,
          },
          thread_token_usage: { input_tokens: 9999, output_tokens: 999 },
        },
        at(4)
      ),
      ...(done
        ? [
            event(
              'event_msg',
              {
                type: 'task_complete',
                turn_id: T,
                last_agent_message: 'answer',
                started_at: base,
                completed_at: base + 5,
                duration_ms: 5000,
                time_to_first_token_ms: 300,
              },
              at(5)
            ),
          ]
        : []),
    ];
  }
  const parse = (
    records: Array<ReturnType<typeof event>>,
    surface: 'chatgpt-work' | 'codex' = 'chatgpt-work'
  ) =>
    parseChatgptTrace(
      serialize(
        records,
        'session',
        surface === 'codex' ? 'Codex Desktop' : 'codex_work_desktop'
      ),
      exact('Find docs.'),
      0,
      Infinity,
      { surface, mcpServers: ['glean-eval'] }
    )!;
  function execCall(callId: string, input: string, t0: number, t1?: number) {
    return [
      event(
        'response_item',
        {
          type: 'custom_tool_call',
          id: `ctc_${callId}`,
          status: 'completed',
          call_id: callId,
          name: 'exec',
          input,
          ...meta(t0),
        },
        at(t0)
      ),
      ...(t1 === undefined
        ? []
        : [
            event(
              'response_item',
              {
                type: 'custom_tool_call_output',
                id: `ctco_${callId}`,
                call_id: callId,
                output: [{ type: 'input_text', text: 'redacted output' }],
                ...meta(t1),
              },
              at(t1)
            ),
          ]),
    ];
  }

  it('records Work web search through exec plus its Extension item as host tools', () => {
    const input = 'const r = await tools.web__run({ q: "redacted" }); r';
    const trace = parse(
      nativeTurn([
        execCall('call_web', input, 1, 2).at(0)!,
        event(
          'event_msg',
          {
            type: 'item_completed',
            turn_id: T,
            item: {
              type: 'Extension',
              kind: 'web.search',
              id: 'exec-web-1',
              query: 'redacted',
              action: { type: 'search', query: null, queries: ['redacted'] },
              results: null,
            },
            started_at_ms: at(1.2),
            completed_at_ms: at(1.8),
          },
          at(1.8)
        ),
        execCall('call_web', input, 1, 2).at(1)!,
      ])
    );
    expect(trace.toolCalls).toMatchObject([
      {
        source: 'host',
        name: 'exec',
        rawName: 'exec',
        durationMs: 1000,
        arguments: {
          nestedTools: ['web__run'],
          inputLength: input.length,
          inputSha256: createHash('sha256').update(input).digest('hex'),
        },
      },
      { source: 'host', name: 'web.search', rawName: 'Extension.web.search' },
    ]);
    expect(JSON.stringify(trace.toolCalls)).not.toContain('await tools');
    expect(trace.telemetry).toMatchObject({
      toolCallCount: 2,
      mcpToolCallCount: 0,
      hostToolCallCount: 2,
      toolWallDurationMs: 1000,
    });
    expect(trace.telemetry.partial).toBeUndefined();
    expect(trace.usage).toMatchObject({
      inputTokens: 100,
      outputTokens: 10,
      cacheReadInputTokens: 40,
      reasoningOutputTokens: 3,
      durationMs: 5000,
    });
  });

  it('keeps Work exec_command under the host exec call', () => {
    const trace = parse(
      nativeTurn(execCall('call_sh', 'await tools.exec_command({})', 1, 3))
    );
    expect(trace.toolCalls).toEqual([
      expect.objectContaining({
        source: 'host',
        name: 'exec',
        arguments: expect.objectContaining({ nestedTools: ['exec_command'] }),
        output: JSON.stringify([
          { type: 'input_text', text: 'redacted output' },
        ]),
      }),
    ]);
    expect(trace.telemetry.mcpToolCallCount).toBe(0);
    expect(trace.limitations.join(' ')).not.toContain('code-mode');
  });

  it('attributes tools.mcp__glean_eval__search inside exec to the configured label', () => {
    const trace = parse(
      nativeTurn(
        execCall(
          'call_mcp',
          'await tools.mcp__glean_eval__search({ query: "x" }); await tools.web__run({})',
          1,
          2
        )
      )
    );
    expect(trace.toolCalls).toMatchObject([
      {
        source: 'host',
        name: 'exec',
        arguments: { nestedTools: ['web__run'] },
      },
      {
        source: 'mcp',
        server: 'glean-eval',
        name: 'search',
        rawName: 'exec:mcp__glean_eval__search',
        arguments: {},
      },
    ]);
    expect(trace.toolCalls[1]!.durationMs).toBeUndefined();
    expect(trace.telemetry).toMatchObject({
      mcpToolCallCount: 1,
      hostToolCallCount: 1,
      toolWallDurationMs: 1000,
      toolProvenance: [
        { id: 'call_mcp', source: 'host' },
        { id: 'call_mcp#1', source: 'mcp', viaCodeMode: true },
      ],
    });
    expect(trace.mcpDurationMs).toBeUndefined();
    expect(trace.limitations.join(' ')).toContain('code-mode exec runner');
  });

  it('counts a native McpToolCall item once, not again as an exec reference', () => {
    // Observed on Linux ChatGPT Work 26.915.31945: exec references the tool and
    // the host also records a timed McpToolCall item for the same call.
    const trace = parse(
      nativeTurn([
        ...execCall(
          'call_mcp',
          'await tools.mcp__glean_eval__search({ query: "x" })',
          1,
          3
        ),
        event(
          'event_msg',
          {
            type: 'item_completed',
            turn_id: T,
            item: {
              type: 'McpToolCall',
              id: 'mcp-item-1',
              server: 'glean-eval',
              tool: 'search',
              arguments: { query: 'x' },
              status: 'completed',
              result: { content: [] },
            },
            started_at_ms: at(1.5),
            completed_at_ms: at(2.5),
          },
          at(2.5)
        ),
      ])
    );
    expect(
      trace.toolCalls.map((call) => [call.source, call.server, call.name])
    ).toEqual([
      ['host', undefined, 'exec'],
      ['mcp', 'glean-eval', 'search'],
    ]);
    expect(trace.toolCalls[1]!.durationMs).toBe(1000);
    expect(trace.telemetry.mcpToolCallCount).toBe(1);
    expect(trace.limitations.join(' ')).not.toContain('code-mode exec runner');
  });

  it('uses executed_tool_calls for nested exec arguments and counts', () => {
    const records = nativeTurn(execCall('call_mcp', 'code', 1, 2));
    const output = records.find(
      (record) => record.payload.type === 'custom_tool_call_output'
    )!;
    Object.assign(output.payload, {
      ...meta(2, {
        executed_tool_calls: [
          { name: 'mcp__glean_eval__search', arguments: { query: 'a' } },
          { name: 'mcp__glean_eval__search', arguments: { query: 'b' } },
        ],
        tool_calls_complete: true,
      }),
    });
    const trace = parse(records);
    expect(
      trace.toolCalls.filter((call) => call.source === 'mcp')
    ).toMatchObject([
      { server: 'glean-eval', name: 'search', arguments: { query: 'a' } },
      { server: 'glean-eval', name: 'search', arguments: { query: 'b' } },
    ]);
  });

  it('attributes a Codex direct mcp__glean_eval function call to the configured label', () => {
    const records = nativeTurn([
      event(
        'response_item',
        {
          type: 'function_call',
          id: 'fc_1',
          name: 'search',
          namespace: 'mcp__glean_eval',
          arguments: '{"query":"redacted"}',
          call_id: 'call_fc',
          ...meta(1),
        },
        at(1)
      ),
      event(
        'response_item',
        {
          type: 'function_call_output',
          id: 'fco_1',
          call_id: 'call_fc',
          output: 'redacted',
          ...meta(1.5, {
            executed_tool_calls: [
              {
                name: 'mcp__glean_eval__search',
                arguments: { query: 'redacted' },
              },
            ],
            tool_calls_complete: true,
          }),
        },
        at(1.5)
      ),
    ]);
    const trace = parse(records, 'codex');
    expect(trace.toolCalls).toEqual([
      expect.objectContaining({
        source: 'mcp',
        id: 'call_fc',
        server: 'glean-eval',
        name: 'search',
        arguments: { query: 'redacted' },
        output: 'redacted',
        durationMs: 500,
      }),
    ]);
    expect(trace).toMatchObject({ mcpDurationMs: 500, llmDurationMs: 4500 });
    expect(trace.telemetry).toMatchObject({
      mcpToolCallCount: 1,
      mcpWallDurationMs: 500,
      toolProvenance: [
        {
          source: 'mcp',
          nativeServer: 'glean-eval',
          nativeItemType: 'function_call',
        },
      ],
    });
    // Unknown namespaces stay external MCP calls.
    records[3]!.payload.namespace = 'mcp__other';
    (
      records[4]!.payload.internal_chat_message_metadata_passthrough as {
        executed_tool_calls: unknown;
      }
    ).executed_tool_calls = [];
    expect(parse(records, 'codex').toolCalls[0]).toMatchObject({
      source: 'mcp',
      server: 'other',
    });
    // Disagreeing native confirmation fails closed.
    (
      records[4]!.payload.internal_chat_message_metadata_passthrough as {
        executed_tool_calls: unknown;
      }
    ).executed_tool_calls = [{ name: 'mcp__glean_eval__search' }];
    expect(() => parse(records, 'codex')).toThrow('Malformed native MCP');
  });

  it('does not double count a function call also reported as an McpToolCall item', () => {
    const trace = parse(
      nativeTurn([
        event('response_item', {
          type: 'function_call',
          id: 'fc_1',
          name: 'search',
          namespace: 'mcp__glean_eval',
          arguments: '{}',
          call_id: 'shared',
          ...meta(1),
        }),
        event('event_msg', {
          type: 'item_completed',
          turn_id: T,
          item: {
            type: 'McpToolCall',
            id: 'shared',
            server: 'glean-eval',
            tool: 'search',
            arguments: {},
            result: { content: [] },
            status: 'completed',
          },
        }),
      ])
    );
    expect(trace.toolCalls).toHaveLength(1);
    expect(trace.telemetry.toolProvenance?.[0]?.nativeItemType).toBe(
      'McpToolCall'
    );
  });

  it('keeps direct cua_repl calls as host tools even when a label impersonates it', () => {
    const records = nativeTurn([
      event('response_item', {
        type: 'function_call',
        id: 'fc_cua',
        name: 'js',
        namespace: 'mcp__cua_repl',
        arguments: '{"code":"redacted"}',
        call_id: 'call_cua',
        ...meta(1),
      }),
      event('response_item', {
        type: 'function_call_output',
        id: 'fco_cua',
        call_id: 'call_cua',
        output: 'ok',
        ...meta(2, {
          executed_tool_calls: [{ name: 'mcp__cua_repl__js', arguments: {} }],
          tool_calls_complete: true,
        }),
      }),
    ]);
    const trace = parseChatgptTrace(
      serialize(records),
      exact('Find docs.'),
      0,
      Infinity,
      { mcpServers: ['cua_repl'] }
    )!;
    expect(trace.toolCalls).toEqual([
      expect.objectContaining({
        source: 'host',
        server: 'cua_repl',
        name: 'js',
        rawName: 'cua_repl.js',
        durationMs: 1000,
      }),
    ]);
    expect(trace.telemetry).toMatchObject({
      mcpToolCallCount: 0,
      hostToolCallCount: 1,
    });
  });

  it('returns partial calls and usage for a turn that timed out mid-call', () => {
    const trace = parse(
      nativeTurn(
        [
          ...execCall('call_1', 'await tools.exec_command({})', 1, 2),
          ...execCall('call_2', 'await tools.mcp__glean_eval__search({})', 3),
        ],
        false
      )
    );
    expect(trace.complete).toBe(false);
    expect(trace.response).toBeUndefined();
    expect(trace.toolCalls.map((call) => [call.id, call.source])).toEqual([
      ['call_1', 'host'],
      ['call_2', 'host'],
      ['call_2#1', 'mcp'],
    ]);
    expect(trace.toolCalls[1]!.output).toBeUndefined();
    expect(trace.telemetry).toMatchObject({
      partial: true,
      resultCount: 0,
      toolCallCount: 3,
      mcpToolCallCount: 1,
      hostToolCallCount: 2,
      inputTokens: 100,
      outputTokens: 10,
    });
    expect(trace.telemetry.toolProvenance?.[1]).toMatchObject({
      id: 'call_2',
      pending: true,
    });
    // Elapsed native time so far (task_started to last record), not a turn total.
    expect(trace.usage).toMatchObject({
      inputTokens: 100,
      outputTokens: 10,
      durationMs: 4000,
    });
    expect(trace.limitations).toEqual(
      expect.arrayContaining([
        'Turn did not complete; tool calls and usage are partial.',
        'Some native tool calls have no recorded output and are pending.',
      ])
    );
  });
});
