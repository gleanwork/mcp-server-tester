import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, onTestFinished } from 'vitest';
import type { ExternalHostCapabilityContext } from '../types.js';
import {
  CLAUDE_COWORK_DESKTOP_MACOS_DRIVER,
  driverToSlug,
} from '../driverIdentity.js';
import {
  ANTHROPIC_CLAUDE_CAPABILITIES,
  claudeRunState,
} from './anthropicClaude.js';

const MARKER = 'MCP_SERVER_TESTER_CAPABILITIES';

function capability(id: string) {
  const found = ANTHROPIC_CLAUDE_CAPABILITIES.find(
    (candidate) => candidate.id === id
  );
  if (!found) throw new Error(`Unknown Claude capability id: ${id}`);
  return found;
}

function context(dataDir: string): ExternalHostCapabilityContext {
  const driver = CLAUDE_COWORK_DESKTOP_MACOS_DRIVER;
  return {
    config: { driver },
    run: {
      runId: 'run',
      caseId: 'case',
      scenario: 'query',
      submittedScenario: `query [${MARKER}]`,
      marker: MARKER,
      correlation: {
        strategy: 'prompt_marker',
        marker: MARKER,
        includedInPrompt: true,
      },
      timeoutMs: 3_000,
      startedAtMs: Date.now() - 1_000,
    },
    capability: 'trace',
    binding: {
      uses: 'builtin:anthropic.claude.localAgentTrace',
      with: { dataDir },
    },
    state: {
      driver,
      driverSlug: driverToSlug(driver),
      displayName: 'Claude Cowork Desktop',
      capabilitiesUsed: ['trace'],
      data: {},
    },
  };
}

async function writeJsonl(path: string, events: unknown[]): Promise<void> {
  await writeFile(
    path,
    events.map((event) => JSON.stringify(event)).join('\n')
  );
}

/** One completed local-agent session in the current native layout. */
async function writeSession(root: string): Promise<void> {
  const id = 'local_12345678-1234-1234-1234-123456789abc';
  const native = join(root, '12345678');
  const transcript = join(native, '.claude', 'projects', 'fixture');
  await mkdir(transcript, { recursive: true });
  const events = [
    { type: 'user', message: { content: `query [${MARKER}]` } },
    {
      type: 'assistant',
      message: {
        model: 'claude-opus-4-6',
        content: [
          {
            type: 'tool_use',
            name: 'mcp__glean__search',
            id: 'call-1',
            input: {},
          },
        ],
      },
    },
    {
      type: 'result',
      result: 'READY',
      usage: { input_tokens: 5, output_tokens: 2 },
    },
  ];
  await writeFile(
    join(root, `${id}.json`),
    JSON.stringify({
      sessionId: id,
      cliSessionId: 'native-cli',
      initialMessage: `query [${MARKER}]`,
      createdAt: Date.now(),
      cwd: join(root, '12345678', 'outputs'),
    })
  );
  await writeJsonl(join(native, 'audit.jsonl'), events);
  await writeJsonl(join(transcript, 'native-cli.jsonl'), events);
}

describe('Claude local-agent capabilities share one typed run state', () => {
  it('snapshots, captures and normalizes a fresh session through the typed state', async () => {
    const root = await mkdtemp(join(tmpdir(), 'claude-capabilities-'));
    onTestFinished(() => rm(root, { recursive: true, force: true }));
    const trace = capability('builtin:anthropic.claude.localAgentTrace');
    const normalize = capability(
      'builtin:anthropic.claude.localAgentNormalize'
    );
    const ctx = context(root);

    await expect(trace.setup!(ctx)).resolves.toBeUndefined();
    const runState = claudeRunState(ctx.state);
    expect(runState.dataDir).toBe(root);
    expect(runState.snapshot).toBeInstanceOf(Map);
    expect(runState.snapshot!.size).toBe(0);

    // The session appears after the snapshot, as a submitted run's would.
    await writeSession(root);
    await expect(trace.run!(ctx)).resolves.toBeUndefined();
    expect(runState.trace?.finalAnswer).toBe('READY');

    const result = await normalize.run!(ctx);
    expect(result).toMatchObject({ success: true, response: 'READY' });
    // Normalization strips the native MCP prefix (mcp__<server>__).
    expect(result!.toolCalls.map((call) => call.name)).toEqual(['search']);
  });

  it('refuses to capture without a snapshot and to normalize without a trace', async () => {
    const ctx = context('/nonexistent/claude-data');
    const capture = await capability('builtin:anthropic.claude.localAgentTrace')
      .run!(ctx);
    expect(capture).toMatchObject({
      success: false,
      error: 'Claude Cowork trace step requires a session snapshot.',
      externalHost: { failureKind: 'parse_failure' },
    });
    const normalized = await capability(
      'builtin:anthropic.claude.localAgentNormalize'
    ).run!(ctx);
    expect(normalized).toMatchObject({
      success: false,
      error: 'Claude Cowork trace normalization requires a parsed trace.',
      externalHost: { failureKind: 'parse_failure' },
    });
  });
});
