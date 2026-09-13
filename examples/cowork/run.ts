import { join } from 'node:path';
import {
  connectCoworkCua,
  createCoworkHost,
  getHost,
  hostTraceToExecution,
  loadEvalDatasetFromObject,
  registerHost,
  runEvalDataset,
  type CoworkCuaConnection,
  type EvalManifest,
  type EvalRunnerResult,
} from '@gleanwork/mcp-server-tester';
import {
  checkUnused,
  FIXTURE_LABEL,
  FIXTURE_TOOL,
  fixtureReceiptPath,
  parseConfig,
  readEvaluator,
  SCENARIO,
  type CoworkExampleConfig,
} from './config.js';
import { createPrivateDirectory, writePrivateJson } from './files.js';
import { finishRuntime, retainRuntime } from './lifecycle.js';

let used = false;

export async function runCoworkExample(input: CoworkExampleConfig) {
  if (used) throw new Error('Use a new worker for each Cowork evaluation');
  used = true;
  const config = parseConfig(input);
  await checkUnused(config);
  const { expectedText } = await readEvaluator(config);
  await createPrivateDirectory(config.outputDir);
  let cua: CoworkCuaConnection | undefined;
  let quarantined = false;
  let runtimeRetained = false;
  let result: EvalRunnerResult;
  try {
    cua = await connectCoworkCua({ command: config.runtimePath });
    const host = createCoworkHost({
      cua,
      dataDir: config.dataDir,
      expectedServers: config.servers,
      mcpServerPrefixes: config.mcpServerPrefixes,
      async checkpoint(receipt) {
        // The fixture-side receipt also blocks reuse with a different outputDir.
        await writePrivateJson(fixtureReceiptPath(config), receipt);
        await writePrivateJson(join(config.outputDir, 'armed.json'), receipt);
      },
      async record(record) {
        // Remember quarantine before persistence: a disk failure cannot release it.
        quarantined ||= record.quarantined;
        await writePrivateJson(
          join(config.outputDir, 'diagnostics.json'),
          record
        );
      },
    });
    registerHost(host);
    const toolMap = {
      [FIXTURE_TOOL]: Object.keys(config.mcpServerPrefixes).map(
        (prefix) => `${prefix}${FIXTURE_TOOL}`
      ),
    };
    const manifest: EvalManifest = {
      name: 'provisioned-cowork-nonce-example',
      datasets: [{ type: 'inline' }],
      servers: config.servers,
      host: { type: host.name, timeout: 120_000 },
      toolMap,
    };
    const dataset = loadEvalDatasetFromObject({
      name: manifest.name,
      cases: [
        {
          id: 'native-nonce-tool-call',
          mode: 'host',
          scenario: SCENARIO,
          expect: {
            containsText: [expectedText],
            toolsTriggered: {
              calls: [
                {
                  name: FIXTURE_TOOL,
                  kind: 'tool_call',
                  source: 'mcp',
                  server: FIXTURE_LABEL,
                  required: true,
                },
              ],
              exclusive: true,
            },
            toolCallCount: { exact: 1 },
          },
        },
      ],
    });
    result = await runEvalDataset(
      {
        dataset,
        toolMap,
        concurrency: 1,
        async executeCase(evalCase) {
          const definition = getHost(host.name);
          if (!definition.run) throw new Error('Cowork host is missing run');
          // The controller sees only the scenario/config, never the expectation.
          const trace = await definition.run(
            { scenario: evalCase.scenario ?? '', servers: config.servers },
            manifest.host!,
            { manifest }
          );
          return hostTraceToExecution(
            trace,
            definition.evidence ?? 'none',
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
    }).catch(() => {
      console.error(
        'Could not persist run-error.json; preserve this worker and output directory.'
      );
    });
    throw error;
  } finally {
    if (cua) {
      const disposition = await finishRuntime(cua, quarantined);
      runtimeRetained = disposition.runtimeRetained;
      if (runtimeRetained) {
        retainRuntime(cua);
        console.error(
          'Cua runtime retained. Do not interrupt this worker, retry, or control the desktop ' +
            'until manual reconciliation. See lifecycle.json and the Cowork README.'
        );
      }
      await writePrivateJson(
        join(config.outputDir, 'lifecycle.json'),
        disposition
      ).catch(() => {
        // Cleanup/persistence errors must not replace the canonical result/error.
        console.error(
          'Could not persist lifecycle.json; original results/diagnostics are unchanged.'
        );
      });
    }
  }
  return { result, runtimeRetained };
}
