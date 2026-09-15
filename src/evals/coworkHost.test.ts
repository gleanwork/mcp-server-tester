import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runEvalBatch } from './runEvalBatch.js';
import { COWORK_HOST } from './coworkHost.js';
import { prepareHostBatch } from './prepareHostBatch.js';
import { toCoworkServers } from './coworkSetup/config.js';
import type { ClaudeTrace } from './externalHost/builtins/anthropicClaude.js';
import type * as ClaudeNative from './externalHost/builtins/anthropicClaude.js';
import type { HostBatchRequest, HostRunContext } from './evalFrameworkTypes.js';

const mocks = vi.hoisted(() => ({
  setup: vi.fn(),
  dispose: vi.fn(),
  submit: vi.fn(),
  hitl: vi.fn(),
  snapshot: vi.fn(),
  trace: vi.fn(),
  order: [] as string[],
}));
vi.mock('./coworkSetup/recoverSession.js', () => ({
  recoverMacCoworkSession: vi.fn(),
}));
vi.mock('./coworkSetup/macSession.js', () => ({
  prepareMacCoworkSession: mocks.setup,
}));
vi.mock('./externalHost/builtins/anthropicComputerUse.js', () => ({
  runAnthropicComputerUseSubmission: mocks.submit,
  runAnthropicComputerUseHitl: mocks.hitl,
}));
vi.mock(
  './externalHost/builtins/anthropicClaude.js',
  async (importOriginal) => ({
    ...(await importOriginal<typeof ClaudeNative>()),
    snapshotClaudeSessions: mocks.snapshot,
    waitForClaudeTrace: mocks.trace,
  })
);
const dirs: string[] = [];
const host = {
  type: 'cowork_cu',
  timeout: 900_000,
  options: { computerUseProvider: 'anthropic-computer-use' },
};
const server = {
  transport: 'http' as const,
  label: 'glean',
  serverUrl: 'https://example.com/mcp/eval',
  auth: { accessTokenEnv: 'GLEAN_API_TOKEN' },
};
const context: HostRunContext = {
  manifest: {
    name: 'cowork',
    datasets: [],
    host,
    servers: [server],
    coworkSetup: { approveWriteTools: true },
  },
  env: {
    ANTHROPIC_API_KEY: 'test-secret-key',
    GLEAN_API_TOKEN: 'test-secret-token',
  },
};
function requests(): HostBatchRequest[] {
  return ['query one', 'query two'].map((scenario, i) => ({
    caseId: `case-${i}`,
    iteration: 0,
    config: host,
    input: { scenario, servers: [server] },
  }));
}
beforeEach(() => {
  vi.clearAllMocks();
  mocks.order.length = 0;
  mocks.setup.mockImplementation(async () => {
    mocks.order.push('setup');
    return { dispose: mocks.dispose };
  });
  mocks.dispose.mockImplementation(async () => {
    mocks.order.push('dispose');
  });
  mocks.snapshot.mockResolvedValue(new Map());
  mocks.submit.mockImplementation(async () => {
    mocks.order.push('submit');
    return { status: 'submitted' };
  });
  mocks.hitl.mockImplementation(async () => {
    mocks.order.push('hitl');
    return { status: 'hitl_checked' };
  });
  let index = 0;
  mocks.trace.mockImplementation(async () => {
    mocks.order.push('trace');
    return {
      candidate: { metadataPath: `/fixture/session-${index++}` },
      finalAnswer: 'answer',
      toolCalls: [
        { name: 'search', arguments: { query: 'test' }, output: 'found' },
      ],
      usage: {
        inputTokens: 10,
        outputTokens: 4,
        totalCostUsd: 0.01,
        durationMs: 200,
        durationApiMs: 150,
        cacheReadInputTokens: 20,
      },
      llmDurationMs: 150,
      isComplete: true,
      telemetry: {
        resultCount: 1,
        apiCallCount: 1,
        toolCallCount: 1,
        toolErrorCount: 0,
        models: ['native-model'],
        totalCostUsd: 0.01,
      },
    } as unknown as ClaudeTrace;
  });
});
afterEach(async () => {
  for (const dir of dirs.splice(0))
    await fs.rm(dir, { recursive: true, force: true });
});

