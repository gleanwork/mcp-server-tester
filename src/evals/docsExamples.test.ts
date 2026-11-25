/**
 * Every JSON eval config and dataset in the README and the docs is one that
 * `mst run` accepts. Migration guides and ADRs are left out: their "before"
 * examples are old on purpose. Annotated references with comments are fenced
 * as `jsonc` and not checked.
 *
 * Examples that name the docs' fictional `acme` plugin validate against a
 * fixture with only the extensions the docs name, as `mst run` resolves them:
 * the plugins an example lists give its namespaces, its `extends` apply, and
 * each connector server's connector is looked up. So a misspelt dataset,
 * judge, connector or shared config still fails, as does a name from a plugin
 * the example doesn't list.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { installPlugins, resetPluginsForTests } from '../plugins/extensions.js';
import type { Plugin } from '../plugins/plugin.js';
import { buildEvalDataset } from './buildEvalDataset.js';
import { getConnector } from '../auth/grants/connectors.js';
import { loadEvalConfigFromObject, type EvalConfig } from './evalConfig.js';
import { resolveConfigExtends } from './configExtends.js';
import { validateEvalConfig } from './configValidation.js';

const ACME_CONNECTOR = {
  url: 'https://mcp.acme.example/mcp',
  auth: { type: 'none' },
} as const;

const ACME: Plugin = {
  meta: { name: '@acme/mst-plugin', namespace: 'acme' },
  datasetSources: {
    'info-seeking': {
      schema: z.object({ type: z.string() }).passthrough(),
      load: async () => ({ name: 'info-seeking', cases: [] }),
    },
  },
  judges: {
    correctness: {
      schema: z.object({}).passthrough(),
      evaluate: async () => ({ score: 1 }),
    },
    completeness: {
      schema: z.object({}).passthrough(),
      evaluate: async () => ({ score: 1 }),
    },
  },
  pairwiseJudges: {
    preference: {
      schema: z.object({}).passthrough(),
      compare: async () => ({ preference: 'tie' as const }),
    },
  },
  connectors: {
    acme: ACME_CONNECTOR,
    slack: ACME_CONNECTOR,
    github: ACME_CONNECTOR,
  },
  configs: { cowork: {}, recommended: {} },
};

/** The plugins the docs name, by package, with the namespace each one loads. */
const DOCS_PLUGINS: Record<string, string> = {
  [ACME.meta.name]: ACME.meta.namespace,
};

/**
 * An eval config as `mst run` checks it before it runs: the namespaces of
 * the plugins it lists, its `extends` applied, its references checked
 * against those namespaces, and each connector server's connector found.
 */
function checkEvalConfig(value: unknown): void {
  const evalConfig = loadEvalConfigFromObject(value, {
    skipDatasetValidation: true,
  });
  const namespaces = (evalConfig.plugins ?? []).map((name) => {
    const namespace = DOCS_PLUGINS[name];
    if (!namespace) throw new Error(`No docs plugin "${name}"`);
    return namespace;
  });
  const resolved = validateEvalConfig(
    resolveConfigExtends(evalConfig, namespaces),
    { namespaces }
  );
  for (const servers of [
    resolved.servers,
    ...(resolved.variants ?? []).map((variant) => variant.servers),
  ]) {
    for (const server of Object.values(servers ?? {})) {
      if (typeof server === 'object' && server && 'connector' in server)
        getConnector(String(server.connector));
    }
  }
}

const ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../..'
);

function markdownFiles(): string[] {
  const docs = fs
    .readdirSync(path.join(ROOT, 'docs'), { recursive: true })
    .map(String)
    .filter(
      (file) =>
        file.endsWith('.md') &&
        !file.startsWith('migrations') &&
        !file.startsWith('adr') &&
        !path.basename(file).startsWith('migration-')
    )
    .map((file) => path.join('docs', file));
  return ['README.md', ...docs];
}

