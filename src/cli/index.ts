/**
 * CLI entry point for @gleanwork/mcp-server-tester
 */

import { Command, Option } from 'commander';
import { init } from './commands/init/index.js';
import { generate } from './commands/generate/index.js';
import { login } from './commands/login/index.js';
import { token } from './commands/token/index.js';
import { open } from './commands/open/index.js';
import { run } from './commands/run/index.js';
import { grade } from './commands/grade/index.js';
import { batch } from './commands/batch/index.js';
import { collect } from './commands/collect/index.js';
import { gradeShardCommand } from './commands/grade-shard/index.js';
import { coordinate } from './commands/coordinate/index.js';
import {
  cancelRun,
  listRuns,
  runLogs,
  runStatus,
  watchRun,
} from './commands/runs/index.js';
import { setupCowork } from './commands/cowork/index.js';
import {
  auth,
  authRevoke,
  authStatus,
  type AuthOptions,
} from './commands/auth/index.js';
import {
  listDatasets,
  pullDataset,
  showDataset,
  type DatasetPullOptions,
} from './commands/datasets/index.js';
import { listJudgeCommand, showJudge } from './commands/judges/index.js';
import {
  setupEnvironment,
  type EnvSetupOptions,
} from './commands/env/index.js';
import type { DiscoveryOptions } from './commands/discoveryPlugins.js';
import packageJson from '../../package.json' with { type: 'json' };
import { inspect } from 'node:util';
import { debugCli } from '../debug.js';
import { describeError } from '../utils/describeError.js';

/** Flags 2.0 renamed (ADR 0002), recognized only to say what replaced them. */
const REMOVED_FLAGS: Record<string, string> = {};

function removedFlag(flags: string, replacement: string): Option {
  const option = new Option(flags).hideHelp();
  REMOVED_FLAGS[option.attributeName()] =
    `${option.long} is now ${replacement}`;
  return option;
}

function rejectRemovedFlags(options: Record<string, unknown>): undefined {
  for (const [name, message] of Object.entries(REMOVED_FLAGS))
    if (options[name] !== undefined) throw new Error(message);
  return undefined;
}

const program = new Command();

program
  .name('mst')
  .description(
    'MST (MCP Server Tester): CLI tools for MCP server evaluation and testing.\n' +
      'Also available as `mcp-server-tester`.'
  )
  .version(packageJson.version);

// Init command
program
  .command('init')
  .description('Initialize a new MCP evaluation project')
  .option('-n, --name <name>', 'Project name')
  .option('-d, --dir <directory>', 'Target directory', '.')
  .action(init);

// Generate command
program
  .command('generate')
  .alias('gen')
  .description("Generate Playwright tests by calling your MCP server's tools")
  .option('-c, --config <path>', 'Path to MCP config')
  .option(
    '-o, --output <path>',
    'Spec file to write or add to',
    'tests/generated.spec.ts'
  )
  .option('-s, --snapshot', 'Compare every response with a saved snapshot')
  .action(generate);

// Login command
program
  .command('login')
  .description('Authenticate with an MCP server via OAuth')
  .argument('<server-url>', 'MCP server URL to authenticate with')
  .option('--force', 'Force re-authentication even if valid token exists')
  .option('--state-dir <dir>', 'Custom directory for token storage')
  .option(
    '--scopes <scopes>',
    'Comma-separated list of scopes to request (default: all from server)'
  )
  .action(login);

// Token command
program
  .command('token')
  .description('Output stored OAuth tokens for CI/CD use')
  .argument('<server-url>', 'MCP server URL to get tokens for')
  .option(
    '-f, --format <format>',
    'Output format: env, json, or gh (default: env)',
    'env'
  )
  .option('--state-dir <dir>', 'Custom directory for token storage')
  .action(token);

// Auth command: sign in to an eval config's connector servers
function withConfig(options: AuthOptions): AuthOptions {
  // Not a commander requiredOption: that would also bind `auth status --config`.
  if (typeof options.config !== 'string')
    throw new Error("required option '-c, --config <path>' not specified");
  return options;
}
function authOptions(command: Command): Command {
  return command
    .option('-c, --config <path>', 'Path to an eval config JSON')
    .option('--plugins <paths...>', 'Plugin modules to load')
    .option('--server <labels...>', 'Only these servers')
    .option(
      '--store <store>',
      'Credential store: a directory (default: ~/.mcp-server-tester/grants) or <namespace>/credential-store/<name>'
    )
    .option('--root-dir <dir>', 'Fallback directory for relative paths', '.');
}
const authCommand = authOptions(
  program
    .command('auth')
    .description(
      'Sign in once to the connector servers an eval config uses; runs refresh the tokens'
    )
    .option('--force', 'Sign in again even if a valid grant exists')
).action((options: AuthOptions) => auth(withConfig(options)));
authOptions(
  authCommand
    .command('status')
    .description('Show which servers are signed in (exits 1 if any is not)')
).action((_options: AuthOptions, command: Command) =>
  authStatus(withConfig(command.optsWithGlobals<AuthOptions>()))
);
authOptions(
  authCommand
    .command('revoke')
    .description("Revoke servers' grants at the provider and delete them")
).action((_options: AuthOptions, command: Command) =>
  authRevoke(withConfig(command.optsWithGlobals<AuthOptions>()))
);

