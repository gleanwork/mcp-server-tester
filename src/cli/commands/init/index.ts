/**
 * `mst init`: scaffold a Playwright project that tests an MCP server.
 *
 * Every answer has a flag. In a terminal, `init` asks for the ones not
 * given; without one (an agent's shell, CI) it uses the flags and fails,
 * naming the flag, when it needs one that's missing.
 */
import { spawn } from 'node:child_process';
import { mkdir, stat, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import {
  getDatasetTemplate,
  getGitignoreTemplate,
  getMstConfigTemplate,
  getPackageJsonTemplate,
  getPlaywrightConfigTemplate,
  getTestFileTemplate,
  getTsconfigTemplate,
} from '../../templates/index.js';
import { askServerCommand, splitCommandLine } from '../../utils/commandLine.js';
import { status } from '../../utils/format.js';
import {
  createPrompter,
  isInteractive,
  missingFlagError,
  PromptCancelledError,
  type Prompter,
} from '../../utils/prompt.js';

export interface InitOptions {
  name?: string;
  dir?: string;
  /** The command that starts a stdio server, such as `node server.js`. */
  command?: string;
  /** An HTTP server's URL. */
  url?: string;
  /** Run `npm install` (default true). */
  install?: boolean;
  /** Write into an existing project directory. */
  force?: boolean;
}

interface InitAnswers {
  projectName: string;
  projectPath: string;
  transport: 'stdio' | 'http';
  serverCommand?: string;
  serverUrl?: string;
  installDeps: boolean;
}

const DEFAULT_NAME = 'my-mcp-tests';

export async function init(options: InitOptions): Promise<void> {
  const prompter = isInteractive() ? createPrompter() : null;
  try {
    const answers = await collectAnswers(options, prompter);
    if (!answers) {
      print('Nothing written.');
      return;
    }
    prompter?.close();
    await createProject(answers);
    print('');
    print(status('success', 'Project initialized successfully!'));
    print('');
    print('Next steps:');
    print(`  cd ${answers.projectName}`);
    if (!answers.installDeps) print('  npm install');
    print('  npm test');
    print('');
    print('To generate tests from your server:');
    print('  npx mst generate');
  } catch (error) {
    if (error instanceof PromptCancelledError) {
      process.exitCode = 130;
      return;
    }
    process.stderr.write(
      `${status('error', error instanceof Error ? error.message : String(error))}\n`
    );
    process.exitCode = 1;
  } finally {
    prompter?.close();
  }
}

/** The answers from flags and prompts, or null when the user declines to overwrite. */
async function collectAnswers(
  options: InitOptions,
  prompter: Prompter | null
): Promise<InitAnswers | null> {
  if (options.command !== undefined && options.url !== undefined) {
    throw new Error('Pass --command or --url, not both.');
  }

  const projectName =
    options.name ??
    (prompter
      ? await askNonEmpty(prompter, 'Project name', DEFAULT_NAME)
      : DEFAULT_NAME);

  let transport: 'stdio' | 'http';
  let serverCommand: string | undefined;
  let serverUrl: string | undefined;
  if (options.command !== undefined) {
    transport = 'stdio';
    serverCommand = options.command;
    splitCommandLine(serverCommand);
  } else if (options.url !== undefined) {
    transport = 'http';
    serverUrl = options.url;
  } else if (prompter) {
    transport = await prompter.choose('MCP transport type:', [
      { label: 'stdio (local server process)', value: 'stdio' as const },
      { label: 'http (remote server)', value: 'http' as const },
    ]);
    if (transport === 'stdio') {
      serverCommand = await askServerCommand(prompter, print);
    } else {
      serverUrl = await askNonEmpty(
        prompter,
        'Server URL',
        'http://localhost:3000/mcp'
      );
    }
  } else {
    throw missingFlagError(
      '--command <command> or --url <url>',
      'the MCP server'
    );
  }
  if (serverUrl !== undefined) assertUrl(serverUrl);

  const installDeps =
    options.install ??
    (prompter
      ? await prompter.confirm('Install dependencies now?', true)
      : true);

  const projectPath = join(resolve(options.dir ?? '.'), projectName);
  if (!options.force && (await exists(projectPath))) {
    if (!prompter) {
      throw new Error(
        `${projectPath} already exists. Pass --force to write into it.`
      );
    }
    const overwrite = await prompter.confirm(
      `Directory ${projectName} already exists. Overwrite?`,
      false
    );
    if (!overwrite) return null;
  }

  return {
    projectName,
    projectPath,
    transport,
    serverCommand,
    serverUrl,
    installDeps,
  };
}

async function askNonEmpty(
  prompter: Prompter,
  question: string,
  defaultValue: string
): Promise<string> {
  for (;;) {
    const answer = await prompter.text(question, defaultValue);
    if (answer !== '') return answer;
  }
}

function assertUrl(url: string): void {
  try {
    new URL(url);
  } catch {
    throw new Error(`Invalid URL: ${url}`);
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function createProject(answers: InitAnswers): Promise<void> {
  const { projectPath } = answers;
  print('Creating project structure...');
  await mkdir(join(projectPath, 'tests'), { recursive: true });
  await mkdir(join(projectPath, 'data'), { recursive: true });

  const files: Array<[string, string]> = [
    ['playwright.config.ts', getPlaywrightConfigTemplate(answers)],
    ['tests/mcp.spec.ts', getTestFileTemplate(answers)],
    ['data/example-dataset.json', getDatasetTemplate(answers)],
    ['.gitignore', getGitignoreTemplate()],
    ['package.json', getPackageJsonTemplate(answers.projectName)],
    ['tsconfig.json', getTsconfigTemplate()],
    ['mst.config.json', getMstConfigTemplate()],
  ];
  for (const [path, content] of files) {
    await writeFile(join(projectPath, path), content);
  }

  if (answers.installDeps) {
    print('Installing dependencies...');
    await installDependencies(projectPath);
  }
}

function installDependencies(cwd: string): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    const npm = spawn('npm', ['install'], { cwd, stdio: 'pipe' });
    let stderr = '';
    npm.stderr?.on('data', (data: Buffer) => {
      stderr += data.toString();
    });
    npm.on('close', (code) => {
      if (code === 0) {
        resolvePromise();
        return;
      }
      reject(
        new Error(
          stderr.trim()
            ? `npm install failed: ${stderr.trim()}`
            : `npm install exited with code ${code}`
        )
      );
    });
    npm.on('error', reject);
  });
}

function print(line: string): void {
  process.stdout.write(`${line}\n`);
}
