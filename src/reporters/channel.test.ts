import { describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type {
  FullConfig,
  Suite,
  TestCase,
  TestResult,
} from '@playwright/test/reporter';
import {
  attachReporterData,
  parseReporterAttachment,
  reporterAttachmentKind,
  type ReporterAttachment,
} from './channel.js';
import MCPReporter from './mcpReporter.js';
import type { EvalCaseResult, MCPEvalRunData } from '../types/reporter.js';

type Attachment = TestResult['attachments'][number];

/** A TestInfo stand-in that keeps what was attached. */
function recorder(): {
  attach: (
    name: string,
    options: { contentType: string; body: string | Buffer }
  ) => Promise<void>;
  attachments: Attachment[];
} {
  const attachments: Attachment[] = [];
  return {
    attachments,
    async attach(name, { contentType, body }) {
      attachments.push({
        name,
        contentType,
        body: typeof body === 'string' ? Buffer.from(body) : body,
      });
    },
  };
}

const caseResult: EvalCaseResult = {
  id: 'weather',
  datasetName: 'dataset',
  toolName: 'get_weather',
  source: 'eval',
  pass: true,
  expectations: {},
  durationMs: 5,
};

const samples: ReporterAttachment[] = [
  { kind: 'evalResults', data: { caseResults: [caseResult] } },
  {
    kind: 'variantExperiment',
    data: { converged: true } as unknown as Extract<
      ReporterAttachment,
      { kind: 'variantExperiment' }
    >['data'],
  },
  {
    kind: 'conformance',
    data: {
      operation: 'conformanceChecks',
      pass: true,
      checks: [{ name: 'server_info_present', pass: true, message: 'ok' }],
      toolCount: 1,
      scope: 'Protocol 2026-07-28',
    },
  },
  {
    kind: 'listTools',
    data: {
      operation: 'listTools',
      toolCount: 1,
      tools: [{ name: 'get_weather', description: 'Weather' }],
    },
  },
  {
    kind: 'toolCall',
    data: {
      operation: 'callTool',
      toolName: 'get_weather',
      args: { city: 'London' },
      result: { content: [] },
      durationMs: 3,
      isError: false,
    },
  },
];

describe('reporter channel', () => {
  it.each(samples)('round-trips $kind', async (sample) => {
    const test = recorder();
    await attachReporterData(test, sample);
    const [attachment] = test.attachments;
    const kind = reporterAttachmentKind(attachment!);
    expect(kind).toBe(sample.kind);
    expect(
      parseReporterAttachment(kind!, attachment!.body!.toString('utf-8'))
    ).toEqual(sample);
  });

  it('names tool calls after the tool', async () => {
    const test = recorder();
    await attachReporterData(test, samples[4]!);
    expect(test.attachments[0]?.name).toBe('mcp-call-get_weather');
  });

  it('ignores attachments that are not MCP JSON', () => {
    expect(
      reporterAttachmentKind({ name: 'screenshot', contentType: 'image/png' })
    ).toBeUndefined();
    expect(
      reporterAttachmentKind({
        name: 'mcp-test-results',
        contentType: 'text/plain',
      })
    ).toBeUndefined();
    expect(
      reporterAttachmentKind({
        name: 'mcp-server-info',
        contentType: 'application/json',
      })
    ).toBeUndefined();
  });

  it('rejects a payload missing what the reporter reads', () => {
    expect(() =>
      parseReporterAttachment('conformance', JSON.stringify({ pass: true }))
    ).toThrow('Invalid conformance attachment: checks');
    expect(() => parseReporterAttachment('listTools', 'not json')).toThrow();
  });
});

describe('MCPReporter reading the channel', () => {
  async function report(
    tests: Array<{
      title: string;
      status?: TestResult['status'];
      error?: string;
      attachments: Attachment[];
    }>,
    options: Record<string, unknown> = {}
  ): Promise<MCPEvalRunData> {
    const outputDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mcp-channel-'));
    const reporter = new MCPReporter({
      quiet: true,
      autoOpen: false,
      outputDir,
      ...options,
    });
    await reporter.onBegin({} as FullConfig, {} as Suite);
    for (const test of tests) {
      const errors = test.error ? [{ message: test.error }] : [];
      await reporter.onTestEnd(
        { title: test.title, parent: { title: 'suite' } } as TestCase,
        {
          status: test.status ?? 'passed',
          attachments: test.attachments,
          error: errors[0],
          errors,
        } as unknown as TestResult
      );
    }
    await fs.rm(outputDir, { recursive: true, force: true });
    return (
      reporter as unknown as { buildRunData(ms: number): MCPEvalRunData }
    ).buildRunData(0);
  }

  async function attachments(
    ...items: ReporterAttachment[]
  ): Promise<Attachment[]> {
    const test = recorder();
    for (const item of items) await attachReporterData(test, item);
    return test.attachments;
  }

  it('reads every eval-results attachment in a test', async () => {
    const run = await report([
      {
        title: 'two datasets',
        attachments: await attachments(
          { kind: 'evalResults', data: { caseResults: [caseResult] } },
          {
            kind: 'evalResults',
            data: { caseResults: [{ ...caseResult, id: 'second' }] },
          }
        ),
      },
    ]);
    expect(run.results.map((result) => result.id)).toEqual([
      'weather',
      'second',
    ]);
  });

  it('keeps every conformance result and the first tool list', async () => {
    const run = await report([
      {
        title: 'conformance',
        attachments: await attachments(
          samples[2]!,
          samples[2]!,
          samples[3]!,
          samples[3]!
        ),
      },
    ]);
    expect(run.conformanceChecks).toHaveLength(2);
    expect(run.conformanceChecks?.[0]).toMatchObject({
      testTitle: 'conformance',
      scope: 'Protocol 2026-07-28',
    });
    expect(run.serverCapabilities).toHaveLength(1);
  });

  it('reports auto-tracked calls with their arguments and the test failure', async () => {
    const run = await report([
      {
        title: 'weather test',
        status: 'failed',
        error: '\u001b[31mexpected sunny\u001b[39m',
        attachments: await attachments(samples[4]!),
      },
    ]);
    expect(run.results).toEqual([
      expect.objectContaining({
        id: 'weather test',
        datasetName: 'suite',
        toolName: 'get_weather',
        source: 'test',
        pass: false,
        request: { args: { city: 'London' } },
        error: 'expected sunny',
        durationMs: 3,
      }),
    ]);
  });

  it('names the status when a test fails without an error', async () => {
    const run = await report([
      {
        title: 'timed out',
        status: 'timedOut',
        attachments: await attachments(samples[4]!),
      },
    ]);
    expect(run.results[0]?.error).toBe('Test timedOut');
  });

  it('skips auto-tracked calls next to eval results, or when disabled', async () => {
    const withEval = await report([
      {
        title: 'both',
        attachments: await attachments(samples[0]!, samples[4]!),
      },
    ]);
    expect(withEval.results.map((result) => result.source)).toEqual(['eval']);
    const disabled = await report(
      [{ title: 'calls', attachments: await attachments(samples[4]!) }],
      { includeAutoTracking: false }
    );
    expect(disabled.results).toEqual([]);
  });

  it('logs a malformed attachment and keeps reading the rest', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const run = await report(
      [
        {
          title: 'mixed',
          attachments: [
            {
              name: 'mcp-conformance-checks',
              contentType: 'application/json',
              body: Buffer.from('{"pass": true}'),
            },
            ...(await attachments(samples[0]!)),
          ],
        },
      ],
      { quiet: false }
    );
    expect(run.results).toHaveLength(1);
    expect(error).toHaveBeenCalledWith(
      expect.stringContaining(
        'Failed to read attachment "mcp-conformance-checks"'
      ),
      expect.any(Error)
    );
    error.mockRestore();
  });
});
