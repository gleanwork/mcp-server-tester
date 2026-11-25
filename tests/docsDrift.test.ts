/**
 * Keeps the docs true to the code where a machine can tell: every `mst`
 * command and flag they show exists, every name they import from the
 * package is exported from that entry point, every code name they put in
 * backticks exists in the repo, and every link to a repo file resolves.
 *
 * `src/evals/docsExamples.test.ts` validates their eval configs and
 * datasets, `docs:check` their snippets, and the site build their links
 * between pages. Mermaid diagrams are parsed in a browser by
 * `tests/site/diagrams.spec.ts`.
 *
 * ADRs and migration guides are records of a moment, and name old commands
 * and code on purpose, so only their links are checked.
 *
 * The CLI check reads the built CLI's help, so build first.
 */
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import packageJson from '../package.json' with { type: 'json' };
import {
  cliInvocations,
  DEFAULT_SUBCOMMANDS,
  invocationProblems,
  linesOutsideRenameTables,
} from './cliInvocations.js';

const REPO = fileURLToPath(new URL('../', import.meta.url));
const PACKAGE = '@gleanwork/mcp-server-tester';

/**
 * The repo's own files: tracked, or new and not ignored. Build output
 * (dist, website/build, website/.vercel, ...) is ignored, and it holds the
 * docs' own text, so scanning it would make every name look like code.
 */
function repoFiles(): string[] {
  return execFileSync(
    'git',
    ['ls-files', '-z', '--cached', '--others', '--exclude-standard'],
    { cwd: REPO, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }
  )
    .split('\0')
    .filter((file) => file !== '' && existsSync(path.join(REPO, file)));
}

const REPO_FILES = repoFiles();

function walk(dir: string, keep: (file: string) => boolean): string[] {
  return REPO_FILES.filter((file) => file.startsWith(`${dir}/`) && keep(file));
}

function isRecord(file: string): boolean {
  return (
    file.startsWith('docs/adr/') ||
    file.startsWith('docs/migrations/') ||
    path.basename(file).startsWith('migration-')
  );
}

/** The pages people read for how MST works now, from the repo root. */
const CURRENT_DOCS = [
  ...walk('docs', (file) => file.endsWith('.md') && !isRecord(file)),
  'README.md',
  'CONTRIBUTING.md',
].sort();

/** Every Markdown file whose links must resolve, records and skills too. */
const LINKED_DOCS = [
  ...walk('docs', (file) => file.endsWith('.md')),
  ...walk('skills', (file) => file.endsWith('.md')),
  'README.md',
  'CONTRIBUTING.md',
].sort();

function read(file: string): string {
  return readFileSync(path.join(REPO, file), 'utf8');
}

