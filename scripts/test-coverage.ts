/**
 * Runs the unit and use-case tests with coverage, for the diff-coverage check
 * (scripts/diff-coverage.ts). Run it as `npm run test:coverage`. It builds
 * first with `MST_COVERAGE=1`, so the CLI, the desktop drivers and the dry-run
 * proxy have source maps. `--no-build` skips that when the build already ran
 * with `MST_COVERAGE=1`, as CI's does. Other arguments go to Vitest.
 *
 * Coverage comes from two places, and the check counts a line as run when
 * either one ran it:
 *
 * - Vitest's own coverage (`@vitest/coverage-v8`) for code a test imports.
 *   It writes `coverage/unit/coverage-final.json`.
 * - Node's coverage (`NODE_V8_COVERAGE`) for the processes a test starts:
 *   the built `mst` binary, `tsx` entry points, mock servers. Vitest can't
 *   see them. Each process writes a raw file of about 8 MB, mostly copies of
 *   the same source maps, and c8 runs out of memory on the 3 GB a run leaves.
 *   So this compacts the files after each suite: it keeps only this
 *   repository's `src/` and `dist/` scripts, keeps each source map once, and
 *   drops Vitest's own workers (Vitest's coverage covers them). Then c8 maps
 *   what is left to `src/` and writes `coverage/children/coverage-final.json`.
 *
 * The Playwright specs aren't covered: code only they run needs a line under
 * `## Untested` in the pull request.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { Report } from 'c8';

/** A raw coverage file as Node writes it under `NODE_V8_COVERAGE`. */
export interface RawProcessCoverage {
  result: Array<{ url: string; [key: string]: unknown }>;
  timestamp?: number;
  'source-map-cache'?: Record<string, unknown>;
}

/**
 * Scripts in a raw file that mean the process was Vitest or one of its
 * workers. Not all of `node_modules/vitest/`: Vitest puts
 * `--require vitest/suppress-warnings.cjs` in `NODE_OPTIONS`, so every process
 * a test starts loads that file.
 */
const VITEST_WORKER_MARKER = '/node_modules/vitest/dist/';

/**
 * Keeps the part of one process's raw coverage that maps to this repository's
 * code: scripts under `src/` or `dist/`, and the source map of each one not
 * kept before (`keptMaps`, shared across the files of a run, is updated).
 * Returns null for a Vitest worker or a process that ran none of that code.
 */
export function compactProcessCoverage(
  report: RawProcessCoverage,
  rootDir: string,
  keptMaps: Set<string>
): RawProcessCoverage | null {
  if (report.result.some((script) => script.url.includes(VITEST_WORKER_MARKER)))
    return null;
  const root = pathToFileURL(rootDir).href;
  const ours = [`${root}/src/`, `${root}/dist/`];
  const result = report.result.filter((script) =>
    ours.some((prefix) => script.url.startsWith(prefix))
  );
  if (result.length === 0) return null;
  const maps: Record<string, unknown> = {};
  for (const script of result) {
    const map = report['source-map-cache']?.[script.url];
    if (map === undefined || keptMaps.has(script.url)) continue;
    keptMaps.add(script.url);
    maps[script.url] = map;
  }
  return {
    result,
    ...(report.timestamp === undefined ? {} : { timestamp: report.timestamp }),
    ...(Object.keys(maps).length > 0 ? { 'source-map-cache': maps } : {}),
  };
}

/** Compacts every raw file in `rawDir` into `outDir`, deleting each raw file. */
export function compactCoverageDir(
  rawDir: string,
  outDir: string,
  rootDir: string
): number {
  fs.mkdirSync(outDir, { recursive: true });
  const keptMaps = new Set<string>();
  let kept = 0;
  for (const name of fs.readdirSync(rawDir).sort()) {
    if (!name.endsWith('.json')) continue;
    const file = path.join(rawDir, name);
    let report: RawProcessCoverage;
    try {
      report = JSON.parse(fs.readFileSync(file, 'utf8')) as RawProcessCoverage;
    } catch {
      // A process killed while writing leaves a partial file; it ran nothing
      // the check can use.
      fs.rmSync(file);
      continue;
    }
    const compacted = compactProcessCoverage(report, rootDir, keptMaps);
    if (compacted) {
      fs.writeFileSync(path.join(outDir, name), JSON.stringify(compacted));
      kept++;
    }
    fs.rmSync(file);
  }
  return kept;
}

function run(
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv = {}
): void {
  const result = spawnSync(command, args, {
    stdio: 'inherit',
    env: { ...process.env, ...env },
  });
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const rootDir = process.cwd();
  if (!args.includes('--no-build'))
    run('npm', ['run', 'build'], { MST_COVERAGE: '1' });
  if (!fs.existsSync(path.join(rootDir, 'dist/cli/index.js.map'))) {
    console.error(
      'dist/cli has no source map: build with MST_COVERAGE=1, or drop --no-build.'
    );
    process.exit(1);
  }
  const coverageDir = path.join(rootDir, 'coverage');
  const rawDir = path.join(coverageDir, 'raw');
  const compactDir = path.join(coverageDir, 'children-raw');
  fs.rmSync(coverageDir, { recursive: true, force: true });
  fs.mkdirSync(rawDir, { recursive: true });

  const childCoverage = { NODE_V8_COVERAGE: rawDir, MST_COVERAGE: '1' };
  run(
    'npx',
    [
      'vitest',
      'run',
      '--coverage',
      '--coverage.reporter=json',
      `--coverage.reportsDirectory=${path.join(coverageDir, 'unit')}`,
      ...args.filter((arg) => arg !== '--no-build'),
    ],
    childCoverage
  );
  let kept = compactCoverageDir(rawDir, compactDir, rootDir);
  run(
    'npx',
    ['vitest', 'run', '--config', 'vitest.usecases.config.mts'],
    childCoverage
  );
  kept += compactCoverageDir(rawDir, compactDir, rootDir);
  console.log(`Kept coverage from ${kept} child processes.`);

  await reportChildCoverage(compactDir, path.join(coverageDir, 'children'));
}

/**
 * Maps the compacted child coverage to `src/` with c8, as `coverage-final.json`
 * in `reportDir`. It filters on each script's own path (dist/ or src/),
 * before c8 maps it: with `excludeAfterRemap`, c8 loses a bundle's zero
 * counts and reports every line of it as run.
 */
export async function reportChildCoverage(
  compactDir: string,
  reportDir: string
): Promise<void> {
  await new Report({
    tempDirectory: compactDir,
    reportsDirectory: reportDir,
    reporter: ['json'],
    include: ['dist/**', 'src/**'],
    exclude: ['src/**/*.test.ts'],
    excludeNodeModules: true,
  }).run();
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  await main();
