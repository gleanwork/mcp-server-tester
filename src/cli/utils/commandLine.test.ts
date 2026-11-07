import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { askServerCommand, splitCommandLine } from './commandLine.js';
import { createPrompter } from './prompt.js';

describe('askServerCommand', () => {
  it('asks again after an answer that does not split', async () => {
    const input = new PassThrough();
    input.end('node "/tmp/My Server\nnode "/tmp/My Server/index.js"\n');
    const prompter = createPrompter({ input, output: new PassThrough() });
    const reported: string[] = [];

    const command = await askServerCommand(prompter, (message) =>
      reported.push(message)
    );

    expect(command).toBe('node "/tmp/My Server/index.js"');
    expect(reported).toEqual([
      'The command has an unclosed ": node "/tmp/My Server',
    ]);
    prompter.close();
  });
});

describe('splitCommandLine', () => {
  it('splits on runs of whitespace', () => {
    expect(splitCommandLine('  node   server.js\t--port 3000 ')).toEqual([
      'node',
      'server.js',
      '--port',
      '3000',
    ]);
  });

  it('keeps a quoted argument with spaces together', () => {
    expect(splitCommandLine('node "/Users/a/My Server/index.js"')).toEqual([
      'node',
      '/Users/a/My Server/index.js',
    ]);
    expect(splitCommandLine("node '/tmp/my dir/server.js' --x")).toEqual([
      'node',
      '/tmp/my dir/server.js',
      '--x',
    ]);
  });

  it('lets one kind of quote hold the other', () => {
    expect(splitCommandLine(`node "/tmp/o'brien/server.js"`)).toEqual([
      'node',
      "/tmp/o'brien/server.js",
    ]);
    expect(splitCommandLine(`node -e 'console.log("hi")'`)).toEqual([
      'node',
      '-e',
      'console.log("hi")',
    ]);
  });

  it('joins quoted and unquoted parts of one word, and keeps empty quotes', () => {
    expect(splitCommandLine(`--name="My Server" ''`)).toEqual([
      '--name=My Server',
      '',
    ]);
  });

  it('leaves backslashes alone, so Windows paths pass through', () => {
    expect(
      splitCommandLine('"C:\\Program Files\\nodejs\\node.exe" a\\b')
    ).toEqual(['C:\\Program Files\\nodejs\\node.exe', 'a\\b']);
  });

  it('rejects an unclosed quote and an empty command', () => {
    expect(() => splitCommandLine('node "server.js')).toThrow(
      'The command has an unclosed ": node "server.js'
    );
    expect(() => splitCommandLine('   ')).toThrow('The command is empty.');
  });
});
