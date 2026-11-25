/**
 * Fails a pull request whose added or changed lines in `src/` no test runs.
 * Run by `.github/workflows/ci.yml` after `npm run test:coverage`
 * (scripts/test-coverage.ts), and locally with `npm run coverage:diff`.
 *
 * A line counts when the unit tests' coverage (Vitest's, which knows the
 * TypeScript) has a statement that starts on it: comments, types and blank
 * lines don't. It counts as run when the unit tests ran it or a process a test
 * started did. That second coverage comes from c8 and is line by line, so it
 * adds runs but never makes a line count. The React report UI
 * (`src/reporters/ui-src/`) is left out: only the Playwright specs render it,
 * and they aren't covered.
 *
 * When a path can't be tested, the pull request names it under an
 * `## Untested` heading in its description, one list item per path with the
 * reason, as AGENTS.md asks. Other text under the heading is ignored:
 *
 *     ## Untested
 *     - `src/evals/cowork/macos.ts`: drives the macOS app, which CI can't run.
 *     - `src/cli/index.ts:120-134`: only runs without a TTY on Windows.
 *
 * A path with no line range excuses every line of the file. The check reads
 * the description when it runs, so after editing it, re-run the job.
 *
 * A changed file the unit coverage has no entry for fails: the check can't
 * tell which of its lines run. Vitest's coverage includes every file in
 * `src/`, so that only happens when `vitest.config.mts` excludes one.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

/** The part of an Istanbul `coverage-final.json` entry this check reads. */
export interface FileCoverage {
  statementMap: Record<string, { start: { line: number } }>;
  s: Record<string, number>;
}

export type CoverageMap = Record<string, FileCoverage>;

/** Repository-relative path to line numbers. */
export type LinesByFile = Map<string, Set<number>>;

/** Repository-relative path to the run count of each line with a statement. */
export type HitsByFile = Map<string, Map<number, number>>;

/** One line under `## Untested`: a path, an optional line range, a reason. */
export interface UntestedEntry {
  file: string;
  lines: { start: number; end: number } | null;
  reason: string;
}

export interface UntestedSection {
  entries: UntestedEntry[];
  /** List items under the heading that name no path or give no reason. */
  invalid: string[];
}

const DEFAULT_RANGE = 'origin/main...HEAD';

const DEFAULT_UNIT_COVERAGE = 'coverage/unit/coverage-final.json';
const DEFAULT_CHILD_COVERAGE = 'coverage/children/coverage-final.json';

/** Whether the check covers a changed file. */
export function isCheckedFile(file: string): boolean {
  return (
    /^src\/.*\.tsx?$/.test(file) &&
    !/\.(test|spec)\.tsx?$/.test(file) &&
    !file.endsWith('.d.ts') &&
    !file.startsWith('src/reporters/ui-src/')
  );
}

