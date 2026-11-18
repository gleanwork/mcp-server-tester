/**
 * Keeps the repo to its shape (ADR 0016). A pull request that adds another
 * language, a second package, a new top-level directory, or a core file that
 * imports one product's code fails here, and the message says where that
 * change belongs.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import packageJson from '../package.json' with { type: 'json' };
import {
  KNOWN_PRODUCT_IMPORTS,
  productImports,
  trackedFiles,
  unexpectedFiles,
  unexpectedPackages,
  unexpectedRootDirectories,
} from './repoShape.js';

const REPO = fileURLToPath(new URL('../', import.meta.url));

const ADR = 'docs/adr/0016-mst-holds-only-what-every-mst-user-needs.md';

describe('unexpectedFiles', () => {
  it('finds another language, its manifest and its lockfile', () => {
    const added = [
      'harness/src/harness/main.py',
      'harness/pyproject.toml',
      'harness/uv.lock',
      'requirements.txt',
      'scripts/setup.sh',
    ];
    expect(unexpectedFiles(['src/index.ts', 'README.md', ...added])).toEqual(
      added
    );
  });

  it("allows an image's Dockerfile and entry points, and snapshots", () => {
    expect(
      unexpectedFiles([
        'docker/cowork-linux/Dockerfile',
        'docker/cowork-linux/bin/desktop-ready',
        'scripts/run-cowork.sh',
        'tests/__snapshots__/snapshot.spec.ts/echo-order',
        'website/.gitignore',
      ])
    ).toEqual([]);
  });
});

describe('unexpectedRootDirectories', () => {
  it('finds a top-level directory that is not listed', () => {
    expect(
      unexpectedRootDirectories([
        'README.md',
        'src/index.ts',
        'harness/README.md',
        'packages/harness/index.ts',
      ])
    ).toEqual(['harness', 'packages']);
  });
});

describe('unexpectedPackages', () => {
  it('finds a second package', () => {
    expect(
      unexpectedPackages([
        'package.json',
        'website/package.json',
        'examples/sqlite-server/package.json',
        'packages/harness/package.json',
        'src/evals/cowork/package.json',
      ])
    ).toEqual([
      'packages/harness/package.json',
      'src/evals/cowork/package.json',
    ]);
  });
});

describe('productImports', () => {
  it('finds every way a core file imports product code', () => {
    expect(
      productImports([
        {
          file: 'src/evals/grading.ts',
          text: "import { a } from './cowork/firstParty.js';",
        },
        {
          file: 'src/evals/runners/collect.ts',
          text: "import type { B } from '../chatgpt/turn.js';",
        },
        {
          file: 'src/reporters/runReport.ts',
          text: "export { c } from '../evals/coworkClient.js';",
        },
        {
          file: 'src/evals/runEval.ts',
          text: "const d = await import('./codex-app/macos.js');",
        },
      ])
    ).toEqual([
      'src/evals/grading.ts -> src/evals/cowork/firstParty.ts',
      'src/evals/runEval.ts -> src/evals/codex-app/macos.ts',
      'src/evals/runners/collect.ts -> src/evals/chatgpt/turn.ts',
      'src/reporters/runReport.ts -> src/evals/coworkClient.ts',
    ]);
  });

  it('allows the client boundary, product code and tests', () => {
    const text = "import { a } from './cowork/firstParty.js';";
    expect(
      productImports([
        { file: 'src/evals/builtinClients.ts', text },
        { file: 'src/evals/coworkClient.ts', text },
        { file: 'src/evals/grading.test.ts', text },
        {
          file: 'src/evals/codex-app/macos.ts',
          text: "import { b } from '../chatgpt/macos.js';",
        },
        {
          file: 'src/entries/experimentalClients.ts',
          text: "export { c } from '../evals/cowork/interaction.js';",
        },
        {
          file: 'src/cli/commands/cowork/index.ts',
          text: "import { d } from '../../../evals/cowork/restoreConnectors.js';",
        },
      ])
    ).toEqual([]);
  });

  it('ignores imports of core code and of packages', () => {
    expect(
      productImports([
        {
          file: 'src/evals/grading.ts',
          text: "import { a } from './caseExecution.js';\nimport { z } from 'zod';",
        },
      ])
    ).toEqual([]);
  });
});

describe('this repo', () => {
  const files = trackedFiles(REPO);

  it('holds no other language and no new kind of file', () => {
    expect(
      unexpectedFiles(files),
      `MST's code is TypeScript (docs/adr/0006-mst-is-written-in-typescript.md). ` +
        `A tool in another language that calls MST belongs in its own repo (${ADR}). ` +
        `For a new kind of data or asset, add it to tests/repoShape.ts.`
    ).toEqual([]);
  });

  it('has no new top-level directory', () => {
    expect(
      unexpectedRootDirectories(files),
      `A new top-level directory is a new part of the repo. ${ADR} says what ` +
        `belongs here. If this does, add it to ROOT_DIRECTORIES in tests/repoShape.ts.`
    ).toEqual([]);
  });

  it('is one package', () => {
    expect(
      unexpectedPackages(files),
      `MST is one package. A tool that uses MST through the mst command or ` +
        `its public exports belongs in its own repo (${ADR}).`
    ).toEqual([]);
    expect(
      'workspaces' in packageJson,
      `MST is one package, with no workspaces (${ADR}).`
    ).toBe(false);
  });

  it('has no new import of product code from core', () => {
    const sources = files
      .filter((file) => file.startsWith('src/'))
      .filter((file) => /\.(ts|tsx|mts)$/.test(file))
      .map((file) => ({
        file,
        text: readFileSync(path.join(REPO, file), 'utf8'),
      }));
    expect(
      productImports(sources),
      `Core code names no client product (${ADR}). For a new import, keep the ` +
        `code in the product's directory and let core reach it through the ` +
        `client definition. For an import that is gone, delete its entry ` +
        `from KNOWN_PRODUCT_IMPORTS in tests/repoShape.ts.`
    ).toEqual(KNOWN_PRODUCT_IMPORTS);
  });
});
