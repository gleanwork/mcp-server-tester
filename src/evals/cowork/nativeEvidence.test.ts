import { setTimeout as delay } from 'node:timers/promises';
import { describe, expect, it } from 'vitest';
import { createCoworkNativeEvidence } from './nativeEvidence.js';
import {
  emitSession,
  endTurn,
  nativeFixture,
  type NativeRecord,
  prompt,
  result,
  tool,
} from './nativeFixtures.testSupport.js';

describe('Cowork native evidence (synthetic files, shared native collector)', () => {
  it('preserves transcript order, IDs and server provenance; audit only corroborates', async () => {
    const f = await nativeFixture();
    const a = tool('mcp__fixture__get_eval_nonce', 'a');
    const b = tool('Read', 'b', { path: '/synthetic' });
    await f.emit({
      audit: [prompt(f.expectedPrompt), b, result()],
      transcript: [prompt(f.expectedPrompt), a, b, b, result()],
    });
    const { trace, diagnostics } = await f.collect();
    expect(trace).toEqual({
      finalText: 'NATIVE_NONCE',
      events: [
        {
          kind: 'tool_call',
          source: 'mcp',
          server: 'fixture',
          name: 'mcp__fixture__get_eval_nonce',
          id: 'a',
          arguments: {},
        },
        {
          kind: 'tool_call',
          source: 'host',
          name: 'Read',
          id: 'b',
          arguments: { path: '/synthetic' },
        },
      ],
    });
    expect(diagnostics).toMatchObject({
      complete: true,
      fullPromptConfirmed: true,
      duplicateCallCount: 2,
    });
  });

  it.each([
    ['empty', '', 100, 1000],
    ['whitespace', '\n \t\n', 100, 1000],
    ['not-created', null, 100, 1000],
    ['not-created-after-settle', null, 1800, 2500],
  ] as const)(
    'waits for %s transcript evidence after the audit is complete',
    async (_kind, transcript, writeDelayMs, timeoutMs) => {
      const f = await nativeFixture();
      await f.emit({
        audit: [prompt(f.expectedPrompt), tool(), result()],
        transcript,
      });
      const [collected] = await Promise.all([
        f.collect(timeoutMs),
        delay(writeDelayMs).then(() =>
          f.append('transcript', [prompt(f.expectedPrompt), tool(), endTurn()])
        ),
      ]);
      expect(collected.trace.error).toBeUndefined();
      expect(collected.trace.finalText).toBe('NATIVE_NONCE');
      expect(collected.trace.events.map((event) => event.id)).toEqual([
        'call-one',
      ]);
      expect(collected.diagnostics.complete).toBe(true);
    }
  );

  it('waits for a delayed transcript terminal after the audit is complete', async () => {
    const f = await nativeFixture();
    await f.emit({
      audit: [prompt(f.expectedPrompt), tool(), result()],
      transcript: [prompt(f.expectedPrompt), tool()],
    });
    const collecting = f.collect(1000);
    const appending = delay(100).then(() =>
      f.append('transcript', [endTurn()])
    );
    const [collected] = await Promise.all([collecting, appending]);
    expect(collected.trace.error).toBeUndefined();
    expect(collected.trace.finalText).toBe('NATIVE_NONCE');
    expect(collected.trace.events.map((event) => event.id)).toEqual([
      'call-one',
    ]);
    expect(collected.diagnostics.complete).toBe(true);
  });

  it.each(['open-turn', 'empty'] as const)(
    'uses only the remaining budget for %s evidence after waiting for the audit terminal',
    async (kind) => {
      const f = await nativeFixture();
      await f.emit({
        audit: [prompt(f.expectedPrompt), tool()],
        transcript: kind === 'empty' ? [] : [prompt(f.expectedPrompt), tool()],
      });
      let written = false;
      let returnedBeforeWrite = false;
      const collecting = f.collect(1500).then((collected) => {
        returnedBeforeWrite = !written;
        return collected;
      });
      const completingAudit = delay(100).then(() =>
        f.append('audit', [result()])
      );
      // A renewed 1500ms budget after the shared 750ms poll would accept this.
      const completingTranscript = delay(1800).then(async () => {
        written = true;
        await f.append('transcript', [
          ...(kind === 'empty' ? [prompt(f.expectedPrompt), tool()] : []),
          endTurn(),
        ]);
      });
      const [collected] = await Promise.all([
        collecting,
        completingAudit,
        completingTranscript,
      ]);
      expect(collected.trace).toEqual({
        finalText: '',
        events: [],
        error: 'cowork_native:transcript_incomplete',
      });
      expect(collected.diagnostics.complete).toBe(false);
      expect(returnedBeforeWrite).toBe(true);
    }
  );

  it('does not reset the deadline while locating a not-created transcript', async () => {
    const f = await nativeFixture();
    await f.emit({
      audit: [prompt(f.expectedPrompt), tool(), result()],
      transcript: null,
    });
    let written = false;
    let returnedBeforeWrite = false;
    const [collected] = await Promise.all([
      f.collect(1800).then((collected) => {
        returnedBeforeWrite = !written;
        return collected;
      }),
      delay(2100).then(async () => {
        written = true;
        await f.append('transcript', [
          prompt(f.expectedPrompt),
          tool(),
          endTurn(),
        ]);
      }),
    ]);
    expect(collected.trace).toEqual({
      finalText: '',
      events: [],
      error: 'cowork_native:transcript_unavailable',
    });
    expect(collected.diagnostics.complete).toBe(false);
    expect(returnedBeforeWrite).toBe(true);
  });

  it('waits for a delayed audit result when the transcript is already complete', async () => {
    const f = await nativeFixture();
    await f.emit({
      audit: [prompt(f.expectedPrompt), tool()],
      transcript: [prompt(f.expectedPrompt), tool(), result()],
    });
    const [collected] = await Promise.all([
      f.collect(1000),
      delay(100).then(() => f.append('audit', [result()])),
    ]);
    expect(collected.trace.error).toBeUndefined();
    expect(collected.diagnostics.complete).toBe(true);
  });

  it('waits for missing transcript calls without copying audit calls or order', async () => {
    const f = await nativeFixture();
    const a = tool('Read', 'a');
    const b = tool('mcp__fixture__get_eval_nonce', 'b');
    await f.emit({
      audit: [prompt(f.expectedPrompt), a, b, result()],
      transcript: [prompt(f.expectedPrompt)],
    });
    const [collected] = await Promise.all([
      f.collect(1000),
      delay(100).then(() => f.append('transcript', [b, a, endTurn()])),
    ]);
    expect(collected.trace.error).toBeUndefined();
    expect(collected.trace.events.map((event) => event.id)).toEqual(['b', 'a']);
  });

  it.each(['another-turn', 'queue-only', 'replay-only'] as const)(
    'does not borrow a delayed terminal from %s evidence',
    async (kind) => {
      const f = await nativeFixture();
      await f.emit({
        audit: [prompt(f.expectedPrompt), result()],
        transcript:
          kind === 'another-turn'
            ? [prompt(f.expectedPrompt), prompt('another task')]
            : kind === 'queue-only'
              ? [
                  {
                    type: 'queue-operation',
                    operation: 'enqueue',
                    content: f.expectedPrompt,
                  },
                  { type: 'queue-operation', operation: 'dequeue' },
                ]
              : [{ ...prompt(f.expectedPrompt), isReplay: true }],
      });
      const [collected] = await Promise.all([
        f.collect(1000),
        delay(100).then(() => f.append('transcript', [endTurn()])),
      ]);
      expect(collected.trace).toEqual({
        finalText: '',
        events: [],
        error: 'cowork_native:transcript_incomplete',
      });
    }
  );

  it.each([
    ['corrupt-audit', 'audit_malformed'],
    ['wrong-prompt', 'transcript_prompt_mismatch'],
    ['missing-marker', 'transcript_incomplete'],
    ['conflicting-id', 'conflicting_call_id'],
    ['unknown-server', 'unverified_mcp_server'],
    ['invalid-input', 'invalid_tool_event'],
    ['missing-id', 'invalid_tool_event'],
    ['closed-audit', 'terminal_unavailable'],
  ] as const)(
    'fails closed for %s without waiting for a transcript terminal',
    async (kind, failure) => {
      const f = await nativeFixture();
      let audit: NativeRecord[] | string = [
        prompt(f.expectedPrompt),
        tool(),
        result(),
      ];
      let transcript = [prompt(f.expectedPrompt), tool()];
      switch (kind) {
        case 'corrupt-audit':
          audit =
            audit.map((event) => JSON.stringify(event)).join('\n') +
            '\nnot-json-SECRET\n';
          break;
        case 'wrong-prompt':
          transcript[0] = prompt(f.expectedPrompt.replace('exact', 'wrong'));
          break;
        case 'missing-marker':
          transcript[0] = prompt('another task');
          break;
        case 'conflicting-id':
          transcript.push(tool('Read', 'call-one', { path: '/different' }));
          break;
        case 'unknown-server':
          transcript.push(tool('mcp__unverified__Read', 'unverified'));
          break;
        case 'invalid-input':
          transcript.push(tool('Read', 'invalid', []));
          break;
        case 'missing-id':
          transcript.push(tool('Read', ''));
          break;
        case 'closed-audit':
          audit = [prompt(f.expectedPrompt), prompt('another task'), result()];
          transcript = [prompt(f.expectedPrompt)];
          break;
      }
      await f.emit({ audit, transcript });
      let appended = false;
      let returnedBeforeAppend = false;
      const collecting = f.collect(1000).then((collected) => {
        returnedBeforeAppend = !appended;
        return collected;
      });
      const [collected] = await Promise.all([
        collecting,
        delay(200).then(async () => {
          appended = true;
          await f.append('transcript', [endTurn()]);
        }),
      ]);
      expect(collected.trace).toEqual({
        finalText: '',
        events: [],
        error: `cowork_native:${failure}`,
      });
      expect(returnedBeforeAppend).toBe(true);
      expect(JSON.stringify(collected)).not.toContain('SECRET');
    }
  );

  it.each([
    ['malformed', 'transcript_malformed'],
    ['wrong-prompt', 'transcript_prompt_mismatch'],
    ['missing-marker', 'transcript_incomplete'],
    ['conflicting-id', 'conflicting_call_id'],
    ['unknown-server', 'unverified_mcp_server'],
    ['invalid-input', 'invalid_tool_event'],
    ['missing-id', 'invalid_tool_event'],
    ['cross-turn', 'transcript_incomplete'],
  ] as const)(
    'rejects %s evidence that arrives in an initially empty transcript',
    async (kind, failure) => {
      const f = await nativeFixture();
      await f.emit({
        audit: [prompt(f.expectedPrompt), tool(), result()],
        transcript: [],
      });
      const transcript = [prompt(f.expectedPrompt), tool(), endTurn()];
      switch (kind) {
        case 'malformed':
          break;
        case 'wrong-prompt':
          transcript[0] = prompt(f.expectedPrompt.replace('exact', 'wrong'));
          break;
        case 'missing-marker':
          transcript[0] = prompt('another task');
          break;
        case 'conflicting-id':
          transcript[1] = tool('Read', 'call-one', { path: '/different' });
          break;
        case 'unknown-server':
          transcript[1] = tool('mcp__unverified__Read');
          break;
        case 'invalid-input':
          transcript[1] = tool('Read', 'call-one', []);
          break;
        case 'missing-id':
          transcript[1] = tool('Read', '');
          break;
        case 'cross-turn':
          transcript.splice(2, 0, prompt('another task'));
          break;
      }
      const [collected] = await Promise.all([
        f.collect(1000),
        delay(100).then(() =>
          f.append(
            'transcript',
            kind === 'malformed' ? 'not-json-SECRET\n' : transcript
          )
        ),
      ]);
      expect(collected.trace).toEqual({
        finalText: '',
        events: [],
        error: `cowork_native:${failure}`,
      });
      expect(collected.diagnostics.complete).toBe(false);
      expect(JSON.stringify(collected)).not.toContain('SECRET');
    }
  );

  it('ignores queue copies and same-UUID replay copies with different SDK session IDs', async () => {
    const f = await nativeFixture();
    const user = { ...prompt(f.expectedPrompt), session_id: 'ui-session' };
    await f.emit({
      audit: [
        user,
        { ...user, session_id: 'sdk-session', isReplay: true },
        tool(),
        endTurn(),
        result(),
      ],
      transcript: [
        {
          type: 'queue-operation',
          operation: 'enqueue',
          content: f.expectedPrompt,
        },
        { type: 'queue-operation', operation: 'dequeue' },
        user,
        tool(),
        {
          type: 'user',
          message: {
            content: [
              {
                type: 'tool_result',
                tool_use_id: 'call-one',
                content: 'nonce',
              },
            ],
          },
        },
        endTurn(),
      ],
    });
    const { trace, diagnostics } = await f.collect();
    expect(trace.error).toBeUndefined();
    expect(trace.finalText).toBe('NATIVE_NONCE');
    expect(trace.events).toHaveLength(1);
    expect(diagnostics).toMatchObject({
      complete: true,
      requestId: 'native-request',
    });
  });

  it.each(['metadata', 'audit', 'transcript'] as const)(
    'requires full exact prompt confirmation in %s',
    async (location) => {
      const f = await nativeFixture();
      const wrong = f.expectedPrompt.replace('exact', 'wrong');
      await f.emit({
        metadataPrompt: location === 'metadata' ? wrong : f.expectedPrompt,
        audit: [
          prompt(location === 'audit' ? wrong : f.expectedPrompt),
          result(),
        ],
        transcript: [
          prompt(location === 'transcript' ? wrong : f.expectedPrompt),
          result(),
        ],
      });
      const collected = await f.collect();
      expect(collected.trace.error).toContain(`${location}_prompt_mismatch`);
      expect(collected.trace.events).toEqual([]);
    }
  );

  it('returns complete zero-call evidence and retains host execution failure', async () => {
    const f = await nativeFixture();
    const failed = { ...result('native failure'), is_error: true };
    await f.emit({
      audit: [prompt(f.expectedPrompt), failed],
      transcript: [prompt(f.expectedPrompt), failed],
    });
    const collected = await f.collect();
    expect(collected.trace).toEqual({
      finalText: 'native failure',
      events: [],
      error: 'cowork_native:host_run_failed',
    });
    expect(collected.diagnostics.complete).toBe(true);
  });

  it.each(['missing', 'partial', 'malformed', 'other-turn'] as const)(
    'fails closed for %s transcript evidence',
    async (kind) => {
      const f = await nativeFixture();
      await f.emit({
        audit: [prompt(f.expectedPrompt), tool(), result()],
        transcript:
          kind === 'missing'
            ? null
            : kind === 'malformed'
              ? `${JSON.stringify(prompt(f.expectedPrompt))}\nnot-json-SECRET\n${JSON.stringify(result())}\n`
              : [
                  prompt(f.expectedPrompt),
                  tool(),
                  ...(kind === 'other-turn'
                    ? [prompt('another task'), result()]
                    : []),
                ],
      });
      const collected = await f.collect();
      expect(collected.trace.error).toMatch(
        /transcript_(unavailable|malformed|incomplete)/
      );
      expect(collected.diagnostics.complete).toBe(false);
      expect(JSON.stringify(collected)).not.toContain('SECRET');
    }
  );

  it.each([
    'missing-call',
    'conflict',
    'unknown-server',
    'invalid-input',
    'missing-id',
  ] as const)('rejects %s native tool records', async (kind) => {
    const f = await nativeFixture();
    const audit =
      kind === 'missing-call' || kind === 'conflict'
        ? [tool('Read', 'same', { path: '/one' })]
        : [];
    const native =
      kind === 'missing-call'
        ? []
        : kind === 'conflict'
          ? [tool('Read', 'same', { path: '/other' })]
          : kind === 'unknown-server'
            ? [tool('mcp__unverified__Read')]
            : kind === 'missing-id'
              ? [
                  {
                    type: 'assistant',
                    message: { content: [{ type: 'tool_use', name: 'Read' }] },
                  },
                ]
              : [tool('Read', 'bad', ['array'])];
    await f.emit({
      audit: [prompt(f.expectedPrompt), ...audit, result()],
      transcript: [prompt(f.expectedPrompt), ...native, result()],
    });
    expect((await f.collect()).trace.error).toMatch(
      /transcript_missing_call|conflicting_call_id|unverified_mcp_server|invalid_tool_event/
    );
  });

  it('does not borrow a stale audit terminal from metadata or another user turn', async () => {
    const f = await nativeFixture();
    await f.emit({
      audit: [result('stale')],
      transcript: [prompt(f.expectedPrompt), endTurn()],
    });
    expect((await f.collect()).trace.error).toContain('terminal_unavailable');
  });

  it('stops at the correlated terminal and keeps diagnostics free of payloads', async () => {
    const f = await nativeFixture();
    await f.emit({
      audit: [
        prompt(f.expectedPrompt),
        result('SECRET_FINAL'),
        tool('Later', 'later'),
      ],
      transcript: [
        tool('Before', 'before'),
        prompt(f.expectedPrompt),
        tool('Read', 'current', { secret: 'SECRET_ARGS' }),
        result('SECRET_FINAL'),
        prompt('later'),
        tool('After', 'after'),
        result('other task'),
      ],
    });
    const collected = await f.collect();
    expect(collected.trace.finalText).toBe('SECRET_FINAL');
    expect(collected.trace.events.map((e) => e.id)).toEqual(['current']);
    expect(JSON.stringify(collected.diagnostics)).not.toContain('SECRET');
  });

  it('refuses ambiguity and incomplete native execution', async () => {
    const f = await nativeFixture();
    await f.emit();
    await emitSession(f.dataDir, f.expectedPrompt, { id: 'local_other' });
    expect((await f.collect()).trace.error).toContain(
      'ambiguous_matching_sessions'
    );
    const pending = await nativeFixture();
    await pending.emit({
      audit: [prompt(pending.expectedPrompt)],
      transcript: [prompt(pending.expectedPrompt)],
    });
    expect((await pending.collect(10)).trace.error).toContain('timeout');
  });

  it('rejects ambiguous or invalid prefix mappings', () => {
    expect(() =>
      createCoworkNativeEvidence({ mcpServerPrefixes: { Read: 'fixture' } })
    ).toThrow(/prefix/);
    expect(() =>
      createCoworkNativeEvidence({
        mcpServerPrefixes: { mcp__a__: 'a', mcp__a__b__: 'b' },
      })
    ).toThrow(/overlap/);
  });
});
