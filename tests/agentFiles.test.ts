/**
 * The files coding agents and contributors read first: AGENTS.md, CONTEXT.md,
 * REVIEW.md, CONTRIBUTING.md and RELEASE.md. They name files, directories and
 * package exports in prose, which no build or type check reads, so a rename
 * or a removal leaves them pointing at code that no longer exists. This keeps
 * them true to the repo:
 *
 * - every repo path they show in code is a tracked file or directory. A path
 *   that starts with a top-level directory (`docker/cowork-linux/`) must
 *   exist from the repo root; any other (`runners/collect.ts`, written
 *   relative to `src/`) is matched by its whole trailing path. Either way a
 *   renamed directory fails as well as a renamed file;
 * - every relative link resolves, and its `#anchor` names a heading there;
 * - AGENTS.md names every package export, and CONTEXT.md every extension kind.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import packageJson from '../package.json' with { type: 'json' };
import { KIND_SEGMENTS } from '../src/plugins/plugin.js';

const REPO = fileURLToPath(new URL('../', import.meta.url));

const AGENT_FILES = [
  'AGENTS.md',
  'CONTEXT.md',
  'REVIEW.md',
  'CONTRIBUTING.md',
  'RELEASE.md',
];

/** Paths in these files that name a run's output, not a repo file. */
const NOT_REPO_PATHS = new Set([
  'dist/',
  'runs/',
  'transcripts/',
  'scores/containsText/',
]);

/**
 * The repo's top-level directories. A path that starts with one is matched
 * from the root only, so `skills/` can't pass on `src/skills/` once the
 * top-level `skills/` is gone. This is a fixed list, not read from the
 * checkout, for that reason; a test below fails when a new top-level
 * directory is missing from it.
 */
const ROOT_DIRECTORIES = new Set([
  '.claude',
  '.claude-plugin',
  '.codex',
  '.github',
  'assets',
  'data',
  'docker',
  'docs',
  'examples',
  'schema',
  'scripts',
  'skills',
  'snippets',
  'src',
  'tests',
  'verifiers',
  'website',
]);

/** File extensions a bare file name (no directory) is checked for. */
const SOURCE_FILE = /\.(ts|tsx|mts|mjs|cjs|js|swift)$/;

/** Extensions a path with a directory is checked for. */
const REPO_FILE = /\.(ts|tsx|mts|mjs|cjs|js|swift|json|md|yml|yaml)$/;

function read(file: string): string {
  return readFileSync(path.join(REPO, file), 'utf8');
}

/** Tracked files, and new ones not yet added that git doesn't ignore. */
function trackedFiles(): string[] {
  return execFileSync(
    'git',
    ['ls-files', '-z', '--cached', '--others', '--exclude-standard'],
    { cwd: REPO, encoding: 'utf8' }
  )
    .split('\0')
    .filter((file) => file !== '' && existsSync(path.join(REPO, file)));
}

/** `cowork/{macos,linux}.ts` is `cowork/macos.ts` and `cowork/linux.ts`. */
function expandBraces(text: string): string[] {
  const match = /\{([^{}]+)\}/.exec(text);
  if (!match?.[1]) return [text];
  const [braces, choices] = match;
  return choices
    .split(',')
    .flatMap((part) => expandBraces(text.replace(braces, part)));
}

