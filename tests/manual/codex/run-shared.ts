import { constants } from 'node:fs';
import { open, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import type {
  HostDefinition,
  HostRunResult,
} from '../../../src/evals/evalFrameworkTypes.js';
import type { EvalRunnerResult } from '../../../src/evals/evalRunner.js';
import { runEvalDataset } from '../../../src/evals/evalRunner.js';
import { hostTraceToExecution } from '../../../src/evals/hostTrace.js';
import { createCodexDesktopHost } from '../../../src/evals/codex/host.js';
import {
  assertCodexNativeToolResults,
  type NativeToolResultWitness,
} from '../../../src/evals/codex/nativeEvidence.js';
import type { DesktopLedgerEntry } from '../../fixtures/desktop-evals/contract.js';
import { createDesktopEvalDataset } from '../../fixtures/desktop-evals/dataset.js';
import {
  createDesktopEvalFixture,
  type DesktopEvalFixture,
} from '../../fixtures/desktop-evals/fixture.js';
import { assertDesktopLedgerEvidence } from '../../fixtures/desktop-evals/ledger.js';
import {
  createPrivateDirectory,
  ensurePrivateDirectory,
  writePrivateFile,
  writePrivateJson,
} from './files.js';
import {
  caseAttemptId,
  caseOutputDir,
  parseSharedCodexConfig,
  type SharedCodexConfig,
} from './shared-config.js';

const CASE_LEDGER_WAIT_TIMEOUT_MS = 1000;
const CASE_LEDGER_STABILITY_MS = 50;

export interface SharedCodexDependencies {
  createFixture?: () => Promise<DesktopEvalFixture>;
  createHost?: () => HostDefinition;
}

interface CaseLifecycle {
  state: 'closed' | 'quarantined' | 'unverified';
  outcome?: 'completed' | 'failed';
}

export interface SharedCodexCaseResult {
  caseId: string;
  attemptId: string;
  outputDir: string;
  qualification: 'structured' | 'none';
  ledgerVerified: boolean;
  nativeResultsVerified: boolean;
  lifecycle: CaseLifecycle;
  runnerResult: EvalRunnerResult;
}

export interface SharedCodexSuiteResult {
  version: 1;
  attemptId: string;
  planned: number;
  completed: number;
  passed: number;
  failed: number;
  stoppedAfterQuarantine: boolean;
  fixtureRetained: boolean;
  cases: SharedCodexCaseResult[];
}

/** Run the three canonical desktop cases with a fresh Codex attempt per case. */
export async function runSharedCodexEval(
  input: SharedCodexConfig,
  dependencies: SharedCodexDependencies = {}
): Promise<SharedCodexSuiteResult> {
  const config = parseSharedCodexConfig(input);
  const fixture = await (
    dependencies.createFixture ?? createDesktopEvalFixture
  )();
  const host = (dependencies.createHost ?? createCodexDesktopHost)();
  if (host.evidence !== 'structured' || !host.run) {
    await fixture.dispose();
    throw new Error(
      'The Codex suite requires a structured host trace producer.'
    );
  }

  const dataset = createDesktopEvalDataset(fixture.oracle);
  const caseIds = dataset.cases.map((evalCase) => evalCase.id);
  if (caseIds.length !== 3 || new Set(caseIds).size !== caseIds.length) {
    await fixture.dispose();
    throw new Error(
      'The canonical desktop dataset must contain three unique cases.'
    );
  }

  try {
    await createPrivateDirectory(config.outputDir);
    await createPrivateDirectory(join(config.outputDir, 'cases'));
  } catch (error) {
    await fixture.dispose();
    throw error;
  }
  const cases: SharedCodexCaseResult[] = [];
  let ledgerOffset = 0;
  const attemptedLifecycles: CaseLifecycle[] = [];
  let stoppedAfterQuarantine = false;
  let fixtureRetained = false;

  try {
    for (const [index, evalCase] of dataset.cases.entries()) {
      if (stoppedAfterQuarantine) break;
      const before = await fixture.readLedger();
      if (before.length !== ledgerOffset) {
        throw new Error('Desktop ledger changed outside the prior case slice.');
      }
      const ledgerStart = ledgerOffset;
      const attemptId = caseAttemptId(config.attemptId, index, evalCase.id);
      const outputDir = caseOutputDir(config.outputDir, index, evalCase.id);
      let trace: HostRunResult = {
        finalText: '',
        events: [],
        error: 'Codex host did not run.',
      };
      let lifecycle: CaseLifecycle = { state: 'unverified' };
      let ledgerVerified = false;
      let nativeResultsVerified = false;
      let ledgerPersisted = false;
      let artifactFailure: Error | undefined;
      const lifecycleIndex = attemptedLifecycles.push(lifecycle) - 1;

      const runnerResult = await runEvalDataset(
        {
          dataset: { ...dataset, cases: [evalCase] },
          concurrency: 1,
          defaultLlmIterations: 1,
          async executeCase(canonicalCase) {
            try {
              trace = await host.run!(
                {
                  scenario: canonicalCase.scenario ?? '',
                  servers: fixture.servers,
                },
                {
                  type: host.name,
                  attemptId,
                  executablePath: config.executablePath,
                  profilePath: config.profilePath,
                  outputDir,
                  timeoutMs: 180_000,
                  cleanupTimeoutMs: 60_000,
                },
                {
                  manifest: {
                    name: `codex-shared-${canonicalCase.id}`,
                    datasets: [{ type: 'inline' }],
                    servers: fixture.servers,
                    host: { type: host.name, timeout: 180_000 },
                  },
                }
              );
              await ensurePrivateDirectory(outputDir);
              lifecycle = await readCaseLifecycle(
                config.profilePath,
                attemptId,
                outputDir
              );
              attemptedLifecycles[lifecycleIndex] = lifecycle;
              if ((await stat(fixture.ledgerPath)).size > 1024 * 1024) {
                throw new Error('Fixture ledger exceeds the suite bound.');
              }
              const ledger = await fixture.waitForLedger(
                createStableCaseLedgerPredicate(
                  ledgerStart,
                  before,
                  trace.events
                ),
                CASE_LEDGER_WAIT_TIMEOUT_MS
              );
              if ((await stat(fixture.ledgerPath)).size > 1024 * 1024) {
                throw new Error('Fixture ledger exceeds the suite bound.');
              }
              const slice = ledger.slice(ledgerStart);
              ledgerOffset = ledger.length;
              try {
                assertDesktopLedgerEvidence(
                  fixture.oracle,
                  canonicalCase,
                  slice,
                  trace.events
                );
                ledgerVerified = true;
              } catch {
                ledgerVerified = false;
              }
              try {
                assertCodexNativeToolResults(
                  trace.events,
                  ledgerResultWitnesses(slice)
                );
                nativeResultsVerified = true;
              } catch {
                nativeResultsVerified = false;
              }
              await writePrivateFile(
                join(outputDir, 'fixture-ledger.jsonl'),
                serializeLedger(slice)
              );
              ledgerPersisted = true;
              const qualified =
                !trace.error &&
                ledgerVerified &&
                nativeResultsVerified &&
                lifecycle.state === 'closed';
              if (!qualified) trace = disqualifyTrace(trace);
              return hostTraceToExecution(
                trace,
                qualified ? 'structured' : 'none',
                fixture.servers
              );
            } catch (error) {
              artifactFailure =
                error instanceof Error
                  ? error
                  : new Error('Case artifact creation failed.', {
                      cause: error,
                    });
              throw artifactFailure;
            }
          },
        },
        {}
      );

      if (artifactFailure || !ledgerPersisted) {
        throw artifactFailure ?? new Error('Case ledger was not persisted.');
      }
      const qualification =
        !trace.error &&
        ledgerVerified &&
        nativeResultsVerified &&
        lifecycle.state === 'closed'
          ? 'structured'
          : 'none';
      await writePrivateJson(join(outputDir, 'runner-result.json'), {
        caseId: evalCase.id,
        attemptId,
        qualification,
        ledgerVerified,
        nativeResultsVerified,
        runnerResult,
      });
      await writePrivateJson(join(outputDir, 'completion-manifest.json'), {
        version: 1,
        caseId: evalCase.id,
        attemptId,
        lifecycle,
        qualification,
        passed: qualification === 'structured' && runnerResult.failed === 0,
        ledger: {
          start: ledgerStart,
          end: ledgerOffset,
          entries: ledgerOffset - ledgerStart,
          path: 'fixture-ledger.jsonl',
        },
        persistenceOrder: [
          'fixture-ledger.jsonl',
          'runner-result.json',
          'completion-manifest.json',
        ],
      });
      cases.push({
        caseId: evalCase.id,
        attemptId,
        outputDir,
        qualification,
        ledgerVerified,
        nativeResultsVerified,
        lifecycle,
        runnerResult,
      });
      stoppedAfterQuarantine = lifecycle.state !== 'closed';
    }

    fixtureRetained = attemptedLifecycles.some(
      (item) => item.state !== 'closed'
    );
    const suiteResult = summarizeSuite(
      config.attemptId,
      caseIds.length,
      cases,
      stoppedAfterQuarantine,
      fixtureRetained
    );
    await writePrivateJson(
      join(config.outputDir, 'suite-result.json'),
      suiteResult
    );
    await writePrivateJson(join(config.outputDir, 'completion-manifest.json'), {
      version: 1,
      attemptId: config.attemptId,
      status: stoppedAfterQuarantine ? 'quarantined' : 'closed',
      plannedCases: caseIds,
      completedCases: cases.map((item) => item.caseId),
      fixtureRetained,
      persistenceOrder: [
        'cases/*/fixture-ledger.jsonl',
        'cases/*/runner-result.json',
        'cases/*/completion-manifest.json',
        'suite-result.json',
        'completion-manifest.json',
      ],
    });
    return suiteResult;
  } finally {
    fixtureRetained ||= attemptedLifecycles.some(
      (item) => item.state !== 'closed'
    );
    if (!fixtureRetained) {
      assertClosedBeforeDisposal(attemptedLifecycles);
      await fixture.dispose();
    }
  }
}

function summarizeSuite(
  attemptId: string,
  planned: number,
  cases: SharedCodexCaseResult[],
  stoppedAfterQuarantine: boolean,
  fixtureRetained: boolean
): SharedCodexSuiteResult {
  const passed = cases.filter(
    (item) =>
      item.qualification === 'structured' && item.runnerResult.failed === 0
  ).length;
  return {
    version: 1,
    attemptId,
    planned,
    completed: cases.length,
    passed,
    failed: cases.length - passed,
    stoppedAfterQuarantine,
    fixtureRetained,
    cases,
  };
}

function assertClosedBeforeDisposal(lifecycles: CaseLifecycle[]): void {
  if (lifecycles.some((item) => item.state !== 'closed')) {
    throw new Error(
      'Refusing fixture disposal without closed case lifecycles.'
    );
  }
}

function disqualifyTrace(trace: HostRunResult): HostRunResult {
  return {
    ...trace,
    error: `${trace.error ?? 'Codex native trace was not qualified.'} Independent ledger, native-result, or closed-lifecycle verification failed.`,
  };
}

function serializeLedger(entries: DesktopLedgerEntry[]): string {
  return (
    entries.map((entry) => JSON.stringify(entry)).join('\n') +
    (entries.length ? '\n' : '')
  );
}

function createStableCaseLedgerPredicate(
  ledgerStart: number,
  prefix: DesktopLedgerEntry[],
  events: HostRunResult['events']
): (entries: DesktopLedgerEntry[]) => boolean {
  const expectedPrefix = serializeLedger(prefix);
  let candidate: string | undefined;
  let candidateSince = 0;
  return (entries) => {
    if (
      entries.length < ledgerStart ||
      serializeLedger(entries.slice(0, ledgerStart)) !== expectedPrefix
    ) {
      candidate = undefined;
      candidateSince = 0;
      return false;
    }
    const slice = entries.slice(ledgerStart);
    try {
      assertCodexNativeToolResults(events, ledgerResultWitnesses(slice));
    } catch {
      candidate = undefined;
      candidateSince = 0;
      return false;
    }
    const serialized = serializeLedger(slice);
    const now = Date.now();
    if (serialized !== candidate) {
      candidate = serialized;
      candidateSince = now;
      return false;
    }
    return now - candidateSince >= CASE_LEDGER_STABILITY_MS;
  };
}

function ledgerResultWitnesses(
  entries: DesktopLedgerEntry[]
): NativeToolResultWitness[] {
  return entries
    .filter(
      (entry) =>
        entry.direction === 'request' &&
        'method' in entry.message &&
        entry.message.method === 'tools/call'
    )
    .map((entry) => {
      const request = CallToolRequestSchema.parse(entry.message);
      if (!('id' in entry.message)) {
        throw new Error('Ledger tool request has no wire ID.');
      }
      const wireId = entry.message.id;
      const responses = entries.filter(
        (candidate) =>
          candidate.direction === 'response' &&
          candidate.sessionId === entry.sessionId &&
          'id' in candidate.message &&
          candidate.message.id === wireId
      );
      if (responses.length !== 1) {
        throw new Error('Ledger tool request needs one wire response.');
      }
      const response = responses[0]!.message;
      const common = {
        server: entry.serverLabel,
        name: request.params.name,
        arguments: request.params.arguments ?? {},
      };
      if ('result' in response) return { ...common, result: response.result };
      if ('error' in response) return { ...common, error: response.error };
      throw new Error('Ledger response has no result or error.');
    });
}

async function readCaseLifecycle(
  profilePath: string,
  attemptId: string,
  outputDir: string
): Promise<CaseLifecycle> {
  const path = join(
    profilePath,
    '.host-attempts',
    attemptId,
    'checkpoint.json'
  );
  let file;
  try {
    file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const info = await file.stat();
    if (
      !info.isFile() ||
      info.uid !== process.getuid?.() ||
      info.nlink !== 1 ||
      (info.mode & 0o777) !== 0o600 ||
      info.size > 8192
    ) {
      return { state: 'unverified' };
    }
    const value: unknown = JSON.parse(await file.readFile('utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return { state: 'unverified' };
    }
    const record = value as Record<string, unknown>;
    if (
      record.attemptId !== attemptId ||
      record.outputDir !== outputDir ||
      (record.state !== 'closed' && record.state !== 'quarantined') ||
      (record.outcome !== 'completed' && record.outcome !== 'failed')
    ) {
      return { state: 'unverified' };
    }
    return { state: record.state, outcome: record.outcome };
  } catch {
    return { state: 'unverified' };
  } finally {
    await file?.close().catch(() => {});
  }
}
