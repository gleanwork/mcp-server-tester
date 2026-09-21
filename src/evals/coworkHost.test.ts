import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runEvalBatch } from './runEvalBatch.js';
import { COWORK_HOST, createCoworkHost } from './coworkHost.js';
import { prepareHostBatch } from './prepareHostBatch.js';
import { toCoworkServers } from './coworkSetup/config.js';
import type { ClaudeTrace } from './externalHost/builtins/anthropicClaude.js';
import type * as ClaudeNative from './externalHost/builtins/anthropicClaude.js';
import {
  ComputerUseDriverError,
  ComputerUseHitlBudgetError,
} from './cowork/anthropicComputerUse.js';
import type * as ComputerUse from './cowork/anthropicComputerUse.js';
import type { HostBatchRequest, HostRunContext } from './evalFrameworkTypes.js';

const mocks = vi.hoisted(() => ({
  setup: vi.fn(),
  dispose: vi.fn(),
  submit: vi.fn(),
  hitl: vi.fn(),
  snapshot: vi.fn(),
  trace: vi.fn(),
  matches: vi.fn(),
  bind: vi.fn(),
  order: [] as string[],
  readiness: vi.fn(),
}));
vi.mock('./cowork/pythonRuntime.js', () => ({
  ensureCoworkPython: vi.fn().mockResolvedValue('/fake/python'),
}));
vi.mock('./coworkSetup/recoverSession.js', () => ({
  recoverMacCoworkSession: vi.fn(),
}));
vi.mock('./coworkSetup/macSession.js', () => ({
  prepareMacCoworkSession: mocks.setup,
}));
vi.mock('./cowork/mcpReadiness.js', () => ({
  verifyCoworkMcpServers: mocks.readiness,
}));
vi.mock('./cowork/anthropicComputerUse.js', async (original) => ({
  ...(await original<typeof ComputerUse>()),
  runAnthropicComputerUseSubmission: mocks.submit,
  runAnthropicComputerUseHitl: mocks.hitl,
}));
vi.mock(
  './externalHost/builtins/anthropicClaude.js',
  async (importOriginal) => ({
    ...(await importOriginal<typeof ClaudeNative>()),
    snapshotClaudeSessions: mocks.snapshot,
    waitForClaudeTrace: mocks.trace,
    waitForClaudeSession: mocks.bind,
    findMatchingClaudeSessions: mocks.matches,
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
  vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin');
  vi.clearAllMocks();
  mocks.order.length = 0;
  mocks.readiness.mockResolvedValue([
    { label: 'glean', status: 'connected', toolCount: 22, elapsedMs: 10 },
  ]);
  mocks.setup.mockImplementation(async () => {
    mocks.order.push('setup');
    return { dispose: mocks.dispose };
  });
  mocks.dispose.mockImplementation(async () => {
    mocks.order.push('dispose');
  });
  mocks.snapshot.mockResolvedValue(new Map());
  mocks.matches.mockReset().mockResolvedValue([{ isComplete: false }]);
  mocks.submit.mockImplementation(async () => {
    mocks.order.push('submit');
    return { status: 'submitted' };
  });
  mocks.hitl.mockImplementation(async () => {
    mocks.order.push('hitl');
    return { status: 'hitl_checked' };
  });
  let index = 0;
  mocks.bind.mockReset().mockImplementation(async () => ({
    candidate: { metadataPath: `/fixture/session-${index++}` },
  }));
  mocks.trace.mockImplementation(async ({ sessionPath }) => {
    mocks.order.push('trace');
    return {
      candidate: { metadataPath: sessionPath },
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
        observedAssistantMessageCount: 1,
        observationSource: 'claude-native-audit-and-transcript',
        toolCallCount: 1,
        toolErrorCount: 0,
        models: ['native-model'],
        totalCostUsd: 0.01,
      },
    } as unknown as ClaudeTrace;
  });
});
afterEach(async () => {
  vi.restoreAllMocks();
  for (const dir of dirs.splice(0))
    await fs.rm(dir, { recursive: true, force: true });
});