// Datasets command: the datasets plugins provide
function discoveryOptions(command: Command): Command {
  return command
    .option('--plugins <modules...>', 'Plugin modules to look in')
    .option('-c, --config <path>', "Look in an eval config's plugins")
    .option('--root-dir <dir>', 'Where relative plugin paths resolve', '.')
    .option('--json', 'Print JSON');
}
function datasetSelection(command: Command): Command {
  return command
    .option('--snapshot <id>', "A snapshot (default: the plugin's latest)")
    .option('--source <source>', 'snapshot (default) or live');
}
const datasetsCommand = discoveryOptions(
  program
    .command('datasets')
    .description("List plugins' datasets: cases, snapshot, tags")
).action((options: DatasetPullOptions) => listDatasets(options));
discoveryOptions(
  datasetSelection(
    datasetsCommand
      .command('show')
      .description("A dataset's snapshot, case count, hash, tags and judges")
      .argument('<ref>', 'namespace/dataset/name')
  )
).action((ref: string, _options: unknown, command: Command) =>
  showDataset(ref, command.optsWithGlobals<DatasetPullOptions>())
);
discoveryOptions(
  datasetSelection(
    datasetsCommand
      .command('pull')
      .description('Write a dataset as a dataset file, to read, diff or freeze')
      .argument('<ref>', 'namespace/dataset/name')
      .option('-o, --out <file>', 'Write here (default: stdout)')
  )
).action((ref: string, _options: unknown, command: Command) =>
  pullDataset(ref, command.optsWithGlobals<DatasetPullOptions>())
);

// Judges command: built-in and plugin judges
const judgesCommand = discoveryOptions(
  program
    .command('judges')
    .description('List judges and pairwise judges: built-in and from plugins')
).action((options: DiscoveryOptions) => listJudgeCommand(options));
discoveryOptions(
  judgesCommand
    .command('show')
    .description("A judge's description, what it requires, and its options")
    .argument('<ref>', 'A built-in name, or namespace/judge/name')
).action((ref: string, _options: unknown, command: Command) =>
  showJudge(ref, command.optsWithGlobals<DiscoveryOptions>())
);

// Run command
program
  .command('run')
  .description('Run an eval config')
  .option('-c, --config <path>', 'Path to an eval config JSON')
  .option('--plugins <paths...>', 'Plugin modules to load before the run')
  .option('--variant <names...>', "Run only these of the config's variants")
  .option(
    '--case <ids...>',
    "Run only these case ids (instead of the config's tags and case cap)"
  )
  .option(
    '--filter-tag <tags...>',
    "Run the cases with any of these tags, instead of the config's filterTags"
  )
  .option(
    '--max-cases <n>',
    "Cases per dataset, instead of the config's maxCases"
  )
  .option('--trials <n>', 'Trials per case, instead of the config or case')
  .option(
    '--output-dir <dir>',
    "The eval's directory: each run goes in <dir>/runs/<run-id>/"
  )
  .option('--secrets-file <path>', 'JSON or dotenv-style runtime secrets file')
  .option(
    '--root-dir <dir>',
    'Fallback directory for relative config paths; default location for results',
    '.'
  )
  .option('--dry-run', 'Validate the config and plugins without executing')
  .option(
    '--no-grade',
    'Collect the trials without grading them; grade them later with mst grade'
  )
  .option(
    '--resume <run>',
    'Collect only the trials a run is missing (its shards ended early), in its environment, and grade it again'
  )
  .option(
    '--no-report',
    "Don't write the run's report (mst open writes it when it opens the run)"
  )
  .option(
    '--results <store>',
    "Also keep the run in a result store, instead of the eval config's: gs://<bucket>/<prefix>, file:<dir>, or <namespace>/result-store/<name>"
  )
  .option(
    '--store <store>',
    'Credential store for connector servers: a directory (default: ~/.mcp-server-tester/grants) or <namespace>/credential-store/<name>'
  )
  .option(
    '--detach',
    'Run the coordinator on a machine the environment creates, and return: this machine can then go offline (needs a remote --results and, for connectors, a shared --store)'
  )
  .addOption(
    new Option(
      '--loaded-datasets <file>',
      "The eval config's datasets as loaded elsewhere (a detached run's coordinator passes them)"
    ).hideHelp()
  )
  .option(
    '--grade-env',
    'After collecting, grade the run in its environment (mst grade --env), instead of on this machine'
  )
  .option(
    '--env <name>',
    'Where to collect trials: local (the default), docker, or a plugin environment (<namespace>/env/<name>)'
  )
  .option(
    '--env-option <key=value>',
    "An environment option; repeat for more: shards=N, keep=never|failed|always, or the environment's own",
    (value: string, previous: string[]) => [...previous, value],
    [] as string[]
  )
  .addOption(removedFlag('-m, --manifest <path>', '--config'))
  .addOption(removedFlag('--arm <name>', '--variant'))
  .action((options: Record<string, unknown>) => {
    rejectRemovedFlags(options);
    if (typeof options.config !== 'string')
      throw new Error("required option '-c, --config <path>' not specified");
    return run(options as unknown as Parameters<typeof run>[0]);
  });