/** A whole eval config (`datasets`) or dataset (`cases`), by its top-level keys. */
type Kind = 'eval config' | 'dataset';

interface Example {
  kind: Kind;
  where: string;
  value: unknown;
}

/** The `json` code blocks in a file, with their line numbers. */
function jsonBlocks(file: string): Array<{ line: number; text: string }> {
  const lines = fs.readFileSync(path.join(ROOT, file), 'utf8').split('\n');
  const blocks: Array<{ line: number; text: string }> = [];
  let open: { lang: string; line: number; body: string[] } | undefined;
  lines.forEach((text, index) => {
    const fence = /^\s*```(\S*)/.exec(text);
    if (!fence) {
      open?.body.push(text);
      return;
    }
    if (!open) {
      open = { lang: fence[1] ?? '', line: index + 1, body: [] };
      return;
    }
    if (open.lang === 'json')
      blocks.push({ line: open.line, text: open.body.join('\n') });
    open = undefined;
  });
  return blocks;
}

const examples: Example[] = [];
const unparsed: string[] = [];
for (const file of markdownFiles()) {
  for (const { line, text } of jsonBlocks(file)) {
    const where = `${file}:${line}`;
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch {
      // A fragment ("key": value, ...) isn't a whole example; a block that
      // looks whole but doesn't parse is a broken example.
      if (
        /^\s*\{[\s\S]*\}\s*$/.test(text) &&
        /"(datasets|cases)"\s*:/.test(text)
      )
        unparsed.push(where);
      continue;
    }
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
    const keys = value as Record<string, unknown>;
    if (typeof keys.name !== 'string') continue;
    if ('datasets' in keys)
      examples.push({ kind: 'eval config', where, value });
    else if (Array.isArray(keys.cases))
      examples.push({ kind: 'dataset', where, value });
  }
}

describe('eval config and dataset examples in the docs', () => {
  beforeAll(() => {
    installPlugins([ACME]);
  });
  afterAll(() => {
    resetPluginsForTests();
  });

  it('finds both kinds, and every whole example parses', () => {
    expect(
      examples.filter((example) => example.kind === 'eval config').length
    ).toBeGreaterThan(3);
    expect(
      examples.filter((example) => example.kind === 'dataset').length
    ).toBeGreaterThan(3);
    expect(unparsed).toEqual([]);
  });

  it.each(examples)('$where is a valid $kind', ({ kind, value }) => {
    if (kind === 'dataset') {
      // The loader `mst run` uses, with its case rules.
      expect(() =>
        buildEvalDataset(value, {
          name: 'docs',
          datasets: [],
        } as EvalConfig)
      ).not.toThrow();
      return;
    }
    expect(() => checkEvalConfig(value)).not.toThrow();
  });

  it.each([
    ['a misspelt connector', { connector: 'acme/connector/slak' }, {}],
    ['a misspelt shared config', {}, { extends: ['acme/config/cowrk'] }],
    ['a plugin it does not list', {}, { plugins: [] }],
  ])('fails an example with %s', (_name, server, overrides) => {
    const example = {
      name: 'docs',
      plugins: ['@acme/mst-plugin'],
      extends: ['acme/config/cowork'],
      datasets: ['acme/dataset/info-seeking'],
      servers: { slack: { connector: 'acme/connector/slack', ...server } },
      variants: [{ name: 'baseline', client: 'api' }],
      ...overrides,
    };
    expect(() => checkEvalConfig(example)).toThrow();
  });

  it('passes that example when every name is right', () => {
    expect(() =>
      checkEvalConfig({
        name: 'docs',
        plugins: ['@acme/mst-plugin'],
        extends: ['acme/config/cowork'],
        datasets: ['acme/dataset/info-seeking'],
        servers: { slack: { connector: 'acme/connector/slack' } },
        variants: [{ name: 'baseline', client: 'api' }],
      })
    ).not.toThrow();
  });
});
