import { readFile, writeFile } from 'node:fs/promises';
import { runExternalHostScenario } from '../../../evals/externalHost/runtime.js';
import type { ExternalHostConfig } from '../../../evals/externalHost/types.js';

interface ExternalHostRunFile extends ExternalHostConfig {
  scenario?: string;
  query?: string;
  queries?: string[];
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
    ...externalHost
  } = raw;
  process.stderr.write(
    `[mst:run] loaded ${queries.length} quer${queries.length === 1 ? 'y' : 'ies'} from ${configPath}\n`
  );
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
    { success: results.every((result) => result.success), results },
    null,
    2
  );
  if (options.output) await writeFile(options.output, `${output}\n`, 'utf8');
  else process.stdout.write(`${output}\n`);
  return results.every((result) => result.success) ? 0 : 1;
}