// Grade command
program
  .command('grade')
  .description(
    "Grade a stored run's traces again with the eval config's graders, as a new run (<run-id>.g<n>)"
  )
  .argument('<run>', 'Run directory, run ID, or its short form (7f3c2a)')
  .requiredOption('-c, --config <path>', 'Path to the eval config the run ran')
  .option('--plugins <paths...>', 'Plugin modules to load before grading')
  .option(
    '--output-dir <dir>',
    "Directory of the eval's runs, if mst run was given one"
  )
  .option('--secrets-file <path>', 'JSON or dotenv-style runtime secrets file')
  .option(
    '--root-dir <dir>',
    'Fallback directory for relative config paths; default location for results',
    '.'
  )
  .option(
    '--no-report',
    "Don't write the regrade's report (mst open writes it when it opens the run)"
  )
  .option(
    '--results <store>',
    "Also keep the regrade in a result store, instead of the eval config's: gs://<bucket>/<prefix>, file:<dir>, or <namespace>/result-store/<name>"
  )
  .option(
    '--env <name>',
    'Where to grade: local (the default), docker, or a plugin environment (<namespace>/env/<name>); judge keys go to its machines from --secrets-file'
  )
  .option(
    '--detach',
    'Grade from a coordinator machine the environment creates, and return (the run must be in the result store)'
  )
  .option(
    '--resume',
    "Finish a graded run's grading: keep every verdict it has, and run only the judges and pairwise judges that failed to run (a timeout, a lost grade shard). Give the regrade (<run-id>.g<n>) to finish"
  )
  .addOption(
    new Option(
      '--loaded-datasets <file>',
      "The eval config's datasets as loaded elsewhere (a detached run's coordinator passes them)"
    ).hideHelp()
  )
  .option(
    '--env-option <key=value>',
    "An environment option; repeat for more: shards=N, keep=never|failed|always, or the environment's own",
    (value: string, previous: string[]) => [...previous, value],
    [] as string[]
  )
  .action((runArg: string, options: Record<string, unknown>) =>
    grade(runArg, options as unknown as Parameters<typeof grade>[1])
  );

// Batch command
program
  .command('batch')
  .description('Run several eval configs')
  .option('--configs <paths...>', 'Eval config files')
  .option('--config-dir <dir>', 'Directory of eval configs')
  .option('--plugins <paths...>', 'Plugin modules to load before the batch')
  .option(
    '--root-dir <dir>',
    'Fallback directory for relative config paths; default location for results',
    '.'
  )
  .option('--output-root <dir>', 'Root directory for evaluation results')
  .option('--secrets-file <path>', 'JSON or dotenv-style runtime secrets file')
  .option('--workers <number>', 'Maximum number of configs run in parallel')
  .option('--skip-existing', 'Skip configs with an existing result')
  .option('--dry-run', 'Validate configs without executing evaluations')
  .addOption(removedFlag('--manifests <paths...>', '--configs'))
  .addOption(removedFlag('--manifest-dir <dir>', '--config-dir'))
  .action(
    (options) =>
      rejectRemovedFlags(options) ??
      batch({
        configs: options.configs,
        configDir: options.configDir,
        plugins: options.plugins,
        rootDir: options.rootDir,
        outputRoot: options.outputRoot,
        secretsFile: options.secretsFile,
        workers: options.workers ? Number(options.workers) : undefined,
        skipExisting: options.skipExisting,
        dryRun: options.dryRun,
      })
  );

// Cowork setup command
program
  .command('cowork')
  .description('Prepare the local macOS Claude 3P profile for Cowork')
  .command('setup')
  .description('Initialize or validate the empty Claude 3P profile')
  .action(setupCowork);

