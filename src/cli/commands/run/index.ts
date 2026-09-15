import { readFile, writeFile } from 'node:fs/promises';
import { runExternalHostScenario } from '../../../evals/externalHost/runtime.js';
import { prepareMacCoworkSession } from '../../../evals/coworkSetup/macSession.js';
import type { EvalManifest } from '../../../evals/evalManifest.js';
import type { CoworkMcpServerConfig } from '../../../evals/coworkSetup/config.js';
import type { CoworkSetupConfig } from '../../../evals/coworkSetup/options.js';
import type { ExternalHostConfig } from '../../../evals/externalHost/types.js';

interface ExternalHostRunFile extends ExternalHostConfig {
  scenario?: string;
  query?: string;
  queries?: string[];
  servers?: CoworkMcpServerConfig[];
  coworkSetup?: CoworkSetupConfig;
}

export async function runExternalHostConfigFile(
  configPath: string,
  options: { output?: string; query?: string } = {}
): Promise<number> {
  const raw = JSON.parse(
    await readFile(configPath, 'utf8')
  ) as ExternalHostRunFile;
  const queries = options.query
    ? [options.query]
    : (raw.queries ?? [raw.query ?? raw.scenario ?? '']);
  if (queries.length === 0 || queries.some((query) => !query.trim())) {
    throw new Error(
      'Run config must provide a non-empty scenario, query, or queries array.'
    );
  }

  const {
    scenario: _scenario,
    query: _query,
    queries: _queries,
    servers: _servers,
    coworkSetup: _coworkSetup,
    ...externalHost
  } = raw;
  process.stderr.write(
    `[mst:run] loaded ${queries.length} quer${queries.length === 1 ? 'y' : 'ies'} from ${configPath}\n`
  );
  let setupSession: { dispose(): Promise<void> } | undefined;
  try {
    if (raw.servers !== undefined) {
      if (raw.servers.length === 0) {
        process.stderr.write(
          '[mst:run] managed Cowork setup requested with zero MCP servers\n'
        );
      } else {
        process.stderr.write(
          `[mst:run] preparing Claude once with ${raw.servers.length} managed MCP server(s); read/write tools will be allowed\n`
        );
      }
      const manifest: EvalManifest = {
        name: 'mst-config-run',
        datasets: [],
        servers: raw.servers,
        coworkSetup: {
          ...raw.coworkSetup,
          approveWriteTools: true,
        },
      };
      setupSession = await prepareMacCoworkSession({
        manifest,
        env: process.env,
      });
      process.stderr.write('[mst:run] Claude setup complete\n');
    } else {
      process.stderr.write(
        '[mst:run] managed Claude setup skipped: config has no servers\n'
      );
    }

    const results = [];
    for (const [index, query] of queries.entries()) {
      process.stderr.write(
        `[mst:run] starting query ${index + 1}/${queries.length}\n`
      );
      const result = await runExternalHostScenario(query, externalHost, {
        caseId: `config-run-${index + 1}`,
      });
      results.push(result);
      process.stderr.write(
        `[mst:run] query ${index + 1}/${queries.length} ${result.success ? 'succeeded' : `failed: ${result.error ?? 'unknown error'}`}\n`
      );
    }

    const output = JSON.stringify(
      {
        success: results.every((result) => result.success),
        results,
        telemetry: results.map((result, index) => ({
          queryIndex: index + 1,
          success: result.success,
          response: result.success ? result.response : undefined,
          toolCalls: result.toolCalls,
          usage: result.success ? result.usage : undefined,
          llmDurationMs: result.success ? result.llmDurationMs : undefined,
          mcpDurationMs: result.success ? result.mcpDurationMs : undefined,
          externalHost: result.externalHost,
        })),
      },
      null,
      2
    );
    if (options.output) await writeFile(options.output, `${output}\n`, 'utf8');
    else process.stdout.write(`${output}\n`);
    return results.every((result) => result.success) ? 0 : 1;
  } finally {
    if (setupSession) {
      process.stderr.write('[mst:run] restoring Claude configuration\n');
      await setupSession.dispose();
      process.stderr.write('[mst:run] Claude configuration restored\n');
    }
  }
}
