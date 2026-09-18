import { createHash } from 'node:crypto';
import {
  appendFile,
  mkdir,
  mkdtemp,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it, onTestFinished } from 'vitest';
import {
  auditCoworkNativeRun,
  type CoworkNativeAuditIssue,
} from './auditCoworkNativeRun.js';
import { parseClaudeTrace } from './externalHost/builtins/anthropicClaude.js';
import { hostTraceToExecution, simulationToHostTrace } from './hostTrace.js';

const sessionId = 'local_11111111-1111-4111-8111-111111111111';
const cliSessionId = '22222222-2222-4222-8222-222222222222';
const model = 'claude-opus-4-6';
const secret = 'PRIVATE_CONTENT_MUST_NOT_APPEAR';
const attachmentSuffix = `.claude/projects/project/${cliSessionId}/tool-results/search-1.txt`;
const pointer = `/recorded/private/${sessionId}/${attachmentSuffix}`;
type RecordValue = Record<string, unknown>;

async function fixture(
  options: {
    pointer?: string;
    attachment?: boolean;
    modifyResult?: (result: RecordValue) => void;
  } = {}
) {
  const root = await mkdtemp(join(tmpdir(), 'mst-native-audit-test-'));
  onTestFinished(() => rm(root, { recursive: true, force: true }));
  const nativeRoot = join(root, 'native');
  const sessionDir = join(nativeRoot, sessionId);
  await mkdir(sessionDir, { recursive: true });
  const metadata = {
    sessionId,
    cliSessionId,
    initialMessage: `prompt ${secret}`,
  };
  const metadataPath = join(sessionDir, `${sessionId}.json`);
  await writeFile(metadataPath, JSON.stringify(metadata));
  const result: RecordValue = {
    type: 'result',
    result: `answer ${secret}`,
    request_id: 'request-1',
    is_error: false,
    model,
    duration_ms: 500,
    duration_api_ms: 400,
    total_cost_usd: 0.25,
    usage: {
      input_tokens: 10,
      output_tokens: 20,
      cache_read_input_tokens: 30,
      cache_creation_input_tokens: 40,
    },
  };
  options.modifyResult?.(result);
  const events: RecordValue[] = [
    {
      type: 'assistant',
      message: {
        id: 'message-1',
        model,
        content: [
          {
            type: 'tool_use',
            id: 'tool-1',
            name: 'mcp__glean__search',
            input: { query: secret },
          },
          {
            type: 'tool_use',
            id: 'tool-2',
            name: 'Read',
            input: { path: 'safe' },
          },
        ],
      },
    },
    {
      type: 'user',
      message: {
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'tool-1',
            content: `Output has been saved to ${options.pointer ?? pointer}.`,
            is_error: false,
          },
          {
            type: 'tool_result',
            tool_use_id: 'tool-2',
            content: secret,
            is_error: false,
          },
        ],
      },
    },
    result,
  ];
  const auditPath = join(sessionDir, 'audit.jsonl');
  const transcriptPath = join(sessionDir, `${cliSessionId}.jsonl`);
  const jsonl = events.map((event) => JSON.stringify(event)).join('\n') + '\n';
  await writeFile(auditPath, jsonl);
  await writeFile(transcriptPath, jsonl);
  const attachmentPath = join(sessionDir, attachmentSuffix);
  if (options.attachment !== false) {
    await mkdir(dirname(attachmentPath), { recursive: true });
    await writeFile(attachmentPath, secret);
  }
  const trace = await parseClaudeTrace({
    id: sessionId,
    sessionDir,
    metadataPath,
    metadata,
    statMtimeMs: 0,
  });
  const telemetry: RecordValue = {
    source: 'claude-native',
    costScope: 'native-inference-only',
    ...trace.telemetry,
    nativeSessionId: sessionId,
    correlation: 'exact-initial-prompt',
    computerUse: { durationMs: 999 },
  };
  const replay = hostTraceToExecution(
    {
      ...simulationToHostTrace(
        {
          success: true,
          response: trace.finalAnswer,
          usage: trace.usage,
          toolCalls: trace.toolCalls,
        },
        []
      ),
      telemetry,
      llmDurationMs: trace.llmDurationMs,
    },
    'structured'
  );
  const saved = {
    id: 'case-1',
    pass: true as boolean | null,
    request: { scenario: metadata.initialMessage },
    response: JSON.parse(JSON.stringify(replay.response)) as RecordValue,
    hostUsage: JSON.parse(JSON.stringify(trace.usage)) as RecordValue,
    hostTelemetry: JSON.parse(JSON.stringify(telemetry)) as RecordValue,
    hostEvidence: 'structured',
    expectations: { judge: { pass: true } },
  };
  const raw = {
    schemaVersion: 1,
    results: [saved],
    arms: [{ servers: [], result: { caseResults: [saved] } }],
  };
  const rawResultsPath = join(root, 'raw-results.json');
  async function save() {
    await writeFile(rawResultsPath, JSON.stringify(raw));
  }
  async function audit(expectedCases = 1) {
    await save();
    return auditCoworkNativeRun({
      rawResultsPath,
      nativeRoot,
      expectedCases,
      expectedModel: model,
    });
  }
  return {
    root,
    nativeRoot,
    sessionDir,
    rawResultsPath,
    metadataPath,
    auditPath,
    transcriptPath,
    attachmentPath,
    saved,
    raw,
    save,
    audit,
  };
}
function records(value: unknown): RecordValue[] {
  return value as RecordValue[];
}

