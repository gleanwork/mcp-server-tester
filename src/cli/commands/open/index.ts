/**
 * `mst open`: open a run's report in the browser.
 */

import { describeError } from '../../../utils/describeError.js';
import { existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { runReportPath, writeRunReport } from '../../../evals/runReport.js';
import {
  evalDirectoryOf,
  newestCalibrationTime,
} from '../../../evals/judgeCheck.js';
import {
  hasLocalRuns,
  localHistoryLocation,
  updateHistory,
} from '../../../evals/runHistory.js';
import { loadEvalConfig } from '../../../evals/evalConfig.js';

export interface OpenOptions {
  /** Where runs are written. @default '.mcp-test-results' */
  dir?: string;
  /** Print the report's path instead of opening it. */
  print?: boolean;
  /** Open the eval's history page instead of a run's report. */
  history?: boolean;
  /** With `history`: the eval config whose history to open. */
  config?: string;
  /** With `config`: the eval's directory, if `mst run` was given `--output-dir`. */
  outputDir?: string;
  rootDir?: string;
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
  if (options.history) return openHistory(path, options);
  const root = resolve(options.dir ?? '.mcp-test-results');
  const run = path !== undefined ? await runAt(path) : await newestRun(root);
  if (!run) {
    console.error(
      `No eval runs found under ${root}. Run an eval with \`mst run <eval config>\`, or name a run directory: \`mst open <run directory>\`.`
    );
    process.exit(1);
  }
  let reportPath = runReportPath(run);
  if (
    !existsSync(reportPath) ||
    (await calibratedSince(run)) ||
    (await historySince(run))
  )
    reportPath = await writeRunReport(run);
  await show(reportPath, options);
}

/**
 * The eval directory `mst open --history` means: the one a path names (an
 * eval's directory, or a run's), the eval config's, or the newest eval's.
 * With an eval config, its name too: the history is named for it.
 */
async function historyDirectory(
  path: string | undefined,
  options: OpenOptions
): Promise<{ directory: string; evalName?: string } | undefined> {
  if (path !== undefined) {
    const target = resolve(path);
    return {
      directory: existsSync(join(target, 'run.json'))
        ? evalDirectoryOf(target)
        : target,
    };
  }
  if (options.config) {
    const rootDir = resolve(options.rootDir ?? '.');
    const { name } = loadEvalConfig(options.config, {
      rootDir,
      skipDatasetValidation: true,
    });
    return {
      directory: resolve(
        options.outputDir ?? join(rootDir, '.mcp-test-results', name)
      ),
      evalName: name,
    };
  }
  const run = await newestRun(resolve(options.dir ?? '.mcp-test-results'));
  return run ? { directory: evalDirectoryOf(run) } : undefined;
}

/**
 * Open an eval's history page, `<eval>/history/index.html`, brought up to
 * date with the eval's local runs first.
 */
async function openHistory(
  path: string | undefined,
  options: OpenOptions
): Promise<void> {
  const target = await historyDirectory(path, options);
  const directory = target?.directory;
  if (!directory || !(await hasLocalRuns(directory))) {
    console.error(
      directory
        ? `${directory} has no runs. Name an eval's directory (.mcp-test-results/<eval name>) or its eval config (--config).`
        : `No eval runs found under ${resolve(options.dir ?? '.mcp-test-results')}. Run an eval with \`mst run <eval config>\`.`
    );
    process.exit(1);
  }
  const location = localHistoryLocation(directory);
  await updateHistory(
    location,
    target?.evalName ? { evalName: target.evalName } : {}
  );
  await show(join(directory, 'history', 'index.html'), options);
}

/**
 * Whether the eval got its history page after the run's report was built,
 * so the report has no link to it yet: a run from before MST wrote one.
 */
async function historySince(run: string): Promise<boolean> {
  if (!existsSync(join(evalDirectoryOf(run), 'history', 'index.html')))
    return false;
  const data = await fs
    .readFile(join(run, 'report', 'data.js'), 'utf8')
    .catch(() => '');
  return !data.includes('"historyPath"');
}

/**
 * Whether a judge was checked (`mst judges check`) after the run's report
 * was built, so the report doesn't show its calibration yet.
 */
async function calibratedSince(run: string): Promise<boolean> {
  const newest = await newestCalibrationTime(evalDirectoryOf(run));
  if (newest === undefined) return false;
  const built = await fs.stat(join(run, 'report', 'data.js')).catch(() => null);
  return !built || newest > built.mtimeMs;
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
