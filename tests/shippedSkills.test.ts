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
import { execFile } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
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

const REPO = fileURLToPath(new URL('../', import.meta.url));
const SKILLS = path.join(REPO, 'skills');
const CLI = path.join(REPO, 'dist/cli/index.js');
const execFileAsync = promisify(execFile);

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

/** Validates one block, or throws. A block it can't place fails. */
function validateBlock({ value, fragment }: JsonBlock): void {
  if (!isRecord(value)) {
    if (fragment) throw new Error('not JSON, or a fragment of a JSON object');
    return;
  }
  const keys = Object.keys(value);
  const within = (known: string[]) =>
    keys.length > 0 && keys.every((key) => known.includes(key));
  if (Array.isArray(value.cases)) {
    validateEvalDataset(value);
  } else if (typeof value.id === 'string' && 'input' in value) {
    validateEvalDataset({ name: 'skill-example', cases: [value] });
  } else if (within(ASSERTION_KEYS)) {
    validateEvalDataset({
      name: 'skill-example',
      cases: [{ id: 'skill-example', input: 'x', assertions: value }],
    });
  } else if (within(CONFIG_KEYS)) {
    // A whole config validates as it is; a fragment, inside a minimal one.
    validateEvalConfig(
      loadEvalConfigFromObject(
        fragment ? { ...BASE_CONFIG, ...value } : value,
        {
          skipDatasetValidation: true,
        }
      )
    );
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

/**
 * Lines outside the 1.x rename tables, whose first column lists old names
 * on purpose.
 */
function linesOutsideRenameTables(text: string): string[] {
  const lines: string[] = [];
  let inRenameTable = false;
  for (const line of text.split('\n')) {
    const isRow = line.startsWith('|');
    if (!isRow) inRenameTable = false;
    else if (/^\|\s*1\.x\s*\|/.test(line)) inRenameTable = true;
    if (!inRenameTable) lines.push(line);
  }
  return lines;
}

const helpCache = new Map<string, Promise<string>>();

/** The built CLI's `--help` for a command path, run once per path. */
function helpFor(command: readonly string[]): Promise<string> {
  const key = command.join(' ');
  let help = helpCache.get(key);
  if (!help) {
    help = execFileAsync(process.execPath, [CLI, ...command, '--help'], {
      encoding: 'utf8',
    }).then((result) => result.stdout);
    helpCache.set(key, help);
  }
  return help;
}

/** The subcommands a help screen lists, without commander's `help`. */
function subcommandsIn(help: string): string[] {
  const section = help.split(/^Commands:$/m)[1] ?? '';
  return [...section.matchAll(/^ {2}([a-z][\w-]*)/gm)]
    .map((match) => match[1]!)
    .filter((name) => name !== 'help');
}

/**
 * The long flags a help screen's `Options:` section defines, by exact name.
 * A description that mentions another flag doesn't count.
 */
function flagsIn(help: string): Set<string> {
  const section = (help.split(/^Options:$/m)[1] ?? '').split(/^\S/m)[0]!;
  return new Set(
    [...section.matchAll(/^ {2}(?:-\w, )?(--[a-z][\w-]*)/gm)].map(
      (match) => match[1]!
    )
  );
}

/**
 * Each place a skill runs the CLI, from the first word after its name: a
 * backticked span or a line of a shell code block that starts with `mst`,
 * `mcp-server-tester` or the package (each optionally after `npx`).
 * The 1.x rename tables list old commands and flags on purpose. In a
 * table cell, `\|` separates alternatives (`start\|try`), each checked.
 */
function cliInvocations(text: string): string[][] {
  const candidates: string[] = [];
  let fence: string | null = null;
  let continued = '';
  for (const line of linesOutsideRenameTables(text)) {
    const opening = /^```(\w*)/.exec(line);
    if (opening) {
      fence = fence === null ? opening[1]! : null;
      continue;
    }
    if (fence === null) {
      for (const [, span] of line.matchAll(/`([^`]+)`/g)) {
        candidates.push(span!);
      }
    } else if (['bash', 'sh', 'shell'].includes(fence)) {
      // A trailing backslash continues the command on the next line.
      if (line.endsWith('\\')) {
        continued += `${line.slice(0, -1)} `;
        continue;
      }
      candidates.push(continued + line);
      continued = '';
    }
  }
  const invocations: string[][] = [];
  for (const candidate of candidates) {
    const match =
      /^\s*(?:npx\s+(?:-y\s+)?)?(?:mst|mcp-server-tester|@gleanwork\/mcp-server-tester)(?:@[\w.-]+)?\s+(.+)$/.exec(
        candidate
      );
    if (!match) continue;
    // Stop at a pipe, a list of commands, a redirect or a comment. A `>`
    // with no space before it closes a placeholder (`<path>`).
    const words = match[1]!
      .split(/\s*(?:(?<!\\)\||&&|;|#)|\s+>/)[0]!
      .trim()
      .split(/\s+/);
    if (!words[0]) continue;
    const choice = words.findIndex((word) => word.includes('\\|'));
    if (choice === -1) {
      invocations.push(words);
      continue;
    }
    for (const alternative of words[choice]!.split('\\|')) {
      invocations.push([
        ...words.slice(0, choice),
        alternative,
        ...words.slice(choice + 1),
      ]);
    }
  }
  return invocations;
}

/**
 * What is wrong with one invocation: an unknown command or subcommand, or a
 * flag its help doesn't list. A word that isn't plain (`<run>`, a path, a
 * URL) is an argument, not a command.
 */
async function invocationProblems(words: string[]): Promise<string[]> {
  const command: string[] = [];
  let rest = words;
  for (;;) {
    const [word, ...after] = rest;
    if (!word || !/^[a-z][\w-]*$/.test(word)) break;
    const commands = subcommandsIn(await helpFor(command));
    if (commands.length === 0) break;
    if (!commands.includes(word)) {
      const parent = command.length ? `mst ${command.join(' ')}` : 'mst';
      return [`"${parent}" has no command "${word}"`];
    }
    command.push(word);
    rest = after;
  }
  const flags = flagsIn(await helpFor(command));
  const problems: string[] = [];
  for (const word of rest) {
    const flag = /^--[a-z][\w-]*/.exec(word)?.[0];
    if (!flag || flag === '--help') continue;
    if (!flags.has(flag)) {
      problems.push(`"mst ${command.join(' ')}" has no ${flag}`);
    }
  }
  return problems;
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
          const message = (error as Error).message.split('\n')[0];
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
