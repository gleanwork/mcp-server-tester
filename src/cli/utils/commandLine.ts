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
