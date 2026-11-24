/**
 * The agent skills in `skills/`, which `npx skills add` installs and the
 * package ships. They aren't covered by `docs:check`, so this keeps them
 * true to the code: every eval dataset, case and eval config they show
 * validates, they name no renamed client, every `mst` command and flag they
 * show exists, and they link only to files an agent can open from a
 * consumer's project.
 *
 * It also checks that the package and the Claude Code marketplace ship them.
 *
 * The CLI check reads the built CLI's help, so build first (as
 * `src/cli/commands/cli.test.ts` needs).
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import packageJson from '../package.json' with { type: 'json' };
import { resolveClientName } from '../src/evals/clientNames.js';
import { validateEvalConfig } from '../src/evals/configValidation.js';
import {
  EvalAssertionsSchema,
  validateEvalDataset,
} from '../src/evals/datasetTypes.js';
import {
  EvalConfigSchema,
  loadEvalConfigFromObject,
} from '../src/evals/evalConfig.js';
import {
  installPlugins,
  resetPluginsForTests,
} from '../src/plugins/extensions.js';
import type { Plugin } from '../src/plugins/plugin.js';
import {
  cliInvocations,
  invocationProblems,
  linesOutsideRenameTables,
} from './cliInvocations.js';

const REPO = fileURLToPath(new URL('../', import.meta.url));
const SKILLS = path.join(REPO, 'skills');

/**
 * The example plugin the skills name, with only the extensions they use, so
 * an example that references `acme` validates and a misspelt one doesn't.
 */
const ACME: Plugin = {
  meta: { name: '@acme/mst-plugin', namespace: 'acme' },
  datasetSources: {
    'info-seeking': {
      schema: z.object({ type: z.string() }),
      load: async () => ({ name: 'info-seeking', cases: [] }),
    },
  },
  judges: {
    completeness: {
      schema: z.object({}).passthrough(),
      evaluate: async () => ({ score: 1 }),
    },
  },
};

const ASSERTION_KEYS = Object.keys(EvalAssertionsSchema.shape);
const CONFIG_KEYS = Object.keys(EvalConfigSchema.shape);

/** What a skill's fragment of an eval config is merged into to validate. */
const BASE_CONFIG = {
  name: 'skill-example',
  datasets: ['./cases.json'],
  servers: { local: { transport: 'stdio', command: 'node' } },
};

interface SkillFile {
  /** The path from `skills/`, for test names. */
  name: string;
  path: string;
  text: string;
}

function skillDirs(): string[] {
  return readdirSync(SKILLS, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

function markdownFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return markdownFiles(full);
    return entry.name.endsWith('.md') ? [full] : [];
  });
}

function skillFiles(): SkillFile[] {
  return markdownFiles(SKILLS)
    .sort()
    .map((file) => ({
      name: path.relative(SKILLS, file),
      path: file,
      text: readFileSync(file, 'utf8'),
    }));
}

interface JsonBlock {
  line: number;
  /** The parsed block; a fragment (`"variants": [...]`) is wrapped in `{}`. */
  value: unknown;
  fragment: boolean;
}

/**
 * Every ```json block, with the line it starts on. A block that is neither
 * JSON nor a fragment of an object has `value` undefined.
 */
function jsonBlocks(text: string): JsonBlock[] {
  const blocks: JsonBlock[] = [];
  for (const match of text.matchAll(/```json\n([\s\S]*?)```/g)) {
    const line = text.slice(0, match.index).split('\n').length;
    const body = match[1]!;
    blocks.push(
      parseJson(body, line, false) ??
        parseJson(`{${body}}`, line, true) ?? {
          line,
          value: undefined,
          fragment: true,
        }
    );
  }
  return blocks;
}

function parseJson(
  text: string,
  line: number,
  fragment: boolean
): JsonBlock | null {
  try {
    return { line, value: JSON.parse(text), fragment };
  } catch {
    return null;
  }
}

/**
 * Validates one block, or throws. A block is placed by any key it shares
 * with an eval config or with assertions, so the strict schemas reject a
 * misspelt key next to it instead of the block being skipped. A fragment it
 * can't place fails.
 */