describe('V2 Cowork host', () => {
  it('selects the semantic Linux driver without requiring a planner API key', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('linux');
    expect(COWORK_HOST.schema.parse({ type: 'cowork' })).toMatchObject({
      options: { computerUseProvider: 'linux-desktop' },
    });
    expect(
      COWORK_HOST.schema.safeParse({
        type: 'cowork',
        options: {
          computerUseProvider: 'linux-desktop',
          computerUseModel: 'unused-model',
        },
      }).success
    ).toBe(false);
    const prepared = createCoworkHost({
      dataDirectory: () => '/prepared/session',
      prepare: mocks.setup,
      recover: vi.fn(),
      submit: mocks.submit,
      handleHitl: mocks.hitl,
    });
    const batch = requests().map((r) => ({
      ...r,
      config: { ...host, options: { computerUseProvider: 'linux-desktop' } },
    }));
    const result = await prepared.runBatch!(batch, { ...context, env: {} });
    expect(result.every((r) => !r.error)).toBe(true);
    expect(mocks.readiness).toHaveBeenCalledWith([server]);
    expect(mocks.submit).toHaveBeenCalledTimes(2);
    expect(mocks.hitl).toHaveBeenCalledWith(
      expect.objectContaining({
        isComplete: expect.any(Function),
        approveWriteTools: true,
      })
    );
  });
  it('rejects a driver/platform mismatch before any desktop action', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('linux');
    await expect(COWORK_HOST.runBatch!(requests(), context)).rejects.toThrow(
      'not supported on linux'
    );
    expect(mocks.setup).not.toHaveBeenCalled();
    expect(mocks.submit).not.toHaveBeenCalled();
  });
  const driverTelemetry: ComputerUse.ComputerUseTelemetry = {
    accounting: 'complete',
    response_models: ['observed-planner'],
    planner_response_count: 2,
    usage: { input_tokens: 40, output_tokens: 5 },
    usage_observation_counts: {
      input_tokens: 2,
      output_tokens: 2,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    },
    duration_ms: 200,
    action_count: 2,
    attempted_action_count: 2,
    executed_action_count: 2,
    refused_action_count: 0,
    cost: { status: 'unavailable' },
  };
  it('retains observed CU accounting separately from native usage and measures case wall time', async () => {
    let now = 1000;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    mocks.setup.mockImplementation(async () => {
      now += 100;
      return {
        dispose: async () => {
          now += 100;
        },
      };
    });
    mocks.submit.mockImplementation(async () => {
      now += 200;
      return { status: 'submitted', telemetry: driverTelemetry };
    });
    mocks.hitl.mockImplementation(async () => {
      now += 300;
      return { status: 'hitl_checked', telemetry: driverTelemetry };
    });
    const result = await COWORK_HOST.runBatch!(requests().slice(0, 1), context);
    expect(result[0]).toMatchObject({
      durationMs: 500,
      usage: { inputTokens: 10, totalCostUsd: 0.01 },
      telemetry: {
        costScope: 'native-inference-only',
        computerUse: {
          submission: { status: 'completed', telemetry: driverTelemetry },
          hitl: { status: 'completed', telemetry: driverTelemetry },
        },
      },
    });
    expect(now).toBe(1700);
  });
  it.each(['submission', 'hitl'] as const)(
    'retains partial %s accounting on driver failure',
    async (stage) => {
      const partial = { ...driverTelemetry, accounting: 'partial' as const };
      (stage === 'submission'
        ? mocks.submit
        : mocks.hitl
      ).mockRejectedValueOnce(
        new ComputerUseDriverError('driver failed', partial)
      );
      const result = await COWORK_HOST.runBatch!(requests(), context);
      expect(result[0]).toMatchObject({
        error: 'driver failed',
        telemetry: {
          computerUse: { [stage]: { status: 'failed', telemetry: partial } },
        },
      });
      if (stage === 'submission') {
        expect(result[1]?.durationMs).toBeUndefined();
        expect(result[1]?.telemetry).toBeUndefined();
        expect(mocks.submit).toHaveBeenCalledOnce();
      }
    }
  );
  it('atomically claims the desktop across asynchronous default-platform resolution', async () => {
    mocks.submit.mockImplementation(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
      return { status: 'submitted' };
    });
    const batch = requests()
      .slice(0, 1)
      .map((r) => ({ ...r, input: { ...r.input, servers: [] } }));
    const results = await Promise.allSettled([
      COWORK_HOST.runBatch!(batch, context),
      COWORK_HOST.runBatch!(batch, context),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([
      'fulfilled',
      'rejected',
    ]);
    const rejected = results.find(
      (r) => r.status === 'rejected'
    ) as PromiseRejectedResult;
    expect(String(rejected.reason)).toContain('already in use');
    expect(mocks.submit).toHaveBeenCalledOnce();
    expect(mocks.setup).not.toHaveBeenCalled();
  });
  it('binds inference and planner models separately and verifies native evidence', async () => {
    const batch = requests().map((r) => ({
      ...r,
      config: {
        ...host,
        model: 'native-model',
        options: { ...host.options, computerUseModel: 'planner-model' },
      },
    }));
    const result = await COWORK_HOST.runBatch!(batch, context);
    expect(result.every((r) => !r.error)).toBe(true);
    expect(mocks.setup).toHaveBeenCalledWith(
      expect.objectContaining({ model: 'native-model' })
    );
    expect(mocks.submit).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ model: 'planner-model' })
    );
    expect(mocks.hitl).toHaveBeenCalledWith(
      expect.objectContaining({ model: 'planner-model' })
    );
    const wrong = batch.map((r) => ({
      ...r,
      config: { ...r.config, model: 'different-model' },
    }));
    const failed = await COWORK_HOST.runBatch!(wrong, context);
    expect(failed[0]!.error).toContain('Cowork model mismatch');
    expect(mocks.dispose).toHaveBeenCalledTimes(2);
  });
  it('serializes marker-free cases, collects native telemetry, then restores', async () => {
    const result = await COWORK_HOST.runBatch!(requests(), context);
    expect(mocks.order).toEqual([
      'setup',
      'submit',
      'hitl',
      'trace',
      'submit',
      'hitl',
      'trace',
      'dispose',
    ]);
    expect(result[0]).toMatchObject({
      finalText: 'answer',
      usage: { inputTokens: 10 },
      telemetry: { source: 'claude-native' },
      llmDurationMs: 150,
    });
    expect(mocks.submit.mock.calls.map((call) => call[0] as string)).toEqual([
      'query one',
      'query two',
    ]);
    expect(mocks.hitl.mock.calls[0]![0].task).not.toContain(
      'MCP_SERVER_TESTER_'
    );
    expect(mocks.trace.mock.calls[0]![0]).toMatchObject({
      exactPrompt: 'query one',
      sessionPath: '/fixture/session-0',
    });
    expect(mocks.snapshot).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(result)).not.toContain('test-secret');
  });
  it.each(['linux', 'win32'] as const)(
    'keeps shared orchestration independent of %s via an injected platform',
    async (platformName) => {
      vi.spyOn(process, 'platform', 'get').mockReturnValue(platformName);
      const prepare = vi.fn().mockResolvedValue({ dispose: mocks.dispose });
      const portable = createCoworkHost({
        dataDirectory: () => '/synthetic/native-data',
        prepare,
        recover: vi.fn(),
        submit: mocks.submit,
        handleHitl: mocks.hitl,
      });
      const result = await portable.runBatch!(requests(), context);
      expect(result).toHaveLength(2);
      expect(result[0]!.finalText).toBe('answer');
      expect(prepare).toHaveBeenCalledOnce();
      expect(mocks.setup).not.toHaveBeenCalled();
    }
  );
  it('skips GUI HITL for already completed native tasks without hiding actual failures', async () => {
    mocks.matches.mockResolvedValue([{ isComplete: true }]);
    const result = await COWORK_HOST.runBatch!(requests(), context);
    expect(mocks.hitl).not.toHaveBeenCalled();
    expect(result.every((r) => r.finalText === 'answer' && !r.error)).toBe(
      true
    );
    expect(mocks.trace).toHaveBeenCalledTimes(2);
  });
  it('refuses HITL when native correlation is ambiguous', async () => {
    mocks.matches.mockResolvedValue([
      { isComplete: true },
      { isComplete: true },
    ]);
    const result = await COWORK_HOST.runBatch!(requests(), context);
    expect(mocks.hitl).not.toHaveBeenCalled();
    expect(result[0]!.error).toContain('Ambiguous');
  });
  it('records exhausted HITL inspection as a warning only when native completion succeeds', async () => {
    mocks.hitl.mockRejectedValue(
      new ComputerUseHitlBudgetError('inspection budget exhausted')
    );
    const result = await COWORK_HOST.runBatch!(requests(), context);
    expect(result[0]).toMatchObject({
      finalText: 'answer',
      telemetry: { hitlWarning: 'inspection budget exhausted' },
    });
    expect(result[0]!.error).toBeUndefined();
    mocks.trace.mockRejectedValueOnce(new Error('native task never completed'));
    const missing = await COWORK_HOST.runBatch!(requests(), context);
    expect(missing[0]!.error).toBe('native task never completed');
  });
  it('does not hide a HITL failure when native response collection succeeds', async () => {
    mocks.hitl.mockRejectedValueOnce(new Error('HITL timed out'));
    const result = await COWORK_HOST.runBatch!(requests(), context);
    expect(result[0]).toMatchObject({
      error: 'HITL timed out',
      finalText: 'answer',
      usage: { inputTokens: 10 },
    });
    expect(result[1]!.error).toBeUndefined();
  });
  it('stops after missing or ambiguous native binding without resubmission or HITL', async () => {
    mocks.bind.mockRejectedValueOnce(
      new Error('Ambiguous exact prompt sessions')
    );
    const result = await COWORK_HOST.runBatch!(requests(), context);
    expect(mocks.submit).toHaveBeenCalledTimes(1);
    expect(mocks.hitl).not.toHaveBeenCalled();
    expect(mocks.trace).not.toHaveBeenCalled();
    expect(result[0]!.error).toContain('Ambiguous');
    expect(result[1]!.error).toContain('Not submitted');
  });
  it('preserves whitespace and Unicode and binds repeated identical prompts to different sessions', async () => {
    const scenario = '  café\n重复 query  ';
    const batch = requests().map((r) => ({
      ...r,
      input: { ...r.input, scenario },
    }));
    await COWORK_HOST.runBatch!(batch, context);
    expect(mocks.submit.mock.calls.map((call) => call[0] as string)).toEqual([
      scenario,
      scenario,
    ]);
    expect(
      mocks.trace.mock.calls.map(
        (call) => (call[0] as { sessionPath: string }).sessionPath
      )
    ).toEqual(['/fixture/session-0', '/fixture/session-1']);
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