/** The repo paths a Markdown file shows in inline code. */
function codePaths(markdown: string): string[] {
  const prose = markdown.replace(/^```[\s\S]*?^```/gm, '');
  const spans = [...prose.matchAll(/`([^`\s]+)`/g)].map(
    (match) => match[1] ?? ''
  );
  return spans
    .flatMap(expandBraces)
    .filter(
      (span) =>
        !/[<>*~@$]|:\/\//.test(span) &&
        !span.startsWith('./') &&
        !/(^|\/)(my|toMy)[A-Z]/.test(span) &&
        !NOT_REPO_PATHS.has(span)
    )
    .filter((span) =>
      span.includes('/')
        ? REPO_FILE.test(span) || span.endsWith('/')
        : SOURCE_FILE.test(span)
    );
}

/** Whether a path the docs show names a tracked file or directory. */
function existsInRepo(shown: string, files: string[]): boolean {
  const [first] = shown.split('/');
  if (shown.includes('/') && first && ROOT_DIRECTORIES.has(first)) {
    return shown.endsWith('/')
      ? files.some((file) => file.startsWith(shown))
      : files.includes(shown);
  }
  if (shown.endsWith('/')) {
    return files.some(
      (file) => file.startsWith(shown) || file.includes(`/${shown}`)
    );
  }
  return files.some((file) => file === shown || file.endsWith(`/${shown}`));
}

/** GitHub's anchor for a heading. */
function slug(heading: string): string {
  return heading
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, '')
    .replace(/\s/g, '-');
}

function headingSlugs(markdown: string): Set<string> {
  return new Set(
    [...markdown.matchAll(/^#{1,6}\s+(.+)$/gm)].map((match) =>
      slug(match[1] ?? '')
    )
  );
}

/** Relative link targets, without `http(s):` and `mailto:` links. */
function relativeLinks(markdown: string): string[] {
  const prose = markdown.replace(/^```[\s\S]*?^```/gm, '');
  return [...prose.matchAll(/\]\(([^)\s]+)\)/g)]
    .map((match) => match[1] ?? '')
    .filter((target) => !/^[a-z]+:/.test(target));
}

describe('existsInRepo', () => {
  const files = [
    'skills/review/SKILL.md',
    'src/skills/client.ts',
    'src/evals/runners/collect.ts',
  ];

  it('matches a path under a top-level directory from the root only', () => {
    expect(existsInRepo('skills/', files)).toBe(true);
    expect(existsInRepo('skills/', files.slice(1))).toBe(false);
    expect(existsInRepo('src/evals/runners/collect.ts', files)).toBe(true);
    expect(existsInRepo('src/runners/collect.ts', files)).toBe(false);
  });

  it('matches any other path by its whole trailing path', () => {
    expect(existsInRepo('runners/collect.ts', files)).toBe(true);
    expect(existsInRepo('environments/collect.ts', files)).toBe(false);
    expect(existsInRepo('runners/', files)).toBe(true);
    expect(existsInRepo('collect.ts', files)).toBe(true);
  });
});

describe('agent files', () => {
  const files = trackedFiles();

  it('lists every top-level directory in ROOT_DIRECTORIES', () => {
    const directories = new Set(
      files
        .filter((file) => file.includes('/'))
        .map((file) => file.split('/')[0])
    );
    const unlisted = [...directories].filter(
      (directory) => directory && !ROOT_DIRECTORIES.has(directory)
    );
    expect(unlisted, 'add these to ROOT_DIRECTORIES').toEqual([]);
  });

  describe.each(AGENT_FILES)('%s', (file) => {
    const markdown = read(file);

    it('shows only repo paths that exist', () => {
      const missing = codePaths(markdown).filter(
        (shown) => !existsInRepo(shown, files)
      );
      expect(missing, `${file} names paths that don't exist`).toEqual([]);
    });

    it('links only to files and headings that exist', () => {
      const broken = relativeLinks(markdown).filter((target) => {
        const [linkPath = '', anchor] = target.split('#');
        const resolved = linkPath
          ? path.join(path.dirname(file), linkPath)
          : file;
        if (!existsSync(path.join(REPO, resolved))) return true;
        if (!anchor || !resolved.endsWith('.md')) return false;
        return !headingSlugs(read(resolved)).has(anchor);
      });
      expect(broken, `${file} has broken links`).toEqual([]);
    });
  });

  it('AGENTS.md names every package export', () => {
    const agents = read('AGENTS.md');
    const unnamed = Object.keys(packageJson.exports).filter(
      (subpath) =>
        subpath !== '.' &&
        subpath !== './package.json' &&
        !agents.includes(`\`${subpath}\``)
    );
    expect(unnamed, 'add these exports to "Exports" in AGENTS.md').toEqual([]);
  });

  it('CONTEXT.md names every extension kind', () => {
    const context = read('CONTEXT.md');
    const unnamed = Object.values(KIND_SEGMENTS).filter(
      (kind) => !context.includes(`(\`${kind}\`)`)
    );
    expect(unnamed, 'add these kinds to "Extension" in CONTEXT.md').toEqual([]);
  });
});
