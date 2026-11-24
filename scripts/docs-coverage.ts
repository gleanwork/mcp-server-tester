/**
 * Warns when a pull request changes the code a page in docs/ describes and
 * not the page. `docs/code-map.json` says which code each page describes.
 * Run by `.github/workflows/docs-coverage.yml`, with Node's type stripping
 * and no dependencies.
 *
 * It only warns: a change to the code often leaves the page true. The
 * warning asks the author to look, as a GitHub annotation on the page and
 * a line in the job summary. It never fails the build.
 *
 *   node scripts/docs-coverage.ts                  # files changed since origin/$GITHUB_BASE_REF (or origin/main)
 *   node scripts/docs-coverage.ts <file> [file...] # these changed files
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';

export interface CodeMap {
  pages: Record<string, string[]>;
}

export interface StalePage {
  page: string;
  /** The page's code the change touched. */
  changed: string[];
}

/** Whether a change to a file can make a page wrong: tests and snapshots can't. */
function isCode(file: string): boolean {
  return !/\.(test|spec)\.[cm]?[jt]sx?$|(^|\/)__snapshots__\//.test(file);
}

/** Whether a map path covers a file: the file itself, or a directory (`dir/`) above it. */
export function covers(mapPath: string, file: string): boolean {
  return mapPath.endsWith('/') ? file.startsWith(mapPath) : file === mapPath;
}

/** The pages whose code changed while the page didn't, in the map's order. */
export function stalePages(map: CodeMap, changedFiles: string[]): StalePage[] {
  const changed = new Set(changedFiles);
  const code = changedFiles.filter(isCode);
  const stale: StalePage[] = [];
  for (const [page, paths] of Object.entries(map.pages)) {
    if (changed.has(page)) continue;
    const touched = code.filter((file) =>
      paths.some((mapPath) => covers(mapPath, file))
    );
    if (touched.length > 0) stale.push({ page, changed: touched });
  }
  return stale;
}

/** A GitHub annotation and a summary line for each stale page. */
export function report(stale: StalePage[]): {
  annotations: string[];
  summary: string;
} {
  if (stale.length === 0) {
    return {
      annotations: [],
      summary:
        'Every page whose code this pull request changes is changed too.\n',
    };
  }
  const annotations = stale.map(
    ({ page, changed }) =>
      `::warning file=${page},title=Docs may be out of date::This pull request changes ${changed.join(', ')} but not ${page}. Check that the page still describes the code.`
  );
  const summary = [
    '### Pages whose code changed',
    '',
    'This pull request changes code these pages describe, and not the pages. Check that each still matches; `docs/code-map.json` says which code each page describes.',
    '',
    '| Page | Changed code |',
    '| --- | --- |',
    ...stale.map(
      ({ page, changed }) =>
        `| \`${page}\` | ${changed.map((file) => `\`${file}\``).join(', ')} |`
    ),
    '',
  ].join('\n');
  return { annotations, summary };
}

function changedSinceBase(): string[] {
  const base = `origin/${process.env.GITHUB_BASE_REF || 'main'}`;
  return execFileSync('git', ['diff', '--name-only', `${base}...HEAD`], {
    encoding: 'utf8',
  })
    .split('\n')
    .filter(Boolean);
}

function main(): void {
  const map = JSON.parse(
    fs.readFileSync(new URL('../docs/code-map.json', import.meta.url), 'utf8')
  ) as CodeMap;
  const files = process.argv.slice(2);
  const { annotations, summary } = report(
    stalePages(map, files.length > 0 ? files : changedSinceBase())
  );
  for (const annotation of annotations) console.log(annotation);
  const summaryFile = process.env.GITHUB_STEP_SUMMARY;
  if (summaryFile) fs.appendFileSync(summaryFile, summary);
  else if (annotations.length === 0) console.log(summary.trim());
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  main();
