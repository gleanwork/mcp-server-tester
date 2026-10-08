/**
 * `mst open`: open a run's report in the browser.
 */

import { describeError } from '../../../utils/describeError.js';
import { existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { runReportPath, writeRunReport } from '../../../evals/runReport.js';

export interface OpenOptions {
  /** Where runs are written. @default '.mcp-test-results' */
  dir?: string;
  /** Print the report's path instead of opening it. */
  print?: boolean;
}

interface Latest {
  runId: string;
  createdAt: string;
  path: string;
}

/** The newest complete run among the evals under `root` (each eval's latest.json). */
async function newestRun(root: string): Promise<string | undefined> {
  let entries: string[];
  try {
    entries = await fs.readdir(root);
  } catch {
    return undefined;
  }
  let newest: { directory: string; createdAt: string } | undefined;
  for (const entry of entries) {
    const latest = await readLatest(join(root, entry));
    if (latest && (!newest || latest.createdAt > newest.createdAt))
      newest = {
        directory: join(root, entry, latest.path),
        createdAt: latest.createdAt,
      };
  }
  return newest?.directory;
}

async function readLatest(evalDirectory: string): Promise<Latest | undefined> {
  try {
    return JSON.parse(
      await fs.readFile(join(evalDirectory, 'latest.json'), 'utf8')
    ) as Latest;
  } catch {
    return undefined;
  }
}

/**
 * The run a path names: a run directory (it has run.json), or an eval's
 * directory (it has latest.json), which means its latest run.
 */
async function runAt(path: string): Promise<string> {
  const target = resolve(path);
  if (existsSync(join(target, 'run.json'))) return target;
  const latest = await readLatest(target);
  if (latest) return join(target, latest.path);
  throw new Error(
    `${target} is neither a run directory (with run.json) nor an eval's results directory (with latest.json).`
  );
}

/**
 * Open a run's report: the newest local run, or the run (or eval) `path`
 * names. A run without a report, such as one copied without its `report/`
 * directory, gets one written from its files first.
 */
export async function open(
  path: string | undefined,
  options: OpenOptions
): Promise<void> {
  const root = resolve(options.dir ?? '.mcp-test-results');
  const run = path !== undefined ? await runAt(path) : await newestRun(root);
  if (!run) {
    console.error(
      `No eval runs found under ${root}. Run an eval with \`mst run <eval config>\`, or name a run directory: \`mst open <run directory>\`.`
    );
    process.exit(1);
  }
  let reportPath = runReportPath(run);
  if (!existsSync(reportPath)) reportPath = await writeRunReport(run);
  await show(reportPath, options);
}

async function show(reportPath: string, options: OpenOptions): Promise<void> {
  if (options.print) {
    console.log(reportPath);
    return;
  }
  console.log(`Opening report: ${reportPath}`);
  try {
    const { default: openBrowser } = await import('open');
    await openBrowser(reportPath);
  } catch (error) {
    console.error(`Failed to open report in browser: ${describeError(error)}`);
    console.error(`Open manually: file://${reportPath}`);
    process.exit(1);
  }
}
