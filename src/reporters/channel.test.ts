import { describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type {
  FullConfig,
  FullResult,
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
import type { EvalCaseResult } from '../types/reporter.js';
import { readRunDirectory, type StoredRun } from '../evals/runFormat.js';

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
  scores: {},
  durationMs: 5,
};

const samples: ReporterAttachment[] = [
  { kind: 'evalResults', data: { caseResults: [caseResult] } },
  {
    kind: 'toolOptimization',
    data: {
      metric: 'passRate',
      baselineValue: 0.5,
      bestValue: 0.75,
      rounds: [],
      reason: 'improved',
    } as unknown as Extract<
      ReporterAttachment,
      { kind: 'toolOptimization' }
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

  it('writes the same bytes as before the channel', async () => {
    const test = recorder();
    for (const sample of samples) await attachReporterData(test, sample);
    expect(
      test.attachments.map(({ name, contentType, body }) => ({
        name,
        contentType,
        body: body!.toString('utf-8'),
      }))
    ).toEqual(
      samples.map((sample, index) => ({
        name: [
          'mcp-test-results',
          'mcp-tool-optimization',
          'mcp-conformance-checks',
          'mcp-list-tools',
          'mcp-call-get_weather',
        ][index],
        contentType: 'application/json',
        // Eval results and optimizations are compact; the rest pretty-printed.
        body:
          index < 2
            ? JSON.stringify(sample.data)
            : JSON.stringify(sample.data, null, 2),
      }))
    );
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
  /** Run the reporter over the tests, and read back the run it wrote, if any. */
  async function report(
    tests: Array<{
      title: string;
      project?: string;
      attachments: Attachment[];
    }>,
    options: Record<string, unknown> = {}
  ): Promise<StoredRun | undefined> {
    const outputDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mcp-channel-'));
    const reporter = new MCPReporter({
      quiet: true,
      outputDir,
      ...options,
    });
    reporter.onBegin(
      { projects: [{ name: 'chromium', use: {} }] } as unknown as FullConfig,
      {} as Suite
    );
    for (const [index, test] of tests.entries())
      await reporter.onTestEnd(
        {
          id: `test-${index}`,
          title: test.title,
          parent: {
            title: 'suite',
            project: () => ({ name: test.project ?? 'chromium' }),
          },
        } as unknown as TestCase,
        {
          status: 'passed',
          attachments: test.attachments,
          errors: [],
        } as unknown as TestResult
      );
    await reporter.onEnd({} as FullResult);
    const evalDir = path.join(outputDir, 'playwright');
    let run: StoredRun | undefined;
    try {
      const latest = JSON.parse(
        await fs.readFile(path.join(evalDir, 'latest.json'), 'utf8')
      ) as { path: string };
      run = await readRunDirectory(path.join(evalDir, latest.path));
    } catch {
      run = undefined;
    }
    await fs.rm(outputDir, { recursive: true, force: true });
    return run;
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
    expect(run?.summary.results.map((result) => result.id)).toEqual([
      'weather',
      'second',
    ]);
  });

  it("leaves tests, tool calls and conformance checks to Playwright's report", async () => {
    const run = await report([
      {
        title: 'not evals',
        attachments: await attachments(samples[2]!, samples[3]!, samples[4]!),
      },
    ]);
    expect(run).toBeUndefined();
  });

  it('reads attachments Playwright wrote to disk', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mcp-attachment-'));
    const file = path.join(dir, 'results.json');
    await fs.writeFile(
      file,
      JSON.stringify({ caseResults: [caseResult] }),
      'utf-8'
    );
    const run = await report([
      {
        title: 'on disk',
        attachments: [
          {
            name: 'mcp-test-results',
            contentType: 'application/json',
            path: file,
          },
        ],
      },
    ]);
    await fs.rm(dir, { recursive: true, force: true });
    expect(run?.summary.results.map((result) => result.id)).toEqual([
      'weather',
    ]);
  });

  it('rejects eval results the report would fail to aggregate', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const run = await report([
      {
        title: 'no assertions',
        attachments: [
          {
            name: 'mcp-test-results',
            contentType: 'application/json',
            body: Buffer.from(
              JSON.stringify({ caseResults: [{ id: 'x', pass: true }] })
            ),
          },
        ],
      },
    ]);
    expect(run).toBeUndefined();
    vi.restoreAllMocks();
  });

  it('logs a malformed attachment and keeps reading the rest', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const run = await report(
      [
        {
          title: 'mixed',
          attachments: [
            {
              name: 'mcp-test-results',
              contentType: 'application/json',
              body: Buffer.from('{"caseResults": "not a list"}'),
            },
            ...(await attachments(samples[0]!)),
          ],
        },
      ],
      { quiet: false }
    );
    expect(run?.summary.results).toHaveLength(1);
    expect(error).toHaveBeenCalledWith(
      expect.stringContaining('Failed to read attachment "mcp-test-results"'),
      expect.any(Error)
    );
    vi.restoreAllMocks();
  });
});