/** The lines each file adds or changes, from `git diff --unified=0`. */
export function parseChangedLines(diff: string): LinesByFile {
  const changed: LinesByFile = new Map();
  let lines: Set<number> | null = null;
  for (const line of diff.split('\n')) {
    if (line.startsWith('+++ ')) {
      const file = line.slice(4).replace(/^b\//, '');
      if (file === '/dev/null' || !isCheckedFile(file)) {
        lines = null;
        continue;
      }
      lines = changed.get(file) ?? new Set();
      changed.set(file, lines);
      continue;
    }
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (hunk && lines) {
      const start = Number(hunk[1]);
      const count = hunk[2] === undefined ? 1 : Number(hunk[2]);
      for (let n = start; n < start + count; n++) lines.add(n);
    }
  }
  for (const [file, set] of changed) if (set.size === 0) changed.delete(file);
  return changed;
}

/** Each file's lines with a statement, and the most any one of them ran. */
function mapLines(map: CoverageMap, rootDir: string): HitsByFile {
  const hits: HitsByFile = new Map();
  for (const [absolute, coverage] of Object.entries(map)) {
    const file = path.relative(rootDir, absolute).split(path.sep).join('/');
    const fileHits = new Map<number, number>();
    for (const [id, location] of Object.entries(coverage.statementMap)) {
      const line = location.start.line;
      fileHits.set(
        line,
        Math.max(fileHits.get(line) ?? 0, coverage.s[id] ?? 0)
      );
    }
    hits.set(file, fileHits);
  }
  return hits;
}

/**
 * The run count of each line with a statement in `statementMaps`, plus what
 * `extraMaps` ran on those lines. A line only `extraMaps` has is left out.
 */
export function lineHits(
  statementMaps: CoverageMap[],
  extraMaps: CoverageMap[],
  rootDir: string
): HitsByFile {
  const hits: HitsByFile = new Map();
  for (const map of statementMaps) {
    for (const [file, lines] of mapLines(map, rootDir)) {
      const fileHits = hits.get(file) ?? new Map<number, number>();
      hits.set(file, fileHits);
      for (const [line, runs] of lines)
        fileHits.set(line, (fileHits.get(line) ?? 0) + runs);
    }
  }
  for (const map of extraMaps) {
    for (const [file, lines] of mapLines(map, rootDir)) {
      const fileHits = hits.get(file);
      if (!fileHits) continue;
      for (const [line, runs] of lines) {
        const known = fileHits.get(line);
        if (known !== undefined) fileHits.set(line, known + runs);
      }
    }
  }
  return hits;
}

/** Reads the `## Untested` section of a pull request description. */
export function parseUntested(body: string): UntestedSection {
  const section: UntestedSection = { entries: [], invalid: [] };
  let inSection = false;
  let inFence = false;
  // The pull request template's hint is an HTML comment under the heading.
  const visible = body.replace(/<!--[\s\S]*?-->/g, '');
  for (const raw of visible.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith('```')) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const heading = /^#{1,6}\s+(.*?)\s*#*$/.exec(line);
    if (heading) {
      inSection = /^untested$/i.test(heading[1]!);
      continue;
    }
    // Only list items are entries; prose under the heading is the author's.
    if (!inSection || !/^[-*]\s/.test(line)) continue;
    const entry =
      /^[-*]\s+`([^`:]+)(?::(\d+)(?:-(\d+))?)?`\s*[:\u2013\u2014-]?\s*(.*)$/.exec(
        line
      );
    const reason = entry?.[4]?.trim() ?? '';
    if (!entry || reason === '') {
      section.invalid.push(line);
      continue;
    }
    const start = entry[2] === undefined ? null : Number(entry[2]);
    const end = entry[3] === undefined ? start : Number(entry[3]);
    section.entries.push({
      file: entry[1]!.replace(/^\.\//, ''),
      lines: start === null || end === null ? null : { start, end },
      reason,
    });
  }
  return section;
}

/** The changed lines that have a statement and that no test ran. */
export function uncoveredLines(
  changed: LinesByFile,
  hits: HitsByFile
): LinesByFile {
  const uncovered: LinesByFile = new Map();
  for (const [file, lines] of changed) {
    const fileHits = hits.get(file);
    if (!fileHits) continue;
    const missed = [...lines].filter((line) => fileHits.get(line) === 0);
    if (missed.length > 0) uncovered.set(file, new Set(missed));
  }
  return uncovered;
}

/** The changed files the unit coverage has no entry for. */
export function unmappedFiles(
  changed: LinesByFile,
  hits: HitsByFile
): string[] {
  return [...changed.keys()].filter((file) => !hits.has(file));
}

/** Splits uncovered lines into those `## Untested` excuses and the rest. */
export function applyUntested(
  uncovered: LinesByFile,
  entries: UntestedEntry[]
): { excused: LinesByFile; failing: LinesByFile } {
  const excused: LinesByFile = new Map();
  const failing: LinesByFile = new Map();
  for (const [file, lines] of uncovered) {
    for (const line of lines) {
      const isExcused = entries.some(
        (entry) =>
          entry.file === file &&
          (entry.lines === null ||
            (line >= entry.lines.start && line <= entry.lines.end))
      );
      const target = isExcused ? excused : failing;
      const set = target.get(file) ?? new Set<number>();
      set.add(line);
      target.set(file, set);
    }
  }
  return { excused, failing };
}

/** `[3, 4, 5, 9]` as `3-5, 9`. */
export function formatRanges(lines: Iterable<number>): string {
  const sorted = [...lines].sort((a, b) => a - b);
  const ranges: string[] = [];
  for (let i = 0; i < sorted.length; i++) {
    const start = sorted[i]!;
    while (i + 1 < sorted.length && sorted[i + 1] === sorted[i]! + 1) i++;
    const end = sorted[i]!;
    ranges.push(start === end ? `${start}` : `${start}-${end}`);
  }
  return ranges.join(', ');
}

function count(lines: LinesByFile): number {
  let total = 0;
  for (const set of lines.values()) total += set.size;
  return total;
}

