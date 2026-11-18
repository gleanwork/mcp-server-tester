/**
 * The repo's shape (ADR 0016): the kinds of file it holds, its top-level
 * directories, its packages, and the core files that import one client
 * product's code. `repoShape.test.ts` runs these checks on the checkout.
 *
 * Each list here is the whole allowance, not a set of examples. A pull
 * request that needs a new entry adds it here, where a reviewer sees it,
 * with the ADR that allows it.
 */
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

/** Tracked files, and new ones not yet added that git doesn't ignore. */
export function trackedFiles(repo: string): string[] {
  return execFileSync(
    'git',
    ['ls-files', '-z', '--cached', '--others', '--exclude-standard'],
    { cwd: repo, encoding: 'utf8' }
  )
    .split('\0')
    .filter((file) => file !== '' && existsSync(path.join(repo, file)));
}

/**
 * The repo's top-level directories. A new one is a new part of the repo, so
 * it needs a decision (ADR 0016), not only an entry here.
 */
export const ROOT_DIRECTORIES = new Set([
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
  'website',
]);

/**
 * The file extensions the repo holds: TypeScript and the JavaScript its
 * tools need, data, docs and assets. No other language is here (ADR 0006).
 */
const FILE_EXTENSIONS = new Set([
  '.ts',
  '.tsx',
  '.mts',
  '.mjs',
  '.cjs',
  '.js',
  '.json',
  '.jsonl',
  '.md',
  '.yml',
  '.svg',
  '.png',
  '.css',
  '.html',
  '.snap',
]);

/** The files the repo holds that have none of those extensions. */
const OTHER_FILES = [
  /^LICENSE$/,
  /(^|\/)\.gitignore$/,
  /^\.prettierignore$/,
  /^\.mise\.toml$/,
  /^\.github\/CODEOWNERS$/,
  /^\.codex\/rules\/permissions\.rules$/,
  /^examples\/[^/]+\/\.env\.example$/,
  // An image's Dockerfile and its entry points, which ADR 0006 allows.
  /^docker\/[^/]+\/Dockerfile$/,
  /^docker\/[^/]+\/bin\/[^/.]+$/,
  // The macOS runner for a source checkout. It predates ADR 0006 and stays.
  /^scripts\/run-cowork\.sh$/,
  // Playwright snapshots.
  /^tests\/__snapshots__\//,
  /^examples\/[^/]+\/tests\/[^/]+-snapshots\/[^/]+\.txt$/,
];

/** The files that are not of a kind the repo holds. */
export function unexpectedFiles(files: string[]): string[] {
  return files.filter(
    (file) =>
      !OTHER_FILES.some((pattern) => pattern.test(file)) &&
      !FILE_EXTENSIONS.has(path.posix.extname(path.posix.basename(file)))
  );
}

/** The top-level directories that `ROOT_DIRECTORIES` doesn't list. */
export function unexpectedRootDirectories(files: string[]): string[] {
  const directories = new Set(
    files
      .filter((file) => file.includes('/'))
      .map((file) => file.split('/')[0] ?? '')
  );
  return [...directories].filter(
    (directory) => directory !== '' && !ROOT_DIRECTORIES.has(directory)
  );
}

/**
 * Where a `package.json` may be. MST is one package. The docs site and each
 * example have their own because they aren't part of it.
 */
const PACKAGES = [
  /^package\.json$/,
  /^website\/package\.json$/,
  /^examples\/[^/]+\/package\.json$/,
];

/** The `package.json` files that would make a second package. */
export function unexpectedPackages(files: string[]): string[] {
  return files.filter(
    (file) =>
      path.posix.basename(file) === 'package.json' &&
      !PACKAGES.some((pattern) => pattern.test(file))
  );
}

/**
 * Product code: the code for one client product, such as Cowork or ChatGPT.
 * A new product's directory or client file goes here.
 */
const PRODUCT_CODE = [
  /^src\/evals\/(cowork|coworkSetup|chatgpt|chatgptSetup|codex-app|codexSetup)\//,
  /^src\/evals\/(coworkClient|chatgptClient|codexClient|auditCoworkNativeRun)\.ts$/,
];

/**
 * The client boundary: the files that may import product code. They add the
 * built-in clients, export a product's public names, or are a product's own
 * CLI command.
 */
const CLIENT_BOUNDARY = [
  /^src\/evals\/builtinClients\.ts$/,
  /^src\/entries\//,
  /^src\/cli\/commands\/cowork\//,
];

/**
 * The core files that import product code today, as `importer -> imported`.
 * This list only gets shorter: a new entry needs an ADR, and an entry whose
 * import is gone is deleted.
 */
export const KNOWN_PRODUCT_IMPORTS = [
  'src/evals/clientTelemetryTypes.ts -> src/evals/cowork/interaction.ts',
  'src/evals/configValidation.ts -> src/evals/cowork/firstParty.ts',
  'src/evals/detach/launch.ts -> src/evals/cowork/firstParty.ts',
  'src/evals/evalConfig.ts -> src/evals/coworkSetup/options.ts',
  'src/evals/runEval.ts -> src/evals/cowork/firstParty.ts',
];

function matches(patterns: RegExp[], file: string): boolean {
  return patterns.some((pattern) => pattern.test(file));
}

/** Whether a source file is core: in `src/`, and no test, product or boundary file. */
function isCoreSource(file: string): boolean {
  return (
    /^src\/.*\.(ts|tsx|mts)$/.test(file) &&
    !/\.test\.tsx?$/.test(file) &&
    !matches(PRODUCT_CODE, file) &&
    !matches(CLIENT_BOUNDARY, file)
  );
}

/**
 * Every import of product code from a core file, as `importer -> imported`,
 * sorted. It counts type-only imports, re-exports and `import()` too: a core
 * file that needs a product's type knows that product.
 */
export function productImports(
  sources: Array<{ file: string; text: string }>
): string[] {
  const found = new Set<string>();
  for (const { file, text } of sources) {
    if (!isCoreSource(file)) continue;
    for (const imported of ts.preProcessFile(text, true, true).importedFiles) {
      if (!imported.fileName.startsWith('.')) continue;
      const target = path.posix
        .normalize(path.posix.join(path.posix.dirname(file), imported.fileName))
        .replace(/\.js$/, '.ts');
      if (matches(PRODUCT_CODE, target)) found.add(`${file} -> ${target}`);
    }
  }
  return [...found].sort();
}
