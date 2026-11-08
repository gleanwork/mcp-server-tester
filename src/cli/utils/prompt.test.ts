import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { createPrompter, PromptCancelledError } from './prompt.js';

/** A prompter reading `answers` as piped lines, and what it wrote. */
function prompterFor(answers: string[], { end = true } = {}) {
  const input = new PassThrough();
  const output = new PassThrough();
  let written = '';
  output.on('data', (chunk: Buffer) => {
    written += chunk.toString();
  });
  // All at once, as a pipe delivers them: none may be lost.
  input.write(answers.map((answer) => `${answer}\n`).join(''));
  if (end) input.end();
  const prompter = createPrompter({ input, output });
  return { prompter, written: () => written };
}

/** A prompter on a fake terminal, where readline handles keys itself. */
function terminalPrompter() {
  const input = new PassThrough();
  const output = Object.assign(new PassThrough(), {
    isTTY: true,
    columns: 80,
  });
  let written = '';
  output.on('data', (chunk: Buffer) => {
    written += chunk.toString();
  });
  const prompter = createPrompter({ input, output });
  return { prompter, input, written: () => written };
}

describe('createPrompter', () => {
  it('redraws the question, not a stray prompt, when the user edits a line', async () => {
    const { prompter, input, written } = terminalPrompter();
    const answer = prompter.text('Project name', 'my-mcp-tests');
    // "abcd", Backspace, Enter.
    input.write('abcd\x7f\r');
    expect(await answer).toBe('abc');
    const redrawn = written().split('\x1b[0J').at(-1) ?? '';
    expect(redrawn).toContain('Project name (my-mcp-tests): abc');
    expect(written()).not.toContain('> ');
    prompter.close();
  });

  it('rejects `cancelled` on Ctrl+C, even when no prompt is waiting', async () => {
    const { prompter, input } = terminalPrompter();
    input.write('\x03');
    await expect(prompter.cancelled).rejects.toBeInstanceOf(
      PromptCancelledError
    );
    await expect(prompter.text('Name')).rejects.toBeInstanceOf(
      PromptCancelledError
    );
    prompter.close();
  });

  it('reads answers piped in before the questions are asked', async () => {
    const { prompter } = prompterFor(['first', 'second']);
    expect(await prompter.text('One')).toBe('first');
    expect(await prompter.text('Two')).toBe('second');
    prompter.close();
  });

  it('takes the default for an empty answer and shows it', async () => {
    const { prompter, written } = prompterFor(['']);
    expect(await prompter.text('Project name', 'my-mcp-tests')).toBe(
      'my-mcp-tests'
    );
    expect(written()).toContain('Project name (my-mcp-tests): ');
    prompter.close();
  });

  it('confirms with y/yes/n/no, defaults on empty, and asks again otherwise', async () => {
    const { prompter, written } = prompterFor(['maybe', 'YES', '', 'n']);
    expect(await prompter.confirm('Install?', false)).toBe(true);
    expect(written()).toContain('Answer y or n.');
    expect(await prompter.confirm('Overwrite?', false)).toBe(false);
    expect(await prompter.confirm('Again?', true)).toBe(false);
    prompter.close();
  });

  it('chooses by number, takes the first on empty, and asks again when out of range', async () => {
    const { prompter, written } = prompterFor(['7', 'x', '2', '']);
    const choices = [
      { label: 'stdio (local server process)', value: 'stdio' },
      { label: 'http (remote server)', value: 'http' },
    ];
    expect(await prompter.choose('Transport:', choices)).toBe('http');
    expect(written()).toContain('  1) stdio (local server process)\n');
    expect(written()).toContain('Enter a number from 1 to 2.');
    expect(await prompter.choose('Transport:', choices)).toBe('stdio');
    prompter.close();
  });

  it('cancels when input ends before an answer', async () => {
    const { prompter } = prompterFor([]);
    await expect(prompter.text('Name')).rejects.toBeInstanceOf(
      PromptCancelledError
    );
    prompter.close();
  });
});