function validateBlock({ value, fragment }: JsonBlock): void {
  if (!isRecord(value)) {
    if (fragment) throw new Error('not JSON, or a fragment of a JSON object');
    return;
  }
  const keys = Object.keys(value);
  const shares = (known: string[]) => keys.some((key) => known.includes(key));
  // Output examples, such as a tool call, can have a `name` too.
  const configKeys = fragment
    ? CONFIG_KEYS
    : CONFIG_KEYS.filter((key) => key !== 'name');
  if (Array.isArray(value.cases)) {
    validateEvalDataset(value);
  } else if (typeof value.id === 'string' && 'input' in value) {
    validateEvalDataset({ name: 'skill-example', cases: [value] });
  } else if (shares(configKeys)) {
    // A whole config validates as it is; a fragment, inside a minimal one.
    validateEvalConfig(
      loadEvalConfigFromObject(
        fragment ? { ...BASE_CONFIG, ...value } : value,
        { skipDatasetValidation: true }
      )
    );
  } else if (shares(ASSERTION_KEYS)) {
    validateEvalDataset({
      name: 'skill-example',
      cases: [{ id: 'skill-example', input: 'x', assertions: value }],
    });
  } else if (fragment) {
    // Not part of an eval config or of assertions, so nothing would check it.
    throw new Error(
      `keys ${keys.join(', ')} are not eval config or assertion keys`
    );
  }
  // Any other whole document is an example of output, such as a tool call.
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

describe('shipped skills', () => {
  beforeAll(() => {
    installPlugins([ACME]);
  });
  afterAll(() => {
    resetPluginsForTests();
  });

  it('ship in the npm package', () => {
    // `npx skills experimental_sync` reads `skills/` in an installed package.
    expect(packageJson.files).toContain('skills');
  });

  it('ship as a Claude Code plugin whose root holds every skill', () => {
    const marketplace = JSON.parse(
      readFileSync(path.join(REPO, '.claude-plugin/marketplace.json'), 'utf8')
    ) as { name: string; plugins: Array<{ name: string; source: string }> };
    expect(marketplace.name).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
    expect(marketplace.plugins).toHaveLength(1);
    const [plugin] = marketplace.plugins;
    expect(plugin!.name).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
    const root = path.resolve(REPO, plugin!.source);
    for (const dir of skillDirs()) {
      expect(existsSync(path.join(root, 'skills', dir, 'SKILL.md')), dir).toBe(
        true
      );
    }
  });

  it.each(skillDirs())('%s has valid frontmatter', (dir) => {
    const file = path.join(SKILLS, dir, 'SKILL.md');
    expect(existsSync(file)).toBe(true);
    const frontmatter = /^---\n([\s\S]*?)\n---\n/.exec(
      readFileSync(file, 'utf8')
    );
    expect(frontmatter).not.toBeNull();
    const meta = parseYaml(frontmatter![1]!) as Record<string, unknown>;
    // The Agent Skills spec: the name is the directory's, in kebab-case,
    // and the description is at most 1024 characters.
    expect(meta.name).toBe(dir);
    expect(dir).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
    expect(typeof meta.description).toBe('string');
    expect((meta.description as string).length).toBeGreaterThan(0);
    expect((meta.description as string).length).toBeLessThanOrEqual(1024);
  });

  describe.each(skillFiles())('$name', ({ path: file, text }) => {
    it('shows only eval datasets, cases, assertions and eval configs that validate', () => {
      const problems: string[] = [];
      for (const block of jsonBlocks(text)) {
        try {
          validateBlock(block);
        } catch (error) {
          // Zod reports its issues as indented JSON; keep them on one line.
          const message = (error as Error).message
            .replace(/\s+/g, ' ')
            .slice(0, 300);
          problems.push(`${path.basename(file)}:${block.line}: ${message}`);
        }
      }
      expect(problems).toEqual([]);
    });

    it('names no renamed client', () => {
      const stale: string[] = [];
      for (const line of linesOutsideRenameTables(text)) {
        for (const [, token] of line.matchAll(/`([\w.-]+)`/g)) {
          // `mst` is the CLI's name as well as the api client's old one.
          if (token === 'mst') continue;
          try {
            resolveClientName(token!);
          } catch (error) {
            stale.push(`${line.trim()}\n  ${(error as Error).message}`);
          }
        }
      }
      expect(stale).toEqual([]);
    });

    it('shows only mst commands and flags the CLI has', async () => {
      const problems: string[] = [];
      for (const words of cliInvocations(text)) {
        for (const problem of await invocationProblems(words)) {
          problems.push(`mst ${words.join(' ')}: ${problem}`);
        }
      }
      expect(problems).toEqual([]);
      // Each help screen the skill needs starts the CLI once.
    }, 60_000);

    it("links only to files a consumer's agent can open", () => {
      // The repo's docs aren't in the package or the installed skill.
      const withoutUrls = text.replace(/https?:\/\/[^\s)>`]+/g, '');
      expect(withoutUrls.match(/\bdocs\/[\w./-]+\.md\b/g) ?? []).toEqual([]);
      // Links within a skill, such as references/, resolve.
      for (const [, target] of text.matchAll(/\]\(([^)#\s]+)(?:#[^)]*)?\)/g)) {
        if (/^[a-z]+:/.test(target!)) continue;
        expect(
          existsSync(path.resolve(path.dirname(file), target!)),
          target
        ).toBe(true);
      }
    });
  });
});
