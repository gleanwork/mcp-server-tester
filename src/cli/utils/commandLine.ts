import type { Prompter } from './prompt.js';

/**
 * Splits a `--command` value, such as `node "/Users/a/My Server/index.js"`,
 * into the command and its arguments.
 *
 * Whitespace separates arguments. Single or double quotes keep an argument
 * that holds spaces together, and either kind can hold the other. A
 * backslash is an ordinary character, so Windows paths pass through
 * unchanged. Nothing is expanded: no variables, globs or escapes.
 */
export function splitCommandLine(commandLine: string): string[] {
  const words: string[] = [];
  let word = '';
  let inWord = false;
  let quote: '"' | "'" | null = null;
  for (const char of commandLine) {
    if (quote !== null) {
      if (char === quote) quote = null;
      else word += char;
    } else if (char === '"' || char === "'") {
      quote = char;
      inWord = true;
    } else if (/\s/.test(char)) {
      if (inWord) words.push(word);
      word = '';
      inWord = false;
    } else {
      word += char;
      inWord = true;
    }
  }
  if (quote !== null) {
    throw new Error(`The command has an unclosed ${quote}: ${commandLine}`);
  }
  if (inWord) words.push(word);
  if (words.length === 0) throw new Error('The command is empty.');
  return words;
}

/**
 * Asks for the command that starts a stdio server until the answer splits,
 * reporting why an answer doesn't (an unclosed quote) and asking again.
 */
export async function askServerCommand(
  prompter: Prompter,
  report: (message: string) => void
): Promise<string> {
  for (;;) {
    const answer = await prompter.text('Server command', 'node server.js');
    try {
      splitCommandLine(answer);
      return answer;
    } catch (error) {
      report(error instanceof Error ? error.message : String(error));
    }
  }
}