/** The report the check prints, and whether it passes. */
export function report(
  changed: LinesByFile,
  hits: HitsByFile,
  untested: UntestedSection
): { ok: boolean; text: string } {
  const { excused, failing } = applyUntested(
    uncoveredLines(changed, hits),
    untested.entries
  );
  const unmapped = unmappedFiles(changed, hits);
  const unmappedFailing = unmapped.filter(
    (file) => !untested.entries.some((entry) => entry.file === file)
  );
  const out: string[] = [];
  for (const line of untested.invalid) {
    out.push(`## Untested item names no \`path\` or gives no reason: ${line}`);
  }
  for (const [file, lines] of excused) {
    out.push(`Excused by ## Untested: ${file}:${formatRanges(lines)}`);
  }
  for (const file of unmapped.filter((f) => !unmappedFailing.includes(f))) {
    out.push(`Excused by ## Untested: ${file}`);
  }
  for (const file of unmappedFailing) {
    out.push(
      `${file} changed but has no unit coverage, so no line of it can be checked. Remove what excludes it from coverage in vitest.config.mts.`
    );
  }
  if (
    failing.size === 0 &&
    unmappedFailing.length === 0 &&
    untested.invalid.length === 0
  ) {
    out.push(`Every changed line in src/ that has a statement runs in a test.`);
    return { ok: true, text: out.join('\n') };
  }
  if (failing.size > 0) {
    out.push(`${count(failing)} changed lines in src/ run in no test:`);
    for (const [file, lines] of failing)
      out.push(`  ${file}:${formatRanges(lines)}`);
    out.push(
      '',
      'Add a test that runs them. If a path cannot be tested, name it under',
      '## Untested in the pull request description with the reason, for example:',
      '',
      '  ## Untested',
      '  - `src/evals/cowork/macos.ts:40-52`: drives the macOS app, which CI cannot run.',
      '',
      'Then re-run this job: it reads the description when it runs.'
    );
  }
  return { ok: false, text: out.join('\n') };
}

/** `::error` annotations, so GitHub marks the lines in the diff. */
export function annotations(
  failing: LinesByFile,
  unmapped: string[] = []
): string[] {
  const out: string[] = [];
  for (const file of unmapped) {
    out.push(
      `::error file=${file},title=No coverage for this file::vitest.config.mts excludes it from coverage, so the check cannot tell which lines run.`
    );
  }
  for (const [file, lines] of failing) {
    const sorted = [...lines].sort((a, b) => a - b);
    for (const range of formatRanges(sorted).split(', ')) {
      const [start, end = start] = range.split('-');
      out.push(
        `::error file=${file},line=${start},endLine=${end},title=No test runs this::Add a test, or name it under ## Untested in the pull request description.`
      );
    }
  }
  return out;
}

function argValue(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
}

/** The pull request description: from GitHub when run in Actions, else `--body-file`. */
async function readBody(args: string[]): Promise<string> {
  const bodyFile = argValue(args, '--body-file');
  if (bodyFile) return fs.readFileSync(bodyFile, 'utf8');
  const eventPath = process.env.GITHUB_EVENT_PATH;
  if (!eventPath) return '';
  const event = JSON.parse(fs.readFileSync(eventPath, 'utf8')) as {
    pull_request?: { number: number };
  };
  if (!event.pull_request) return '';
  // Read it now, not from the event: a re-run keeps the event it started with.
  const api = process.env.GITHUB_API_URL ?? 'https://api.github.com';
  const response = await fetch(
    `${api}/repos/${process.env.GITHUB_REPOSITORY}/pulls/${event.pull_request.number}`,
    {
      headers: {
        accept: 'application/vnd.github+json',
        ...(process.env.GITHUB_TOKEN
          ? { authorization: `Bearer ${process.env.GITHUB_TOKEN}` }
          : {}),
      },
    }
  );
  if (!response.ok) {
    throw new Error(
      `Reading the pull request failed: ${response.status} ${await response.text()}`
    );
  }
  return ((await response.json()) as { body: string | null }).body ?? '';
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const rootDir = process.cwd();
  const range = argValue(args, '--range') ?? DEFAULT_RANGE;
  const readMap = (file: string): CoverageMap => {
    if (!fs.existsSync(file)) {
      throw new Error(
        `${file} is missing. Run \`npm run test:coverage\` first.`
      );
    }
    return JSON.parse(fs.readFileSync(file, 'utf8')) as CoverageMap;
  };
  const unit = readMap(argValue(args, '--unit') ?? DEFAULT_UNIT_COVERAGE);
  const children = readMap(
    argValue(args, '--children') ?? DEFAULT_CHILD_COVERAGE
  );
  const diff = execFileSync(
    'git',
    [
      'diff',
      '--unified=0',
      '--no-color',
      '--no-ext-diff',
      '-M',
      range,
      '--',
      'src',
    ],
    { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 }
  );
  const changed = parseChangedLines(diff);
  const hits = lineHits([unit], [children], rootDir);
  const untested = parseUntested(await readBody(args));
  const result = report(changed, hits, untested);
  console.log(result.text);
  if (!result.ok && process.env.GITHUB_ACTIONS === 'true') {
    const { failing } = applyUntested(
      uncoveredLines(changed, hits),
      untested.entries
    );
    const unmapped = unmappedFiles(changed, hits).filter(
      (file) => !untested.entries.some((entry) => entry.file === file)
    );
    for (const line of annotations(failing, unmapped)) console.log(line);
  }
  process.exitCode = result.ok ? 0 : 1;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
