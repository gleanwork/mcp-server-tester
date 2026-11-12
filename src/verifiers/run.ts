/**
 * `mst verifiers run <taskset>`: a verifiers taskset, run on an MST client (ADR 0015).
 *
 * verifiers runs the eval: it loads the taskset, records the model calls through its
 * interception server, and scores each rollout. MST is the harness: the bundled
 * `mst-harness` package runs one `mst run` trial per rollout, with this MST's CLI.
 *
 * MST installs `mst-harness` and the taskset into a temporary venv with uv, and runs
 * verifiers there, so nothing needs installing first but uv. The bundled `mst-harness`
 * overrides any other the taskset names, so the harness always matches this MST.
 */

import { spawn } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { packageRoot } from '../utils/packageRoot.js';

type VerifiersApi = 'anthropic' | 'openai';

export interface VerifiersRunOptions {
  /** The MST client. Default: `api`. */
  client?: string;
  /** The model under test, as the endpoint names it. */
  model: string;
  /** The API family the client's inference uses. Default: `openai` for codex-cli, else `anthropic`. */
  api?: string;
  /** The upstream endpoint verifiers forwards model calls to. Default: the API family's provider. */
  baseUrl?: string;
  /** The environment variable that holds the upstream's key. Default: the API family's. */
  apiKeyVar?: string;
  /** `--client-option key=value`, each time it was given. */
  clientOption?: string[];
  /** MST plugins, for a plugin client. */
  plugins?: string[];
  /** Subdirectories of a working directory the client runs in, kept with each rollout. */
  workdir?: string[];
  /** `--num-tasks`: how many of the taskset's tasks. Default: all. */
  numTasks?: string;
  /** `--rollouts`: rollouts per task. */
  rollouts?: string;
  /** `--concurrency`: rollouts at once. */
  concurrency?: string;
  /** `--output-dir`: where verifiers writes the run. Default: `outputs/` here. */
  outputDir?: string;
  /** The Python uv creates the venv with. */
  python?: string;
  /** verifiers eval options after `--`, passed through. They override the ones above. */
  verifiersArgs?: string[];
}

/** One command the run starts. Arguments may hold the placeholders below. */
interface VerifiersRunStep {
  /** `uv`, or the venv's Python. */
  command: 'uv' | typeof PYTHON;
  args: string[];
}

export interface VerifiersRunPlan {
  /** verifiers' eval config, written to a JSON file and passed as `@ file`. */
  config: Record<string, unknown>;
  /** `requirement @ url` lines that override what the taskset asks for. */
  overrides: string[];
  /** Create the venv, install into it, run the eval. */
  steps: VerifiersRunStep[];
  /** The taskset argument: a package directory (absolute) or a taskset id. */
  taskset: string;
  /** The variable that must hold the upstream key. */
  apiKeyVar: string;
}

export const CONFIG = '{config}';
export const VENV = '{venv}';
export const OVERRIDES = '{overrides}';
export const PYTHON = '{python}';

const PROVIDERS: Record<VerifiersApi, { baseUrl: string; apiKeyVar: string }> =
  {
    anthropic: {
      baseUrl: 'https://api.anthropic.com',
      apiKeyVar: 'ANTHROPIC_API_KEY',
    },
    openai: {
      baseUrl: 'https://api.openai.com/v1',
      apiKeyVar: 'OPENAI_API_KEY',
    },
  };

/** The `mst-harness` package directory bundled with MST. */
export function harnessDirectory(root = packageRoot()): string {
  return path.join(root, 'python', 'mst-harness');
}

/** `key=value` flags as client options; a value that parses as JSON is that value. */
export function parseClientOptions(
  flags: readonly string[]
): Record<string, unknown> {
  const options: Record<string, unknown> = {};
  for (const flag of flags) {
    const separator = flag.indexOf('=');
    if (separator < 1)
      throw new Error(`--client-option takes key=value, got "${flag}"`);
    const key = flag.slice(0, separator);
    if (Object.hasOwn(options, key))
      throw new Error(`--client-option ${key} is given twice`);
    const value = flag.slice(separator + 1);
    try {
      options[key] = JSON.parse(value) as unknown;
    } catch {
      options[key] = value;
    }
  }
  return options;
}

function count(flag: string, value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1)
    throw new Error(
      `${flag} takes a whole number of 1 or more, got "${value}"`
    );
  return parsed;
}

function apiOf(options: VerifiersRunOptions, client: string): VerifiersApi {
  const api = options.api ?? (client === 'codex-cli' ? 'openai' : 'anthropic');
  if (api !== 'anthropic' && api !== 'openai')
    throw new Error(`--api is anthropic or openai, got "${api}"`);
  return api;
}

/**
 * What `mst verifiers run` starts. `mstCommand` runs this MST's CLI, so each rollout's
 * `mst run` is the same MST.
 */
