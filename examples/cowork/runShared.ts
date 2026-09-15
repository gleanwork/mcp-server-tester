import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  connectCoworkCua,
  createCoworkHost,
  hostTraceToExecution,
  prepareCoworkApplication,
  runEvalDataset,
  type CoworkCuaConnection,
  type EvalManifest,
  type EvalRunnerResult,
  type HostRunResult,
} from '@gleanwork/mcp-server-tester';
import { DesktopLedgerEntrySchema } from '../../tests/fixtures/desktop-evals/contract.js';
import { createDesktopEvalDataset } from '../../tests/fixtures/desktop-evals/dataset.js';
import { assertDesktopLedgerEvidence } from '../../tests/fixtures/desktop-evals/ledger.js';
import type { SharedCoworkConfig } from './sharedConfig.js';
import { readSharedDesktopOracle, sharedLedgerPath } from './sharedConfig.js';
import { assertSharedCoworkDataDir } from './discoverShared.js';
import { createPrivateDirectory, writePrivateJson } from './files.js';
import { finishRuntime, retainRuntime } from './lifecycle.js';

let used = false;

export async function runSharedCoworkEval(config: SharedCoworkConfig): Promise<{
  result: EvalRunnerResult;
  runtimeRetained: boolean;
}> {
  if (used) throw new Error('Use a new worker for each shared Cowork suite.');
  used = true;
  const oracle = await readSharedDesktopOracle(config.fixtureRoot);
  const dataset = createDesktopEvalDataset(oracle);
  const ledgerPath = sharedLedgerPath(config.fixtureRoot);
  await createPrivateDirectory(config.outputDir);
  const attemptRoot = join(config.outputDir, 'attempts');
  const receiptParent = join(
    config.fixtureRoot,
    'evaluator',
    'cowork-attempts'
  );
  const receiptRoot = join(receiptParent, config.attemptId);
  await createPrivateDirectory(attemptRoot);
  try {
    await createPrivateDirectory(receiptParent);
  } catch (error) {
    if (
      !(error instanceof Error) ||
      !('code' in error) ||
      error.code !== 'EEXIST'
    )
      throw error;
  }
  await createPrivateDirectory(receiptRoot);
  let cua: CoworkCuaConnection | undefined;
  let quarantined = false;
  let retainAfterSubmit = false;
  let runtimeRetained = false;
  let result: EvalRunnerResult;
  let ledgerOffset = (await readLedger(ledgerPath)).length;
  const manifest: EvalManifest = {
    name: `shared-external-desktop-evals-${config.attemptId}`,
    datasets: [{ type: 'inline' }],
    servers: config.servers,
    host: { type: 'cowork-shared', timeout: 180_000 },
  };

  try {
    const application = await prepareCoworkApplication({
      executablePath: config.executablePath,
      profilePath: config.profilePath,
    });
    const dataDir = await assertSharedCoworkDataDir(
      config.dataDir,
      application.userDataPath,
      application.profile.paths.root
    );
    cua = await connectCoworkCua({ command: config.runtimePath });
    result = await runEvalDataset(
      {
        dataset,
        concurrency: 1,
        async executeCase(evalCase) {
          if (quarantined) {
            return hostTraceToExecution(
              {
                finalText: '',
                events: [],
                error: 'A prior Cowork case retained uncertain native state.',
              },
              'none',
              config.servers
            );
          }
          const caseOutput = join(attemptRoot, evalCase.id);
          const caseReceipt = join(receiptRoot, evalCase.id);
          await createPrivateDirectory(caseOutput);
          await createPrivateDirectory(caseReceipt);
          const approvalOutput = join(caseOutput, 'approvals');
          const approvalReceipt = join(caseReceipt, 'approvals');
          await createPrivateDirectory(approvalOutput);
          await createPrivateDirectory(approvalReceipt);
          const host = createCoworkHost({
            name: `cowork-shared-${evalCase.id}`,
            cua: cua!,
            dataDir,
            expectedServers: config.servers,
            mcpServerPrefixes: config.mcpServerPrefixes,
            application: {
              launch: (acquired) => application.launch(acquired),
              activate: (pid, url) => application.activate(pid, url),
              stop: (pid, timeoutMs) => application.stop(pid, timeoutMs),
            },
            approval: {
              isolationKey: `${config.attemptId}:${evalCase.id}`,
              modePolicy: {
                id: 'shared-cowork-current-task-auto-mode',
                maxTotalApprovals: 1,
                rules: [
                  {
                    id: 'current-task-auto-mode',
                    kind: 'host_permission_mode',
                    match: {
                      surface: 'cowork',
                      mode: 'automatic',
                      scope: 'current_task',
                    },
                    maxUses: 1,
                  },
                ],
              },
              policy: {
                id: 'shared-read-only-record-tools',
                maxTotalApprovals: 3,
                rules: [
                  {
                    id: 'lookup-record',
                    kind: 'mcp_tool_call',
                    match: {
                      server: 'desktop_records',
                      tool: 'lookup_record',
                      arguments: { namespace: 'releases' },
                    },
                    maxUses: 2,
                  },
                  {
                    id: 'search-records',
                    kind: 'mcp_tool_call',
                    match: {
                      server: 'desktop_records',
                      tool: 'search_records',
                      arguments: { namespace: 'releases' },
                    },
                    maxUses: 1,
                  },
                ],
              },
              servers: config.approvalServers,
              journal: {
                async append(receipt) {
                  const filename = `${receipt.id}.${receipt.state}.json`;
                  await writePrivateJson(
                    join(approvalReceipt, filename),
                    receipt
                  );
                  await writePrivateJson(
                    join(approvalOutput, filename),
                    receipt
                  );
                },
              },
            },
            requireMcpResults: true,
            async checkpoint(receipt) {
              await writePrivateJson(join(caseReceipt, 'armed.json'), receipt);
              await writePrivateJson(join(caseOutput, 'armed.json'), receipt);
            },
            async record(record) {
              quarantined ||= record.quarantined;
              retainAfterSubmit ||= record.quarantined && record.submitArmed;
              await writePrivateJson(
                join(caseOutput, 'diagnostics.json'),
                record
              );
            },
          });
          let trace: HostRunResult = await host.run!(
            { scenario: evalCase.scenario ?? '', servers: config.servers },
            {
              type: host.name,
              timeout: 180_000,
              cleanupTimeoutMs: 20_000,
              pollIntervalMs: 100,
            },
            { manifest }
          );
          const ledger = await readLedger(ledgerPath);
          const slice = ledger.slice(ledgerOffset);
          ledgerOffset = ledger.length;
          try {
            assertDesktopLedgerEvidence(oracle, evalCase, slice, trace.events);
          } catch {
            trace = {
              ...trace,
              error: `${trace.error ?? 'Cowork native evidence failed.'} Independent fixture ledger reconciliation failed.`,
            };
          }
          await writePrivateJson(join(caseOutput, 'trace.json'), trace);
          return hostTraceToExecution(
            trace,
            host.evidence ?? 'none',
            config.servers
          );
        },
      },
      {}
    );
    await writePrivateJson(join(config.outputDir, 'results.json'), result);
  } catch (error) {
    await writePrivateJson(join(config.outputDir, 'run-error.json'), {
      error:
        error instanceof Error ? error.message : 'Unknown evaluation error',
    }).catch(() => {});
    throw error;
  } finally {
    if (cua) {
      const disposition = await finishRuntime(cua, { retainAfterSubmit });
      runtimeRetained = disposition.runtimeRetained;
      if (runtimeRetained) retainRuntime(cua);
      await writePrivateJson(
        join(config.outputDir, 'lifecycle.json'),
        disposition
      ).catch(() => {});
    }
  }
  return { result, runtimeRetained };
}

async function readLedger(path: string) {
  const text = await readFile(path, 'utf8');
  return text
    .split('\n')
    .filter(Boolean)
    .map((line) => DesktopLedgerEntrySchema.parse(JSON.parse(line)));
}
