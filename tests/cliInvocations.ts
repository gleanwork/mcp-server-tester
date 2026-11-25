/**
 * Finds the places a Markdown file runs the `mst` CLI, and checks each
 * command and flag against the built CLI's help. `shippedSkills.test.ts`
 * checks the skills with it, and `docsDrift.test.ts` the docs.
 *
 * It reads `dist/cli/index.js`, so build first.
 */
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const CLI = fileURLToPath(new URL('../dist/cli/index.js', import.meta.url));
const execFileAsync = promisify(execFile);

/**
 * Lines outside the 1.x rename tables, whose first column lists old names
 * on purpose.
 */
export function linesOutsideRenameTables(text: string): string[] {
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
 * Each place a file runs the CLI, from the first word after its name: a
 * backticked span or a line of a shell code block that starts with `mst`,
 * `mcp-server-tester` or the package (each optionally after `npx`).
 * The 1.x rename tables list old commands and flags on purpose. In a
 * table cell, `\|` separates alternatives (`start\|try`), each checked.
 */
export function cliInvocations(text: string): string[][] {
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
 * The subcommand a command runs when given none (commander's `isDefault`),
 * which its help doesn't show. `docsDrift.test.ts` checks this against the
 * CLI's source.
 */
export const DEFAULT_SUBCOMMANDS: Readonly<Record<string, string>> = {
  label: 'page',
};

/**
 * Whether a command is one its parent's help leaves out (`hidden`): its own
 * help names it, where an unknown command's help is its parent's.
 */
async function isHiddenCommand(command: readonly string[]): Promise<boolean> {
  const help = await helpFor(command).catch(() => '');
  return help.startsWith(`Usage: mst ${command.join(' ')} `);
}

/**
 * What is wrong with one invocation: an unknown command or subcommand, or a
 * flag its help doesn't list. A word that isn't plain (`<run>`, a path, a
 * URL) is an argument, not a command. Global options (`--mst-config <path>`)
 * may come before the command.
 */
export async function invocationProblems(words: string[]): Promise<string[]> {
  const command: string[] = [];
  let rest = words;
  const globalFlags = flagsIn(await helpFor([]));
  while (rest[0] && globalFlags.has(rest[0].split('=')[0]!)) {
    const takesValue = !rest[0].includes('=') && !rest[1]?.startsWith('-');
    rest = rest.slice(takesValue ? 2 : 1);
  }
  for (;;) {
    const [word, ...after] = rest;
    if (!word || !/^[a-z][\w-]*$/.test(word)) break;
    const commands = subcommandsIn(await helpFor(command));
    if (commands.length === 0) break;
    if (
      !commands.includes(word) &&
      !(await isHiddenCommand([...command, word]))
    ) {
      const fallback = DEFAULT_SUBCOMMANDS[command.join(' ')];
      if (fallback) break;
      const parent = command.length ? `mst ${command.join(' ')}` : 'mst';
      return [`"${parent}" has no command "${word}"`];
    }
    command.push(word);
    rest = after;
  }
  const fallback = DEFAULT_SUBCOMMANDS[command.join(' ')];
  if (fallback) command.push(fallback);
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
