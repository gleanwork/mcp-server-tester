import { afterEach, describe, expect, it } from 'vitest';
import {
  EvalDatasetSchema,
  type EvalCase,
} from '../../../src/evals/datasetTypes.js';
import type {
  HostEvidence,
  HostEvent,
  HostRunResult,
} from '../../../src/evals/evalFrameworkTypes.js';
import { hostTraceToExecution } from '../../../src/evals/hostTrace.js';
import {
  createDesktopEvalFixture,
  type DesktopEvalFixture,
} from './fixture.js';
import {
  createDesktopEvalDataset,
  createDesktopSmokeDataset,
} from './dataset.js';
import { runEvalDataset } from '../../../src/evals/evalRunner.js';
import {
  createMCPClientForConfig,
  closeMCPClient,
} from '../../../src/mcp/clientFactory.js';
import { createMCPFixture } from '../../../src/mcp/fixtures/mcpFixture.js';
import { assertDesktopLedgerEvidence } from './ledger.js';
import { createSyntheticDesktopHost } from './syntheticHost.js';

const fixtures: DesktopEvalFixture[] = [];
afterEach(async () => {
  for (const fixture of fixtures.splice(0)) await fixture.dispose();
});

describe('canonical desktop eval scenarios', () => {
  it('scores canonical direct smoke cases through runEvalDataset and a real independent MCP fixture', async () => {
    const fixture = await createDesktopEvalFixture();
    fixtures.push(fixture);
    const client = await createMCPClientForConfig(fixture.servers[0]);
    try {
      const dataset = createDesktopSmokeDataset(fixture.oracle);
      expect(EvalDatasetSchema.parse(dataset).cases).toHaveLength(3);
      const result = await runEvalDataset(
        { dataset },
        { mcp: createMCPFixture(client) }
      );
      expect(result.total).toBe(3);
      expect(result.caseResults.map(({ id, pass }) => ({ id, pass }))).toEqual([
        { id: 'smoke-direct', pass: true },
        { id: 'smoke-search', pass: true },
        { id: 'smoke-missing', pass: true },
      ]);
      const ledger = await fixture.readLedger();
      expect(
        ledger.filter(
          (entry) =>
            entry.direction === 'request' &&
            'method' in entry.message &&
            entry.message.method === 'tools/call'
        )
      ).toHaveLength(3);
    } finally {
      await closeMCPClient(client);
    }
  });
  it('parses three host cases and keeps fresh answers and dependent references out of controller inputs', async () => {
    const fixture = await createDesktopEvalFixture();
    const other = await createDesktopEvalFixture();
    fixtures.push(fixture, other);
    const dataset = createDesktopEvalDataset(fixture.oracle);
    const parsed = EvalDatasetSchema.parse(dataset);
    expect(parsed.cases.map(({ id, mode }) => ({ id, mode }))).toEqual([
      { id: 'direct-lookup', mode: 'host' },
      { id: 'dependent-lookup', mode: 'host' },
      { id: 'missing-recovery', mode: 'host' },
    ]);
    expect(
      parsed.cases.map((item) => item.expect?.toolCallCount?.exact)
    ).toEqual([1, 2, 3]);
    for (const item of parsed.cases) {
      expect(item.expect?.toolsTriggered).toMatchObject({
        order: 'strict',
        exclusive: true,
      });
      expect(
        item.expect?.toolsTriggered?.calls.every(
          (call) => call.server === 'desktop_records' && call.source === 'mcp'
        )
      ).toBe(true);
    }
    const controllerInputs = JSON.stringify({
      scenarios: dataset.cases.map((item) => item.scenario),
      servers: fixture.servers,
    });
    for (const record of [
      fixture.oracle.direct,
      fixture.oracle.dependent,
      fixture.oracle.recovery,
    ]) {
      expect(controllerInputs).not.toContain(record.verificationCode);
    }
    expect(controllerInputs).not.toContain(fixture.oracle.dependent.reference);
    expect(controllerInputs).not.toContain(fixture.oracle.recovery.reference);
    expect(other.oracle.direct.verificationCode).not.toBe(
      fixture.oracle.direct.verificationCode
    );
    expect(other.oracle.dependent.reference).not.toBe(
      fixture.oracle.dependent.reference
    );
    expect(dataset.cases[2]?.scenario).toContain('JSON');
    expect(dataset.cases[2]?.scenario).toContain('NOT_FOUND');
    // Judge-free final-answer schemas validate actual JSON, not substrings in a trace.
    for (const [schemaName, record, status] of [
      ['DesktopDirectAnswer', fixture.oracle.direct, 'found'],
      ['DesktopDependentAnswer', fixture.oracle.dependent, 'found'],
      ['DesktopRecoveryAnswer', fixture.oracle.recovery, 'recovered'],
    ] as const) {
      const answer = {
        status,
        reference: record.reference,
        verificationCode: record.verificationCode,
        serverLabel: 'desktop_records',
        ...(status === 'recovered'
          ? { requestedReference: 'missing-release' }
          : {}),
      };
      // Schema unit validation, not a fabricated host run.
      expect(
        dataset.schemas?.[schemaName]?.safeParse({
          response: JSON.stringify(answer),
        }).success
      ).toBe(true);
      expect(
        dataset.schemas?.[schemaName]?.safeParse({
          response: `\`\`\`json\n${JSON.stringify(answer)}\n\`\`\``,
        }).success
      ).toBe(true);
      expect(
        dataset.schemas?.[schemaName]?.safeParse({
          response: `Result:\n\`\`\`json\n${JSON.stringify(answer)}\n\`\`\``,
        }).success
      ).toBe(false);
      expect(
        dataset.schemas?.[schemaName]?.safeParse({
          response: JSON.stringify({ ...answer, extra: true }),
        }).success
      ).toBe(false);
    }
    const recoverySchema = dataset.schemas?.DesktopRecoveryAnswer;
    expect(recoverySchema).toBeDefined();
    expect(recoverySchema?.safeParse({ response: 'not JSON' }).success).toBe(
      false
    );
    expect(
      recoverySchema?.safeParse({
        response: JSON.stringify({
          status: 'recovered',
          requestedReference: 'missing-release',
          reference: fixture.oracle.recovery.reference,
          verificationCode: 'made-up-answer',
          serverLabel: 'desktop_records',
        }),
      }).success
    ).toBe(false);
  });

  it('runs and calculates all three cases through one synthetic HostDefinition and the independent ledger', async () => {
    const fixture = await createDesktopEvalFixture();
    fixtures.push(fixture);
    const dataset = createDesktopEvalDataset(fixture.oracle);
    const host = createSyntheticDesktopHost();
    const traces = new Map<string, HostRunResult>();
    const ledgerSlices = new Map<
      string,
      Awaited<ReturnType<typeof fixture.readLedger>>
    >();
    let ledgerOffset = 0;

    const result = await runEvalDataset(
      {
        dataset,
        concurrency: 1,
        async executeCase(evalCase) {
          const trace = await host.run!(
            { scenario: evalCase.scenario!, servers: fixture.servers },
            { type: host.name },
            { manifest: { name: 'synthetic-desktop-evals', datasets: [] } }
          );
          const ledger = await fixture.readLedger();
          const slice = ledger.slice(ledgerOffset);
          ledgerOffset = ledger.length;
          assertDesktopLedgerEvidence(
            fixture.oracle,
            evalCase,
            slice,
            trace.events
          );
          traces.set(evalCase.id, structuredClone(trace));
          ledgerSlices.set(evalCase.id, slice);
          return hostTraceToExecution(
            trace,
            host.evidence ?? 'none',
            fixture.servers
          );
        },
      },
      {}
    );

    expect(result).toMatchObject({ total: 3, passed: 3, failed: 0 });
    expect(result.caseResults.map(({ id, pass }) => ({ id, pass }))).toEqual([
      { id: 'direct-lookup', pass: true },
      { id: 'dependent-lookup', pass: true },
      { id: 'missing-recovery', pass: true },
    ]);
    for (const item of result.caseResults) {
      expect(item.expectations.schema?.pass).toBe(true);
      expect(item.expectations.toolsTriggered?.pass).toBe(true);
      expect(item.expectations.toolCallCount?.pass).toBe(true);
    }

    const direct = requiredTrace(traces, 'direct-lookup');
    const directCase = requiredCase(dataset.cases, 'direct-lookup');
    const directLedger = requiredLedger(ledgerSlices, 'direct-lookup');
    const badResult = structuredClone(direct);
    badResult.events[0]!.output = JSON.stringify({ fabricated: true });
    expect(() =>
      assertDesktopLedgerEvidence(
        fixture.oracle,
        directCase,
        directLedger,
        badResult.events
      )
    ).toThrow('native result must match the independent ledger');

    const faults: Array<{
      name: string;
      caseId: string;
      evidence?: HostEvidence;
      change(trace: HostRunResult): HostRunResult;
      failedExpectation: 'schema' | 'toolsTriggered' | 'toolCallCount';
    }> = [
      {
        name: 'wrong final answer',
        caseId: 'direct-lookup',
        change(trace) {
          return { ...trace, finalText: '{"status":"found"}' };
        },
        failedExpectation: 'schema',
      },
      {
        name: 'wrong tool order',
        caseId: 'dependent-lookup',
        change(trace) {
          return { ...trace, events: [...trace.events].reverse() };
        },
        failedExpectation: 'toolsTriggered',
      },
      {
        name: 'extra tool call',
        caseId: 'direct-lookup',
        change(trace) {
          return { ...trace, events: [...trace.events, trace.events[0]!] };
        },
        failedExpectation: 'toolCallCount',
      },
      {
        name: 'wrong server provenance',
        caseId: 'direct-lookup',
        change(trace) {
          return {
            ...trace,
            events: trace.events.map((event) => ({
              ...event,
              server: 'desktop_decoy',
            })),
          };
        },
        failedExpectation: 'toolsTriggered',
      },
      {
        name: 'controller event leakage',
        caseId: 'direct-lookup',
        change(trace) {
          const leaked: HostEvent = {
            kind: 'command',
            source: 'host',
            name: 'playwright.click',
          };
          return { ...trace, events: [...trace.events, leaked] };
        },
        failedExpectation: 'toolsTriggered',
      },
      {
        name: 'unverified evidence',
        caseId: 'direct-lookup',
        evidence: 'observed',
        change(trace) {
          return trace;
        },
        failedExpectation: 'toolsTriggered',
      },
    ];

    for (const fault of faults) {
      const evalCase = requiredCase(dataset.cases, fault.caseId);
      const trace = fault.change(
        structuredClone(requiredTrace(traces, fault.caseId))
      );
      const scored = await runEvalDataset(
        {
          dataset: { ...dataset, cases: [evalCase] },
          async executeCase() {
            return hostTraceToExecution(
              trace,
              fault.evidence ?? 'structured',
              fixture.servers
            );
          },
        },
        {}
      );
      expect(scored.failed, fault.name).toBe(1);
      expect(
        scored.caseResults[0]?.expectations[fault.failedExpectation]?.pass,
        fault.name
      ).toBe(false);
    }
  });
});

function requiredTrace(
  traces: Map<string, HostRunResult>,
  id: string
): HostRunResult {
  const trace = traces.get(id);
  if (!trace) throw new Error(`Missing synthetic trace for ${id}.`);
  return trace;
}

function requiredCase(cases: EvalCase[], id: string): EvalCase {
  const evalCase = cases.find((candidate) => candidate.id === id);
  if (!evalCase) throw new Error(`Missing desktop eval case ${id}.`);
  return evalCase;
}

function requiredLedger(
  ledgers: Map<string, Awaited<ReturnType<DesktopEvalFixture['readLedger']>>>,
  id: string
): Awaited<ReturnType<DesktopEvalFixture['readLedger']>> {
  const entries = ledgers.get(id);
  if (!entries) throw new Error(`Missing ledger slice for ${id}.`);
  return entries;
}