export function planVerifiersRun(
  taskset: string,
  options: VerifiersRunOptions,
  {
    cwd = process.cwd(),
    harnessDir = harnessDirectory(),
    mstCommand,
  }: { cwd?: string; harnessDir?: string; mstCommand: string[] }
): VerifiersRunPlan {
  if (!options.model) throw new Error('--model is required');
  const client = options.client ?? 'api';
  const api = apiOf(options, client);
  const provider = PROVIDERS[api];
  const apiKeyVar = options.apiKeyVar ?? provider.apiKeyVar;
  const local = path.resolve(cwd, taskset);
  const isDirectory = existsSync(local) && statSync(local).isDirectory();
  if (isDirectory && !existsSync(path.join(local, 'pyproject.toml')))
    throw new Error(
      `${local} has no pyproject.toml: a taskset is a Python package that exports its Taskset.`
    );
  const tasksetArg = isDirectory ? local : taskset;
  const clientOptions = parseClientOptions(options.clientOption ?? []);
  const numTasks = count('--num-tasks', options.numTasks);
  const rollouts = count('--rollouts', options.rollouts);
  const concurrency = count('--concurrency', options.concurrency);

  const config: Record<string, unknown> = {
    model: options.model,
    // Results stay on this machine: verifiers pushes to Prime's hub by default.
    push: false,
    harness: {
      id: 'mst-harness',
      client,
      api,
      mst_command: mstCommand,
      ...(Object.keys(clientOptions).length
        ? { client_options: clientOptions }
        : {}),
      ...(options.plugins?.length ? { plugins: options.plugins } : {}),
      ...(options.workdir?.length ? { workdir: options.workdir } : {}),
      runtime: { type: 'subprocess' },
    },
    client: {
      type: 'eval',
      base_url: options.baseUrl ?? provider.baseUrl,
      api_key_var: apiKeyVar,
    },
    interception: { type: 'server' },
    ...(numTasks !== undefined ? { num_tasks: numTasks } : {}),
    ...(rollouts !== undefined ? { num_rollouts: rollouts } : {}),
    ...(concurrency !== undefined ? { max_concurrent: concurrency } : {}),
    ...(options.outputDir
      ? { output_dir: path.resolve(cwd, options.outputDir) }
      : {}),
  };

  const steps: VerifiersRunStep[] = [
    {
      command: 'uv',
      args: ['venv', '--quiet', '--python', options.python ?? '3.12', VENV],
    },
    {
      command: 'uv',
      args: [
        'pip',
        'install',
        '--quiet',
        '--python',
        PYTHON,
        '--overrides',
        OVERRIDES,
        harnessDir,
        tasksetArg,
      ],
    },
    {
      command: PYTHON,
      args: [
        '-m',
        'mst_harness.eval',
        tasksetArg,
        '@',
        CONFIG,
        ...(options.verifiersArgs ?? []),
      ],
    },
  ];
  return {
    config,
    overrides: [`mst-harness @ ${pathToFileURL(harnessDir).href}`],
    steps,
    taskset: tasksetArg,
    apiKeyVar,
  };
}

/** The command that runs this MST's CLI: the Node running it, and its entry point. */
export function currentMstCommand(): string[] {
  const entry = path.join(packageRoot(), 'dist', 'cli', 'index.js');
  if (!existsSync(entry))
    throw new Error(
      `MST's CLI is not built (${entry}). Run \`npm run build\` first.`
    );
  return [process.execPath, entry];
}

function venvPython(venv: string): string {
  return process.platform === 'win32'
    ? path.join(venv, 'Scripts', 'python.exe')
    : path.join(venv, 'bin', 'python');
}

function start(
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  isUv: boolean
): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const child = spawn(command, args, { stdio: 'inherit', env });
    child.on('error', (error: NodeJS.ErrnoException) =>
      reject(
        isUv && error.code === 'ENOENT'
          ? new Error(
              'mst verifiers run needs uv, which installs the taskset and verifiers: https://docs.astral.sh/uv/getting-started/installation/'
            )
          : error
      )
    );
    child.on('close', (code, signal) =>
      resolve(code ?? (signal === 'SIGINT' ? 130 : signal ? 143 : 1))
    );
  });
}

/**
 * Run a plan in a temporary directory that holds the venv, the overrides and the
 * config, and remove it after. Resolves with the first failing step's exit code, or 0.
 */
export async function runVerifiersPlan(
  plan: VerifiersRunPlan,
  {
    env = process.env,
    uv = 'uv',
  }: { env?: NodeJS.ProcessEnv; uv?: string } = {}
): Promise<number> {
  if (!env[plan.apiKeyVar])
    throw new Error(
      `${plan.apiKeyVar} is not set: verifiers sends it to the upstream endpoint. Set it, or name another variable with --api-key-var.`
    );
  const dir = mkdtempSync(path.join(tmpdir(), 'mst-verifiers-'));
  const venv = path.join(dir, 'venv');
  const values: Record<string, string> = {
    [CONFIG]: path.join(dir, 'eval.json'),
    [OVERRIDES]: path.join(dir, 'overrides.txt'),
    [VENV]: venv,
    [PYTHON]: venvPython(venv),
  };
  writeFileSync(values[CONFIG]!, JSON.stringify(plan.config, null, 2));
  writeFileSync(values[OVERRIDES]!, `${plan.overrides.join('\n')}\n`);
  // Keep a caller's own venv out of uv's choice of environment.
  const stepEnv = { ...env };
  delete stepEnv.VIRTUAL_ENV;
  try {
    for (const step of plan.steps) {
      const args = step.args.map((arg) => values[arg] ?? arg);
      const isUv = step.command === 'uv';
      const code = await start(
        isUv ? uv : values[PYTHON]!,
        args,
        stepEnv,
        isUv
      );
      if (code !== 0) return code;
    }
    return 0;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