/** The text outside fenced code blocks, line for line. */
function prose(text: string): string[] {
  let fenced = false;
  return linesOutsideRenameTables(text).map((line) => {
    if (/^\s*```/.test(line)) {
      fenced = !fenced;
      return '';
    }
    return fenced ? '' : line;
  });
}

interface CodeBlock {
  line: number;
  body: string;
}

function codeBlocks(text: string, languages: string[]): CodeBlock[] {
  const blocks: CodeBlock[] = [];
  for (const match of text.matchAll(/^```(\w+)[^\n]*\n([\s\S]*?)^```/gm)) {
    if (!languages.includes(match[1]!)) continue;
    blocks.push({
      line: text.slice(0, match.index).split('\n').length,
      body: match[2]!,
    });
  }
  return blocks;
}

/**
 * The source file behind each code entry point in package.json's exports.
 * Entry points that ship files rather than code are left out.
 */
const ENTRY_SOURCES: Record<string, string> = {
  '.': 'src/index.ts',
  './evals': 'src/entries/evals.ts',
  './auth': 'src/entries/auth.ts',
  './experimental/clients': 'src/entries/experimentalClients.ts',
  './fixtures/mcp': 'src/fixtures/mcp.ts',
  './fixtures/mcpAuth': 'src/fixtures/mcpAuth.ts',
  './reporters/mcpReporter': 'src/reporters/mcpReporter.ts',
  './types': 'src/types/index.ts',
};

/** Each entry point's exported names, values and types, from the source. */
function entryExports(): Map<string, Set<string>> {
  const config = ts.getParsedCommandLineOfConfigFile(
    path.join(REPO, 'tsconfig.json'),
    {},
    { ...ts.sys, onUnRecoverableConfigFileDiagnostic: () => {} }
  )!;
  const files = Object.values(ENTRY_SOURCES).map((file) =>
    path.join(REPO, file)
  );
  const program = ts.createProgram(files, {
    ...config.options,
    noEmit: true,
  });
  const checker = program.getTypeChecker();
  const exports = new Map<string, Set<string>>();
  for (const [entry, file] of Object.entries(ENTRY_SOURCES)) {
    const source = program.getSourceFile(path.join(REPO, file))!;
    const symbol = checker.getSymbolAtLocation(source)!;
    exports.set(
      entry,
      new Set(checker.getExportsOfModule(symbol).map((item) => item.name))
    );
  }
  return exports;
}

interface PackageImport {
  line: number;
  entry: string;
  names: string[];
}

/** The named imports from the package in a block of TypeScript or JavaScript. */
function packageImports(block: CodeBlock): PackageImport[] {
  const imports: PackageImport[] = [];
  const pattern = new RegExp(
    String.raw`import\s+(?:type\s+)?\{([^}]*)\}\s*from\s*['"]${PACKAGE.replace('/', '\\/')}(\/[^'"]*)?['"]`,
    'g'
  );
  for (const match of block.body.matchAll(pattern)) {
    const names = match[1]!
      .split(',')
      .map(
        (part) =>
          part
            .trim()
            .replace(/^type\s+/, '')
            .split(/\s+as\s+/)[0]!
      )
      .filter(Boolean);
    imports.push({
      line: block.line + block.body.slice(0, match.index).split('\n').length,
      entry: `.${match[2] ?? ''}`,
      names,
    });
  }
  return imports;
}

/**
 * Code names other projects own, which the docs name because users set or
 * call them. Each has a reason, so the list doesn't hide MST's own drift.
 */
const OTHER_PROJECTS_NAMES = new Map([
  ['allowedPluginMcpServers', 'a Claude Desktop policy setting'],
  ['orgPluginSettings', 'a Claude Desktop policy setting'],
  ['showThinkingSummaries', 'a Claude Desktop setting'],
  ['apiKeyHelper', 'a Claude Code setting'],
  ['optionalDependencies', 'a package.json field'],
  ['getPrompt', 'an MCP client method MST does not support'],
]);

/** Every word in the repo's code, schemas and scripts. */
function codeWords(): Set<string> {
  const code = [
    ...walk('src', () => true),
    ...walk('tests', () => true),
    ...walk('scripts', () => true),
    ...walk('schema', () => true),
    ...walk('docker', () => true),
    ...walk('examples', () => true),
    ...walk('website', (file) => /\.(m?[jt]sx?|mts|json)$/.test(file)),
  ].filter((file) => statSync(path.join(REPO, file)).size < 2_000_000);
  const words = new Set<string>();
  for (const file of code) {
    for (const word of read(file).match(/[A-Za-z_$][\w$]*/g) ?? []) {
      words.add(word);
    }
  }
  return words;
}

/** Backticked code names: camelCase or PascalCase, optionally called. */
const CODE_NAME =
  /`([a-z][a-z0-9]*[A-Z][A-Za-z0-9]*|[A-Z][a-z0-9]+[A-Z][A-Za-z0-9]*)(?:\(\))?`/g;

describe('docs drift', () => {
  it('scans no build output, which holds the docs’ own text', () => {
    const probe = path.join(REPO, 'website/.vercel/output/drift-probe.js');
    const existed = existsSync(path.dirname(probe));
    mkdirSync(path.dirname(probe), { recursive: true });
    writeFileSync(probe, 'export const removedDocsName = 1;\n');
    try {
      expect(
        repoFiles().filter((file) => file.startsWith('website/.vercel/'))
      ).toEqual([]);
    } finally {
      rmSync(existed ? probe : path.join(REPO, 'website/.vercel'), {
        recursive: true,
        force: true,
      });
    }
  });

  it('checks every current page', () => {
    // A guard for the lists above: a new page is checked without a change here.
    expect(CURRENT_DOCS).toContain('docs/architecture.md');
    expect(CURRENT_DOCS).not.toContain(
      'docs/adr/0004-environments-run-shards-over-a-channel.md'
    );
    expect(CURRENT_DOCS).not.toContain('docs/migration-0.11.md');
  });

  it('shows only mst commands and flags the CLI has', async () => {
    const problems: string[] = [];
    for (const file of CURRENT_DOCS) {
      for (const words of cliInvocations(read(file))) {
        for (const problem of await invocationProblems(words)) {
          problems.push(`${file}: mst ${words.join(' ')}: ${problem}`);
        }
      }
    }
    expect(problems).toEqual([]);
  }, 120_000);

  it("knows each command's default subcommand", () => {
    const defaults = walk('src/cli', (file) => file.endsWith('.ts'))
      .flatMap((file) => [
        ...read(file).matchAll(
          /\.command\(\s*'([\w-]+)'\s*,\s*\{[^}]*isDefault:\s*true/g
        ),
      ])
      .map((match) => match[1]!)
      .sort();
    expect(defaults).toEqual(Object.values(DEFAULT_SUBCOMMANDS).sort());
  });

  it('knows the source of every code entry point the package exports', () => {
    const codeEntries = Object.entries(packageJson.exports)
      .filter(([, target]) => typeof target === 'object' && 'types' in target)
      .map(([entry]) => entry)
      .sort();
    expect(codeEntries).toEqual(Object.keys(ENTRY_SOURCES).sort());
  });

  it('imports only names the package exports from that entry point', () => {
    const exports = entryExports();
    const problems: string[] = [];
    for (const file of CURRENT_DOCS) {
      for (const block of codeBlocks(read(file), [
        'ts',
        'typescript',
        'tsx',
        'js',
        'javascript',
        'mjs',
      ])) {
        for (const { line, entry, names } of packageImports(block)) {
          const exported = exports.get(entry);
          if (!exported) {
            problems.push(
              `${file}:${line}: the package has no entry point ${entry}`
            );
            continue;
          }
          for (const name of names) {
            if (!exported.has(name)) {
              problems.push(
                `${file}:${line}: ${PACKAGE}${entry.slice(1)} doesn't export ${name}`
              );
            }
          }
        }
      }
    }
    expect(problems).toEqual([]);
  }, 60_000);

  it('names only code that exists', () => {
    const words = codeWords();
    const problems: string[] = [];
    for (const file of CURRENT_DOCS) {
      prose(read(file)).forEach((line, index) => {
        for (const [, name] of line.matchAll(CODE_NAME)) {
          if (words.has(name!) || OTHER_PROJECTS_NAMES.has(name!)) continue;
          problems.push(`${file}:${index + 1}: \`${name}\` is not in the code`);
        }
      });
    }
    expect(problems).toEqual([]);
  });

  it("names other projects' code only where the docs still use it", () => {
    const text = CURRENT_DOCS.map(read).join('\n');
    const unused = [...OTHER_PROJECTS_NAMES.keys()].filter(
      (name) => !text.includes(`\`${name}`)
    );
    expect(unused).toEqual([]);
  });

  it('links only to repo files that exist', () => {
    const problems: string[] = [];
    const repoUrl =
      /https:\/\/github\.com\/gleanwork\/mcp-server-tester\/(?:blob|tree)\/main\/([^\s)#?"'`>]+)/g;
    for (const file of LINKED_DOCS) {
      const text = read(file);
      for (const [, target] of text.matchAll(repoUrl)) {
        if (!existsSync(path.join(REPO, decodeURIComponent(target!)))) {
          problems.push(`${file}: ${target}`);
        }
      }
      // Relative links. The site build checks docs/ too; this also covers
      // the README and CONTRIBUTING, which GitHub renders, and the skills.
      for (const line of prose(text)) {
        for (const [, target] of line.matchAll(
          /\]\(([^)\s#]+)(?:#[^)]*)?\)/g
        )) {
          if (/^[a-z][a-z0-9+.-]*:/i.test(target!)) continue;
          const resolved = path.join(
            REPO,
            path.dirname(file),
            decodeURIComponent(target!)
          );
          if (!existsSync(resolved)) problems.push(`${file}: ${target}`);
        }
      }
    }
    expect(problems).toEqual([]);
  });
});
