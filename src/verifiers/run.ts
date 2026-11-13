/**
 * `mst verifiers run <taskset>`: verifiers' `vf-run`, with MST's harness (ADR 0015).
 *
 * verifiers runs the eval: it loads the taskset, records the model calls through its
 * interception server, and scores each rollout. MST is the harness: the bundled
 * `mst-harness` plugin runs one `mst run` trial per rollout, with this MST's CLI.
 *
 * This command is a shortcut, not a second runner. It installs `mst-harness` and the
 * taskset into a temporary venv with uv, writes a `vf-run` config that selects the
 * harness, and runs `vf-run` there, so nothing needs installing first but uv. The
 * bundled `mst-harness` overrides any other the taskset names, so the harness always
 * matches this MST. Anyone with verifiers installed can run the same eval with
 * `vf-run <taskset> --env.agent.harness.id mst-harness` (docs/verifiers.md).
 */

import { spawn } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { packageRoot } from '../utils/packageRoot.js';

type VerifiersApi = 'anthropic' | 'openai';

/** The harness `dialect` an `--api` stands for. */
const DIALECTS: Record<VerifiersApi, string> = {
  anthropic: 'anthropic_messages',
  openai: 'responses',
};

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
  /** `--output-dir`: where verifiers writes the run. Default: verifiers' `outputs/` here. */
  outputDir?: string;
  /** The Python uv creates the venv with. */
  python?: string;
  /** `vf-run` options after `--`, passed through. They override the ones above. */
  verifiersArgs?: string[];
}

/** One command the run starts. Arguments may hold the placeholders below. */
interface VerifiersRunStep {
  /** `uv`, or the venv's `vf-run`. */
  command: 'uv' | typeof VF_RUN;
  args: string[];
}

export interface VerifiersRunPlan {
  /** `vf-run`'s config, written to a JSON file and passed as `@ file`. */
  config: VerifiersRunConfig;
  /** `requirement @ url` lines that override what the taskset asks for. */
  overrides: string[];
  /** Create the venv, install into it, run the eval. */
  steps: VerifiersRunStep[];
  /** The taskset id `vf-run` loads. */
  taskset: string;
  /** The variable that must hold the upstream key. */
  apiKeyVar: string;
}

/** The `vf-run` config: the parts this command sets. */
interface VerifiersRunConfig {
  model: string;
  env: {
    agent: {
      harness: { id: 'mst-harness'; client: string } & Record<string, unknown>;
      runtime: { type: 'subprocess' };
    };
  };
  client: { base_url: string; api_key_var: string };
  select?: { limit: number };
  num_rollouts?: number;
  max_concurrent?: number;
  output_dir?: string;
}

export const CONFIG = '{config}';
export const VENV = '{venv}';
export const OVERRIDES = '{overrides}';
export const PYTHON = '{python}';
export const VF_RUN = '{vf-run}';

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
  return path.join(root, 'verifiers', 'harnesses', 'mst_harness');
}

/**
 * The taskset id of a package directory: its project name, which verifiers imports
 * with `-` as `_`, as it does for `vf-run <id>`.
 */
export function tasksetIdOf(directory: string): string {
  const pyproject = path.join(directory, 'pyproject.toml');
  if (!existsSync(pyproject))
    throw new Error(
      `${directory} has no pyproject.toml: a taskset is a Python package that exports its Taskset.`
    );
  const project = readFileSync(pyproject, 'utf8').split(/^\[project\]\s*$/m)[1];
  const name = project
    ?.split(/^\[/m)[0]
    ?.match(/^name\s*=\s*["']([^"']+)["']/m)?.[1];
  if (!name) throw new Error(`${pyproject} has no [project] name.`);
  return name;
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
  // The same choice as the harness's `dialect = "auto"`.
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
  // A directory is installed from there; any other name is a package to install.
  const requirement = isDirectory ? local : taskset;
  const tasksetId = isDirectory ? tasksetIdOf(local) : taskset;
  const clientOptions = parseClientOptions(options.clientOption ?? []);
  const numTasks = count('--num-tasks', options.numTasks);
  const rollouts = count('--rollouts', options.rollouts);
  const concurrency = count('--concurrency', options.concurrency);

  const config: VerifiersRunConfig = {
    model: options.model,
    env: {
      agent: {
        harness: {
          id: 'mst-harness',
          client,
          ...(options.api ? { dialect: DIALECTS[api] } : {}),
          mst_command: mstCommand,
          ...(Object.keys(clientOptions).length
            ? { client_options: clientOptions }
            : {}),
          ...(options.plugins?.length ? { plugins: options.plugins } : {}),
          ...(options.workdir?.length ? { workdir: options.workdir } : {}),
        },
        // MST starts the client on this machine, as `mst run` does.
        runtime: { type: 'subprocess' },
      },
    },
    client: {
      base_url: options.baseUrl ?? provider.baseUrl,
      api_key_var: apiKeyVar,
    },
    ...(numTasks !== undefined ? { select: { limit: numTasks } } : {}),
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
        requirement,
      ],
    },
    {
      command: VF_RUN,
      args: [tasksetId, '@', CONFIG, ...(options.verifiersArgs ?? [])],
    },
  ];
  return {
    config,
    overrides: [`mst-harness @ ${pathToFileURL(harnessDir).href}`],
    steps,
    taskset: tasksetId,
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

function venvBin(venv: string, name: string): string {
  return process.platform === 'win32'
    ? path.join(venv, 'Scripts', `${name}.exe`)
    : path.join(venv, 'bin', name);
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
    [PYTHON]: venvBin(venv, 'python'),
    [VF_RUN]: venvBin(venv, 'vf-run'),
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
        isUv ? uv : values[step.command]!,
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