describe('V2 Cowork host', () => {
  it('submits all selected iterations before HITL and native trace collection, then restores', async () => {
    const result = await COWORK_HOST.runBatch!(requests(), context);
    expect(mocks.order).toEqual([
      'setup',
      'submit',
      'submit',
      'hitl',
      'hitl',
      'trace',
      'trace',
      'dispose',
    ]);
    expect(result[0]).toMatchObject({
      finalText: 'answer',
      usage: { inputTokens: 10 },
      telemetry: { source: 'claude-native' },
      llmDurationMs: 150,
    });
    expect(mocks.hitl.mock.calls[0]![0].task).toContain('MCP_SERVER_TESTER_');
    expect(mocks.trace.mock.calls[0]![0].scenario).toBeUndefined(); // marker-only, no ambiguous fallback
    expect(JSON.stringify(result)).not.toContain('test-secret');
  });
  it('never retries an ambiguous submit and cancels later submissions', async () => {
    mocks.submit.mockRejectedValueOnce(new Error('uncertain test-secret-key'));
    const result = await COWORK_HOST.runBatch!(requests(), context);
    expect(mocks.submit).toHaveBeenCalledTimes(1);
    expect(mocks.hitl).not.toHaveBeenCalled();
    expect(result[0]!.error).toContain('[REDACTED]');
    expect(result[1]!.error).toContain('Not submitted');
    expect(mocks.dispose).toHaveBeenCalledOnce();
  });
  it('restores on native trace errors and retains per-case failure', async () => {
    mocks.trace.mockRejectedValueOnce(new Error('native trace timeout'));
    const result = await COWORK_HOST.runBatch!(requests(), context);
    expect(result[0]!.error).toBe('native trace timeout');
    expect(result[1]!.finalText).toBe('answer');
    expect(mocks.dispose).toHaveBeenCalledOnce();
  });
  it('fails closed when restoration fails and releases in-process guard', async () => {
    mocks.dispose.mockRejectedValueOnce(new Error('restore failed'));
    await expect(COWORK_HOST.runBatch!(requests(), context)).rejects.toThrow(
      'restore failed'
    );
    await expect(
      COWORK_HOST.runBatch!(requests(), context)
    ).resolves.toHaveLength(2);
  });
  it('expands iterations once and rejects duplicate IDs before UI', async () => {
    const cases = [
      { id: 'first', mode: 'host' as const, scenario: 'one', iterations: 2 },
      { id: 'second', mode: 'host' as const, scenario: 'two' },
    ];
    const queues = await prepareHostBatch(
      COWORK_HOST,
      cases,
      host,
      [server],
      context
    );
    expect(queues?.get('first')).toHaveLength(2);
    expect(mocks.submit).toHaveBeenCalledTimes(3);
    await expect(
      prepareHostBatch(
        COWORK_HOST,
        [cases[0]!, cases[0]!],
        host,
        [server],
        context
      )
    ).rejects.toThrow('unique');
    expect(mocks.submit).toHaveBeenCalledTimes(3);
  });
  it('runs the actual V2 batch evaluator and persists native metrics and failures', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cowork-v2-'));
    dirs.push(dir);
    await fs.writeFile(
      path.join(dir, 'cases.json'),
      JSON.stringify({
        name: 'cases',
        cases: [
          {
            id: 'one',
            mode: 'host',
            scenario: 'one',
            expect: { toolCallCount: { min: 1 } },
          },
          {
            id: 'two',
            mode: 'host',
            scenario: 'two',
            expect: { toolCallCount: { min: 2 } },
          },
          { id: 'excluded', mode: 'host', scenario: 'excluded' },
        ],
      })
    );
    const manifestPath = path.join(dir, 'manifest.json');
    await fs.writeFile(
      manifestPath,
      JSON.stringify({
        ...context.manifest,
        maxCases: 2,
        datasets: [{ type: 'file', path: './cases.json' }],
      })
    );
    const secretsFile = path.join(dir, 'test-env.json');
    await fs.writeFile(secretsFile, JSON.stringify(context.env));
    const batch = await runEvalBatch({
      manifestPaths: [manifestPath],
      rootDir: dir,
      secretsFile,
      outputRoot: path.join(dir, 'out'),
    });
    expect(batch.items[0]!.error).toBeUndefined();
    const summary = batch.items[0]!.result!.summary;
    expect(summary.results).toHaveLength(2);
    expect(summary.results.map((r) => r.pass)).toEqual([true, false]);
    expect(mocks.submit).toHaveBeenCalledTimes(2);
    expect(summary.telemetry?.totalHostUsage).toMatchObject({
      inputTokens: 20,
      outputTokens: 8,
      totalCostUsd: 0.02,
    });
    const persisted = await fs.readFile(
      path.join(batch.items[0]!.result!.outputDir, 'results.json'),
      'utf8'
    );
    expect(persisted).toContain('claude-native');
    expect(persisted).not.toContain('test-secret');
  });
  it('rejects unsupported authentication instead of casting it to managed HTTP', () => {
    expect(() =>
      toCoworkServers([{ transport: 'stdio', command: 'no' }])
    ).toThrow('HTTP');
    expect(
      toCoworkServers([
        { transport: 'http', serverUrl: 'https://example.com/mcp' },
      ])[0]!.label
    ).toBe('server-1');
  });
});
