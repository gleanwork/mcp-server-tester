/**
 * Line prompts for the CLI's interactive commands (`init`, `generate`).
 *
 * Each prompt writes a question and reads one line. Lines come from an async
 * iterator, which buffers them, so answers piped in all at once aren't lost.
 * A command asks only when `isInteractive()`; without a terminal it takes its
 * answers from flags and names the flag it is missing.
 */
import { createInterface, type Interface } from 'node:readline';

/** Ctrl+C or the end of input while a prompt waits for an answer. */
export class PromptCancelledError extends Error {
  constructor() {
    super('Cancelled');
    this.name = 'PromptCancelledError';
  }
}

interface Choice<T extends string> {
  label: string;
  value: T;
}

export interface Prompter {
  /** Asks for text. An empty answer takes `defaultValue`. */
  text(question: string, defaultValue?: string): Promise<string>;
  /** Asks yes or no. An empty answer takes `defaultValue`. */
  confirm(question: string, defaultValue: boolean): Promise<boolean>;
  /** Lists numbered choices and asks for one, by number. */
  choose<T extends string>(question: string, choices: Choice<T>[]): Promise<T>;
  close(): void;
}

export interface PromptStreams {
  input: NodeJS.ReadableStream;
  output: NodeJS.WritableStream;
}

/** Whether a person is there to answer: both stdin and stdout are terminals. */
export function isInteractive(): boolean {
  return process.stdin.isTTY === true && process.stdout.isTTY === true;
}

export function createPrompter(
  streams: PromptStreams = { input: process.stdin, output: process.stdout }
): Prompter {
  const { output } = streams;
  const rl: Interface = createInterface({
    input: streams.input,
    output,
    terminal: (output as { isTTY?: boolean }).isTTY === true,
  });
  const lines = rl[Symbol.asyncIterator]();
  let cancelled = false;
  // Without a listener, readline only pauses on Ctrl+C.
  rl.on('SIGINT', () => {
    cancelled = true;
    output.write('\n');
    rl.close();
  });

  async function readLine(question: string): Promise<string> {
    if (cancelled) throw new PromptCancelledError();
    output.write(question);
    const next = await lines.next();
    if (cancelled || next.done === true) throw new PromptCancelledError();
    return String(next.value).trim();
  }

  return {
    async text(question, defaultValue) {
      const hint = defaultValue ? ` (${defaultValue})` : '';
      const answer = await readLine(`${question}${hint}: `);
      return answer === '' ? (defaultValue ?? '') : answer;
    },

    async confirm(question, defaultValue) {
      const hint = defaultValue ? 'Y/n' : 'y/N';
      for (;;) {
        const answer = (await readLine(`${question} (${hint}) `)).toLowerCase();
        if (answer === '') return defaultValue;
        if (answer === 'y' || answer === 'yes') return true;
        if (answer === 'n' || answer === 'no') return false;
        output.write('Answer y or n.\n');
      }
    },

    async choose(question, choices) {
      output.write(`${question}\n`);
      choices.forEach((choice, index) => {
        output.write(`  ${index + 1}) ${choice.label}\n`);
      });
      for (;;) {
        const answer = await readLine(`Choose 1-${choices.length} (1): `);
        const index = answer === '' ? 0 : Number(answer) - 1;
        const choice = Number.isInteger(index) ? choices[index] : undefined;
        if (choice) return choice.value;
        output.write(`Enter a number from 1 to ${choices.length}.\n`);
      }
    },

    close() {
      rl.close();
    },
  };
}

/** The error a command gives when it has no terminal and no flag for a value. */
export function missingFlagError(flag: string, what: string): Error {
  return new Error(
    `No terminal to ask for ${what}. Pass ${flag}, or run in a terminal.`
  );
}