describe('auditCoworkNativeRun', () => {
  it('audits more than 1000 cases without treating incomplete evidence as valid', async () => {
    const f = await fixture();
    const cases = Array.from({ length: 1001 }, (_, index) => ({
      ...f.saved,
      id: `case-${index + 1}`,
      response: {},
      hostTelemetry: {},
    }));
    f.raw.results = cases;
    f.raw.arms = [{ servers: [], result: { caseResults: cases } }];
    const report = await f.audit(1001);
    expect(report.expectedCases).toBe(1001);
    expect(report.observedCases).toBe(1001);
    expect(report.cases).toHaveLength(1001);
    expect(report.issues).not.toContain('INVALID_OPTIONS');
    expect(report.issues).not.toContain('INVALID_RESULTS');
    expect(report.issues).not.toContain('CASE_COUNT_MISMATCH');
    expect(report.evidencePassed).toBe(false);
    expect(report.cases.every((entry) => !entry.evidencePassed)).toBe(true);
  });

  it('still rejects a truncated run when more than 1000 cases were expected', async () => {
    const report = await (await fixture()).audit(1001);
    expect(report.issues).toContain('CASE_COUNT_MISMATCH');
    expect(report.issues).not.toContain('INVALID_OPTIONS');
    expect(report.evidencePassed).toBe(false);
  });

  it('replays the native parser and normalizers, hashes attachments, and returns no content or paths', async () => {
    const f = await fixture();
    const report = await f.audit();
    expect(report).toMatchObject({
      schemaVersion: 1,
      expectedCases: 1,
      observedCases: 1,
      qualityPassed: true,
      evidencePassed: true,
      status: 'verified',
      issues: [],
    });
    expect(report.cases[0]).toMatchObject({
      id: 'case-1',
      pass: true,
      sessionId,
      model,
      evidencePassed: true,
      toolCounts: { total: 2, mcp: 1, host: 1, errors: 0 },
      validity: {
        auditParsed: true,
        transcriptParsed: true,
        complete: true,
        nonError: true,
        hasUsage: true,
        hasCost: true,
        noWarnings: true,
      },
      attachments: [
        {
          toolCallIndex: 0,
          valid: true,
          sizeBytes: Buffer.byteLength(secret),
          sha256: createHash('sha256').update(secret).digest('hex'),
          issues: [],
        },
      ],
    });
    expect(report.totals).toEqual({
      costScope: 'native-inference-only',
      inputTokens: 10,
      outputTokens: 20,
      cacheReadInputTokens: 30,
      cacheCreationInputTokens: 40,
      totalCostUsd: 0.25,
      durationMs: 500,
      durationApiMs: 400,
    });
    const text = JSON.stringify(report);
    for (const privateText of [secret, pointer, f.root, 'request-1', 'search'])
      expect(text).not.toContain(privateText);
  });

  it('keeps failed judge quality separate from verified evidence', async () => {
    const f = await fixture();
    f.saved.pass = false;
    f.saved.expectations.judge.pass = false;
    expect(await f.audit()).toMatchObject({
      qualityPassed: false,
      evidencePassed: true,
      status: 'verified',
      cases: [{ pass: false, issues: [] }],
    });
  });

  it('keeps unknown quality null and pseudonymizes arbitrary case IDs', async () => {
    const f = await fixture();
    f.saved.pass = null;
    f.saved.id = secret;
    const report = await f.audit();
    expect(report.qualityPassed).toBeNull();
    expect(report.evidencePassed).toBe(true);
    expect(report.cases[0]?.id).toMatch(/^case-[0-9a-f]{16}$/);
    expect(JSON.stringify(report)).not.toContain(secret);
  });

  const tampering: [
    string,
    (saved: Awaited<ReturnType<typeof fixture>>['saved']) => void,
    CoworkNativeAuditIssue,
  ][] = [
    [
      'prompt',
      (saved) => {
        saved.request.scenario += 'tampered';
      },
      'PROMPT_MISMATCH',
    ],
    [
      'final',
      (saved) => {
        saved.response.response = 'tampered';
      },
      'FINAL_RESPONSE_MISMATCH',
    ],
    [
      'usage',
      (saved) => {
        saved.hostUsage.inputTokens = 999;
      },
      'USAGE_MISMATCH',
    ],
    [
      'response usage',
      (saved) => {
        (saved.response.usage as RecordValue).outputTokens = 999;
      },
      'USAGE_MISMATCH',
    ],
    [
      'cost',
      (saved) => {
        saved.hostTelemetry.totalCostUsd = 999;
      },
      'TELEMETRY_MISMATCH',
    ],
    [
      'cache',
      (saved) => {
        saved.hostTelemetry.cacheReadInputTokens = 999;
      },
      'TELEMETRY_MISMATCH',
    ],
    [
      'native duration',
      (saved) => {
        saved.hostTelemetry.durationMs = 999;
      },
      'TELEMETRY_MISMATCH',
    ],
    [
      'API duration',
      (saved) => {
        saved.response.llmDurationMs = 999;
      },
      'TIMING_MISMATCH',
    ],
    [
      'tools',
      (saved) => {
        records(saved.response.toolCalls)[0]!.arguments = { tampered: true };
      },
      'TOOL_CALLS_MISMATCH',
    ],
    [
      'events',
      (saved) => {
        records(saved.response.events)[0]!.output = 'tampered';
      },
      'EVENTS_MISMATCH',
    ],
    [
      'order',
      (saved) => {
        records(saved.response.events).reverse();
      },
      'EVENTS_MISMATCH',
    ],
    [
      'provenance',
      (saved) => {
        records(saved.response.events)[0]!.source = 'host';
      },
      'EVENTS_MISMATCH',
    ],
    [
      'response telemetry',
      (saved) => {
        (saved.response.telemetry as RecordValue).toolCallCount = 999;
      },
      'TELEMETRY_MISMATCH',
    ],
    [
      'evidence flags',
      (saved) => {
        saved.response.success = false;
      },
      'EVIDENCE_FLAGS_MISMATCH',
    ],
    [
      'unrecognized telemetry',
      (saved) => {
        saved.hostTelemetry.unrecognized = secret;
      },
      'TELEMETRY_MISMATCH',
    ],
  ];
  it.each(tampering)('rejects tampered %s', async (_name, mutate, code) => {
    const f = await fixture();
    mutate(f.saved);
    const report = await f.audit();
    expect(report.evidencePassed).toBe(false);
    expect(report.qualityPassed).toBe(true);
    expect(report.cases[0]?.issues).toContain(code);
    expect(report.totals).toBeNull();
    expect(JSON.stringify(report)).not.toContain(secret);
  });

  it('excludes live computer-use telemetry from replay equality', async () => {
    const f = await fixture();
    f.saved.hostTelemetry.computerUse = { arbitraryDriverDuration: 12345 };
    expect((await f.audit()).evidencePassed).toBe(true);
  });

  it('rejects missing cases and empty runs', async () => {
    const f = await fixture();
    expect(await f.audit(2)).toMatchObject({
      observedCases: 1,
      evidencePassed: false,
      issues: ['CASE_COUNT_MISMATCH'],
    });
    f.raw.results.length = 0;
    f.raw.arms[0]!.result.caseResults.length = 0;
    expect(await f.audit()).toMatchObject({
      observedCases: 0,
      qualityPassed: null,
      evidencePassed: false,
      issues: ['CASE_COUNT_MISMATCH'],
    });
  });

  it('rejects duplicate case IDs and native sessions on every affected case', async () => {
    const f = await fixture();
    f.raw.results.push(f.saved);
    f.raw.arms[0]!.result.caseResults.push(f.saved);
    const report = await f.audit(2);
    for (const entry of report.cases)
      expect(entry.issues).toEqual([
        'DUPLICATE_CASE_ID',
        'DUPLICATE_SESSION_ID',
      ]);
    expect(report.evidencePassed).toBe(false);
  });

  it('rejects inconsistent duplicate result envelopes', async () => {
    const f = await fixture();
    f.raw.arms[0]!.result.caseResults = [];
    expect((await f.audit()).issues).toContain('ARM_RESULTS_MISMATCH');
  });

  it('rejects parser warnings rather than silently accepting recovered JSONL', async () => {
    const f = await fixture();
    await appendFile(f.auditPath, '{"type":');
    const report = await f.audit();
    expect(report.cases[0]?.validity.noWarnings).toBe(false);
    expect(report.cases[0]?.issues).toContain('PARSE_WARNINGS');
  });

  it('rejects native host errors and incomplete traces', async () => {
    const f = await fixture({
      modifyResult: (result) => {
        result.is_error = true;
      },
    });
    expect((await f.audit()).cases[0]?.issues).toContain('NATIVE_ERROR');
    await writeFile(f.auditPath, '{"type":"assistant"}\n');
    await writeFile(f.transcriptPath, '{"type":"assistant"}\n');
    expect((await f.audit()).cases[0]?.issues).toContain('NATIVE_INCOMPLETE');
  });

  it('does not present parser-defaulted unknown usage, cost, cache, or duration as zero', async () => {
    const f = await fixture({
      modifyResult: (result) => {
        delete result.usage;
        delete result.total_cost_usd;
        delete result.duration_api_ms;
      },
    });
    const report = await f.audit();
    expect(report.cases[0]?.usage).toEqual({
      inputTokens: null,
      outputTokens: null,
      cacheReadInputTokens: null,
      cacheCreationInputTokens: null,
      totalCostUsd: null,
    });
    expect(report.cases[0]?.timing?.durationApiMs).toBeNull();
    expect(report.cases[0]?.issues).toEqual(
      expect.arrayContaining([
        'USAGE_UNAVAILABLE',
        'COST_UNAVAILABLE',
        'TIMING_UNAVAILABLE',
      ])
    );
  });

  it('preserves absent cache telemetry as null even for a verified run', async () => {
    const f = await fixture({
      modifyResult: (result) => {
        result.usage = { input_tokens: 10, output_tokens: 20 };
      },
    });
    const report = await f.audit();
    expect(report.evidencePassed).toBe(true);
    expect(report.totals?.cacheReadInputTokens).toBeNull();
    expect(report.totals?.cacheCreationInputTokens).toBeNull();
  });

  it('requires the observed native model rather than a saved claim', async () => {
    const f = await fixture();
    await f.save();
    const report = await auditCoworkNativeRun({
      rawResultsPath: f.rawResultsPath,
      nativeRoot: f.nativeRoot,
      expectedCases: 1,
      expectedModel: 'claude-sonnet-4-6',
    });
    expect(report.cases[0]?.issues).toContain('MODEL_MISMATCH');
  });

  it('reports absent real output files without changing quality', async () => {
    const f = await fixture({ attachment: false });
    expect(await f.audit()).toMatchObject({
      qualityPassed: true,
      evidencePassed: false,
      totals: null,
      cases: [
        {
          issues: ['ATTACHMENT_MISSING'],
          attachments: [{ valid: false, sha256: null, sizeBytes: null }],
        },
      ],
    });
  });

  it.each([
    `/recorded/${sessionId}/../${sessionId}/${attachmentSuffix}`,
    '/etc/passwd',
    `/recorded/local_33333333-3333-4333-8333-333333333333/${attachmentSuffix}`,
    `/recorded/${sessionId}/.env`,
    `/recorded/${sessionId}/%2e%2e/secret.txt`,
    `relative/${sessionId}/${attachmentSuffix}`,
    `/recorded/${sessionId}/${sessionId}/${attachmentSuffix}`,
  ])(
    'rejects unsafe recorded attachment pointer %# without echoing it',
    async (badPointer) => {
      const f = await fixture({ pointer: badPointer });
      const report = await f.audit();
      expect(report.cases[0]?.issues).toContain('ATTACHMENT_UNSAFE');
      expect(JSON.stringify(report)).not.toContain(badPointer);
    }
  );

  it.each([
    'root',
    'raw',
    'session',
    'audit',
    'transcript',
    'attachment',
  ] as const)('rejects %s symlinks', async (target) => {
    const f = await fixture();
    await f.save();
    const source =
      target === 'root'
        ? f.nativeRoot
        : target === 'raw'
          ? f.rawResultsPath
          : target === 'session'
            ? f.sessionDir
            : target === 'audit'
              ? f.auditPath
              : target === 'transcript'
                ? f.transcriptPath
                : f.attachmentPath;
    const backup = join(f.root, `backup-${target}`);
    if (target === 'root' || target === 'session') {
      await mkdir(backup);
      await rm(source, { recursive: true });
    } else {
      await writeFile(backup, secret);
      await rm(source);
    }
    await symlink(backup, source);
    const report = await auditCoworkNativeRun({
      rawResultsPath: f.rawResultsPath,
      nativeRoot: f.nativeRoot,
      expectedCases: 1,
    });
    expect(report.evidencePassed).toBe(false);
    expect([
      ...report.issues,
      ...report.cases.flatMap((entry) => entry.issues),
    ]).toContain('UNSAFE_PATH');
    expect(JSON.stringify(report)).not.toContain(secret);
  });

  it('accepts quoted standard output pointers', async () => {
    const f = await fixture({ pointer: `"${pointer}"` });
    expect((await f.audit()).evidencePassed).toBe(true);
  });

  it('does not ignore malformed output notices or empty attachments', async () => {
    const malformed = await fixture({ pointer: '"' });
    expect((await malformed.audit()).cases[0]?.issues).toContain(
      'ATTACHMENT_UNSAFE'
    );
    const empty = await fixture();
    await writeFile(empty.attachmentPath, '');
    expect((await empty.audit()).cases[0]?.issues).toContain(
      'ATTACHMENT_EMPTY'
    );
  });

  it('rejects session traversal before opening a native file', async () => {
    const f = await fixture();
    f.saved.hostTelemetry.nativeSessionId = '../../private';
    const report = await f.audit();
    expect(report.cases[0]?.sessionId).toBeNull();
    expect(report.cases[0]?.issues).toEqual(['INVALID_SESSION_ID']);
  });

  it('rejects oversized files and malformed envelopes with fixed codes', async () => {
    const f = await fixture();
    await writeFile(f.auditPath, Buffer.alloc(16 * 1024 * 1024 + 1));
    expect((await f.audit()).cases[0]?.issues).toEqual(['INPUT_LIMIT']);
    await writeFile(f.rawResultsPath, secret);
    const report = await auditCoworkNativeRun({
      rawResultsPath: f.rawResultsPath,
      nativeRoot: f.nativeRoot,
      expectedCases: 1,
    });
    expect(report.issues).toEqual(['INPUT_UNREADABLE']);
    expect(JSON.stringify(report)).not.toContain(secret);
  });

  it('returns safe invalid-option reports without echoing invalid models', async () => {
    const report = await auditCoworkNativeRun({
      rawResultsPath: secret,
      nativeRoot: secret,
      expectedCases: 0,
      expectedModel: secret,
    });
    expect(report.issues).toEqual(['INVALID_OPTIONS']);
    expect(JSON.stringify(report)).not.toContain(secret);
  });
});