// Open command
program
  .command('open')
  .description(
    "Open a run's report: the newest run, or the run or eval directory you name"
  )
  .argument(
    '[path]',
    'A run directory, or an eval directory for its latest run'
  )
  .option(
    '-d, --dir <directory>',
    'Where runs are written',
    '.mcp-test-results'
  )
  .option('--print', "Print the report's path instead of opening it")
  .action(open);

// Env command: prepare an environment once (ADR 0004)
program
  .command('env')
  .description('Prepare environments that runs collect trials in')
  .command('setup')
  .description(
    "Prepare what runs in an environment need, once: docker builds MST's Linux Cowork image"
  )
  .argument('<environment>', 'docker, or <namespace>/env/<name>')
  .option(
    '--env-option <key=value>',
    "An environment option; repeat for more: the environment's own (docker: image, contexts, claudeDesktopVersion)",
    (value: string, previous: string[]) => [...previous, value],
    [] as string[]
  )
  .option(
    '--config <file>',
    "An eval config whose plugins the environment's machines need (docker installs them in its image)"
  )
  .option(
    '--plugins <modules...>',
    "Plugin modules, for a plugin's environment"
  )
  .option('--root-dir <dir>', 'Where relative plugin paths resolve', '.')
  .action((reference: string, options: EnvSetupOptions) =>
    setupEnvironment(reference, options)
  );

// Collect command: a shard's worker, started by environments (ADR 0004)
program
  .command('collect', { hidden: true })
  .description("Collect a shard's trials (environments run this)")
  .requiredOption('--bundle <dir>', "The shard's bundle directory")
  .requiredOption('--results <dir>', 'Where to write result files')
  .action(collect);

// Coordinate command: a detached run's coordinator, started by --detach (ADR 0007)
program
  .command('coordinate', { hidden: true })
  .description("Run a detached run's coordinator (--detach starts this)")
  .requiredOption('--bundle <dir>', "The detached run's bundle directory")
  .option('--daemon', 'Run the coordinator in this process')
  .option('--secrets <file>', "The run's secrets file")
  .action(coordinate);

// Runs command: detached runs (ADR 0007)
const runsCommand = program
  .command('runs')
  .description(
    'Detached runs (mst run --detach): list, watch, show logs, cancel'
  );
function runsFlags(command: Command): Command {
  return command
    .requiredOption('-c, --config <path>', 'The eval config the run ran')
    .option(
      '--results <store>',
      "The result store the run was given, if not the eval config's"
    )
    .option('--root-dir <dir>', 'Fallback directory for relative paths', '.');
}
runsFlags(
  runsCommand
    .command('list')
    .description("The eval's detached runs, newest first")
).action((options: Parameters<typeof listRuns>[0]) => listRuns(options));
runsFlags(
  runsCommand
    .command('status')
    .description('One detached run: its state and last lines')
    .argument('<id>', 'Its id, or the end of it (3fa9c1)')
).action((id: string, options: Parameters<typeof runStatus>[1]) =>
  runStatus(id, options)
);
runsFlags(
  runsCommand
    .command('watch')
    .description('Follow a detached run until it ends')
    .argument('<id>', 'Its id, or the end of it (3fa9c1)')
    .option('--interval <seconds>', 'How often to check', '30')
).action((id: string, options: Parameters<typeof watchRun>[1]) =>
  watchRun(id, options)
);
runsFlags(
  runsCommand
    .command('logs')
    .description("A detached run's coordinator output")
    .argument('<id>', 'Its id, or the end of it (3fa9c1)')
).action((id: string, options: Parameters<typeof runLogs>[1]) =>
  runLogs(id, options)
);
runsFlags(
  runsCommand
    .command('cancel')
    .description('Stop a detached run: it keeps what it collected')
    .argument('<id>', 'Its id, or the end of it (3fa9c1)')
).action((id: string, options: Parameters<typeof cancelRun>[1]) =>
  cancelRun(id, options)
);

// Grade shard command: a grade shard's worker, started by environments (ADR 0005)
program
  .command('grade-shard', { hidden: true })
  .description("Grade a shard of a stored run's cases (environments run this)")
  .requiredOption('--bundle <dir>', "The shard's grade bundle directory")
  .requiredOption('--results <dir>', 'Where to write result files')
  .action(gradeShardCommand);

// An ordinary mistake (a missing file, a misspelt key) prints one message,
// not a stack trace; DEBUG shows the stack.
// DEBUG=mcp-server-tester:cli shows the stack and causes. Exit once stderr
// is written, so a connection a failed command left open can't hold the
// process.
program.parseAsync().catch((error: unknown) => {
  const detail = debugCli.enabled ? `${inspect(error, { depth: 6 })}\n` : '';
  process.stderr.write(`mst: ${describeError(error)}\n${detail}`, () =>
    process.exit(1)
  );
});
