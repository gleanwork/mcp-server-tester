/**
 * The agent skills in `skills/`, which `npx skills add` installs and the
 * package ships. They aren't covered by `docs:check`, so this keeps them
 * true to the code: every eval dataset, case and eval config they show
 * validates, they name no renamed client, every `mst` command and flag they
 * show exists, and they link only to files an agent can open from a
 * consumer's project.
 *
 * The CLI check reads the built CLI's help, so build first (as
 * `src/cli/commands/cli.test.ts` needs).
 */
import { execFile } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';
import { resolveClientName } from '../src/evals/clientNames.js';
import { validateEvalConfig } from '../src/evals/configValidation.js';
import { validateEvalDataset } from '../src/evals/datasetTypes.js';
import { loadEvalConfigFromObject } from '../src/evals/evalConfig.js';

const SKILLS = fileURLToPath(new URL('../skills/', import.meta.url));
const CLI = fileURLToPath(new URL('../dist/cli/index.js', import.meta.url));
const execFileAsync = promisify(execFile);

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

/** The ```json blocks that parse as JSON, with the line each starts on. */
function jsonBlocks(text: string): Array<{ line: number; value: unknown }> {
  const blocks: Array<{ line: number; value: unknown }> = [];
  for (const match of text.matchAll(/```json\n([\s\S]*?)```/g)) {
    const line = text.slice(0, match.index).split('\n').length;
    try {
      blocks.push({ line, value: JSON.parse(match[1]!) });
    } catch {
      // A fragment, such as one key of an assertions block.
    }
  }
  return blocks;
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
  const help = await helpFor(command);
  const problems: string[] = [];
  for (const word of rest) {
    const flag = /^--[a-z][\w-]*/.exec(word)?.[0];
    if (!flag || flag === '--help') continue;
    const listed =
      help.includes(flag) || help.includes(flag.replace(/^--no-/, '--'));
    if (!listed) problems.push(`"mst ${command.join(' ')}" has no ${flag}`);
  }
  return problems;
}

describe('shipped skills', () => {
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
    it('shows only eval datasets, cases and eval configs that validate', () => {
      for (const { line, value } of jsonBlocks(text)) {
        if (!isRecord(value)) continue;
        const where = `${path.basename(file)}:${line}`;
        if (Array.isArray(value.cases)) {
          expect(() => validateEvalDataset(value), where).not.toThrow();
        } else if (Array.isArray(value.datasets)) {
          expect(
            () =>
              validateEvalConfig(
                loadEvalConfigFromObject(value, { skipDatasetValidation: true })
              ),
            where
          ).not.toThrow();
        } else if (typeof value.id === 'string' && 'input' in value) {
          expect(
            () =>
              validateEvalDataset({ name: 'skill-example', cases: [value] }),
            where
          ).not.toThrow();
        }
      }
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
