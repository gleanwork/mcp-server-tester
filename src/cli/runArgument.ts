import { existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { RUN_ID_PATTERN } from '../evals/runFormat.js';
import { readJsonFile } from '../utils/jsonFile.js';

/**
 * The run directory a command's `<run>` names: a run directory (it has
 * `run.json`), an eval's directory (its latest run), or a run ID or its
 * short form (`7f3c2a`, `7f3c2a.g2`) among the evals under `root`.
 */
export async function resolveRunArgument(
  run: string,
  root = '.mcp-test-results'
): Promise<string> {
  const target = path.resolve(run);
  if (existsSync(path.join(target, 'run.json'))) return target;
  const latest = await readJsonFile(path.join(target, 'latest.json')).catch(
    () => undefined
  );
  if (
    latest &&
    typeof latest === 'object' &&
    typeof (latest as { path?: unknown }).path === 'string'
  )
    return path.join(target, (latest as { path: string }).path);
  const base = path.resolve(root);
  const evals = await fs.readdir(base).catch(() => [] as string[]);
  const matches: string[] = [];
  for (const name of evals) {
    const runs = path.join(base, name, 'runs');
    for (const id of await fs.readdir(runs).catch(() => [] as string[]))
      if (
        RUN_ID_PATTERN.test(id) &&
        (id === run || id.endsWith(`-${run}`)) &&
        existsSync(path.join(runs, id, 'run.json'))
      )
        matches.push(path.join(runs, id));
  }
  if (matches.length === 1) return matches[0]!;
  if (matches.length > 1)
    throw new Error(
      `"${run}" names ${matches.length} runs: ${matches.join(', ')}. Give the run's directory.`
    );
  throw new Error(
    `"${run}" isn't a run directory (with run.json), an eval directory (with latest.json), or a run ID under ${base}. Give the run's directory, or its eval's results directory with --dir.`
  );
}
