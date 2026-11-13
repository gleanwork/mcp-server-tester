/**
 * CLI entry point for @gleanwork/mcp-server-tester
 */

import { Command, Option } from 'commander';
import { init } from './commands/init/index.js';
import { generate } from './commands/generate/index.js';
import { login } from './commands/login/index.js';
import { TOKEN_FORMATS, token } from './commands/token/index.js';
import { open } from './commands/open/index.js';
import { run } from './commands/run/index.js';
import { grade } from './commands/grade/index.js';
import {
  optimizeEvidence,
  optimizeFinish,
  optimizeStart,
  optimizeTry,
} from './commands/optimize/index.js';
import type {
  OptimizeEvidenceOptions,
  OptimizeStartOptions,
  OptimizeTargetOptions,
  OptimizeTryOptions,
} from './commands/optimize/index.js';
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
import { history, type HistoryOptions } from './commands/history/index.js';
import { setConfigOverrideFile } from '../plugins/settingsFile.js';
import {
  restoreCoworkConnectorsCommand,
  setupCowork,
} from './commands/cowork/index.js';
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
import { listClientCommand, showClient } from './commands/clients/index.js';
import {
  checkJudgeCommand,
  type JudgeCheckCommandOptions,
} from './commands/judges/check.js';
import {
  labelExport,
  labelImport,
  labelPage,
  type LabelPageCommandOptions,
  type LabelExportCommandOptions,
  type LabelImportCommandOptions,
} from './commands/label/index.js';
import {
  setupRunner,
  type RunnerSetupOptions,
} from './commands/runner/index.js';
import type { DiscoveryOptions } from './commands/discoveryPlugins.js';
import { verifiersRun } from './commands/verifiers/index.js';
import type { VerifiersRunOptions } from '../verifiers/run.js';
import packageJson from '../../package.json' with { type: 'json' };
import { inspect } from 'node:util';
import { debugCli } from '../debug.js';
import { describeError } from '../utils/describeError.js';

/**
 * Flags 2.0 renamed (ADR 0002, ADR 0013), recognized only to say what
 * replaced them.
 */
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
  .version(packageJson.version)
  .option(
    '--mst-config <path>',
    "An mst.config.json read over the user's and the repo's, and over each eval config's settings and models"
  )
  .hook('preAction', () => {
    const file = program.opts<{ mstConfig?: string }>().mstConfig;
    if (file !== undefined) setConfigOverrideFile(file);
  });

// Init command
program
  .command('init')
  .description(
    'Initialize a new MCP evaluation project (asks for what flags leave out, in a terminal)'
  )
  .option('-n, --name <name>', 'Project name (default: my-mcp-tests)')
  .option('-d, --dir <directory>', 'Target directory', '.')
  .option(
    '--command <command>',
    'Command that starts a stdio MCP server, such as "node server.js"'
  )
  .option('--url <url>', 'URL of an HTTP MCP server')
  .option('--install', 'Run npm install (default)')
  .option('--no-install', "Don't run npm install")
  .option('--force', 'Write into an existing project directory')
  .action(init);

// Generate command
program
  .command('generate')
  .alias('gen')
  .description(
    "Generate Playwright tests by calling your MCP server's tools (with --tool, records one call without asking)"
  )
  .option('-c, --config <path>', 'Path to MCP config')
  .option('--url <url>', 'URL of an HTTP MCP server, instead of --config')
  .option(
    '--command <command>',
    'Command that starts a stdio MCP server, instead of --config'
  )
  .option(
    '-o, --output <path>',
    'Spec file to write or add to',
    'tests/generated.spec.ts'
  )
  .option('-s, --snapshot', 'Compare every response with a saved snapshot')
  .option('--tool <name>', 'Record one call to this tool, without asking')
  .option('--args <json>', 'Arguments for --tool, as a JSON object', '{}')
  .option(
    '--name <title>',
    'Title of the test --tool writes (default: <tool>-<n>)'
  )
  .option('--description <text>', 'Comment above the test --tool writes')
  .option(
    '--suite <name>',
    'describe() name of a new spec (default: MCP tools)'
  )
  .option('--exact', 'Also assert the exact response (with --tool)')
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
  .addOption(
    new Option('-f, --format <format>', 'Output format')
      .choices(TOKEN_FORMATS)
      .default('env')
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

// Clients command: built-in and plugin clients
const clientsCommand = discoveryOptions(
  program
    .command('clients')
    .description(
      'List clients: built-in and from plugins, with where each one runs'
    )
).action((options: DiscoveryOptions) => listClientCommand(options));
discoveryOptions(
  clientsCommand
    .command('show')
    .description(
      "A client's description, what a machine needs to run it, and its options"
    )
    .argument('<ref>', 'A built-in name, or namespace/client/name')
).action((ref: string, _options: unknown, command: Command) =>
  showClient(ref, command.optsWithGlobals<DiscoveryOptions>())
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
judgesCommand
  .command('check')
  .description(
    "Measure a judge against people's labels: TPR, TNR, kappa, unknown rate, and whether it is usable"
  )
  .argument(
    '<runs...>',
    'Run directories, eval directories (their latest runs), or run IDs (7f3c2a)'
  )
  .requiredOption(
    '--judge <name>',
    "The judge's name in results: a rubric judge's rubric, else its reference"
  )
  .option(
    '--split <split>',
    'The labels to use: test (the default, and the only one recorded), dev or all'
  )
  .option(
    '--min-labels <n>',
    'Failing and passing labels a usable judge needs, each (default 15)'
  )
  .option(
    '--min-rate <rate>',
    'The lowest TPR and TNR lower bound a usable judge has (default 0.8)'
  )
  .option(
    '--max-unknown <rate>',
    'The largest share of unknown answers a usable judge gives (default 0.1)'
  )
  .option('--no-record', "Don't write the calibration record")
  .option('--json', 'Print the checks as JSON')
  .option(
    '-d, --dir <directory>',
    'Where runs are written, to find a run by ID',
    '.mcp-test-results'
  )
  // `judges` has a --json of its own, which takes the flag wherever it is.
  .action((runs: string[], _options: unknown, command: Command) =>
    checkJudgeCommand(
      runs,
      command.optsWithGlobals<JudgeCheckCommandOptions>()
    ).then(() => undefined)
  );

// Label command: a person's labels for a run's judge verdicts (ADR 0009)
const runArgumentHelp =
  'A run directory, an eval directory (its latest run), or a run ID or its short form (7f3c2a)';
const labelCommand = program
  .command('label')
  .description(
    "A person's labels for a run's judge verdicts, which mst judges check measures judges against"
  );
// The default, so `mst label <run> --judge <name>` serves the page. Its
// options are its own, not `label`'s, so they never take export's --judge.
labelCommand
  .command('page', { isDefault: true })
  .description(
    "Serve a page that shows one trial at a time, without the judge's verdict, and stores your labels (the default: mst label <run> --judge <name>)"
  )
  .argument('<run>', runArgumentHelp)
  .option(
    '--judge <name>',
    "The judge whose verdicts to label, by its name in results (a rubric judge's rubric)"
  )
  .option(
    '--split <split>',
    "The split for a case without labels: test or dev (default: each case's own); a case's labels share one split"
  )
  .option('--labeler <name>', 'Who is labeling (default: your user name)')
  .option(
    '--question <text>',
    "The judge's question, to show above each trial (default: a rubric's text; other judges have none)"
  )
  .option('--port <n>', 'The port to serve on (default: any free port)')
  .option('--no-open', "Print the page's address without opening a browser")
  .option(
    '-d, --dir <directory>',
    'Where runs are written, to find a run by ID',
    '.mcp-test-results'
  )
  .action(async (run: string, options: LabelPageCommandOptions) => {
    const server = await labelPage(run, options);
    await new Promise<void>((resolve) => {
      process.once('SIGINT', resolve);
      process.once('SIGTERM', resolve);
    });
    await server.close();
    const written = server.written();
    console.log(
      `\nStored ${written} label${written === 1 ? '' : 's'}. Run mst judges check to measure the judge.`
    );
  });
labelCommand
  .command('import')
  .description(
    "Add a file's labels to a run; a label for a verdict that has one replaces it"
  )
  .argument('<run>', runArgumentHelp)
  .argument('<file>', 'CSV, JSONL, or judgekeeper records')
  .option(
    '--format <format>',
    "csv, jsonl or judgekeeper (default: from the file's name and contents)"
  )
  .option(
    '--labeler <name>',
    "Who gave labels that don't say (default: your user name)"
  )
  .option(
    '-d, --dir <directory>',
    'Where runs are written, to find a run by ID',
    '.mcp-test-results'
  )
  .action((run: string, file: string, options: LabelImportCommandOptions) =>
    labelImport(run, file, options)
  );
labelCommand
  .command('export')
  .description(
    'A row for each judge verdict in a run, with its label: fill in the label column and import it back'
  )
  .argument('<run>', runArgumentHelp)
  .option(
    '--judge <name...>',
    "Only these judges, by their name in results (a rubric judge's rubric)"
  )
  .option(
    '--format <format>',
    "csv, jsonl or judgekeeper (default: from --output's name, else csv)"
  )
  .option('-o, --output <file>', 'Write to a file instead of stdout')
  .option(
    '-d, --dir <directory>',
    'Where runs are written, to find a run by ID',
    '.mcp-test-results'
  )
  .action((run: string, options: LabelExportCommandOptions) =>
    labelExport(run, options)
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
    '--allow-live-writes',
    'Let writes reach the service on servers the eval config declares "writes": { "<label>": "live" }'
  )
  .option(
    '--resume <run>',
    'Collect again only the trials a run is missing or lost to an infrastructure failure a retry can help, in its runner (not local; use --runner), and grade it again'
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
    'Run the coordinator on a machine the runner creates, and return: this machine can then go offline (needs a remote --results and, for connectors, a shared --store)'
  )
  .addOption(
    new Option(
      '--loaded-datasets <file>',
      "The eval config's datasets as loaded elsewhere (a detached run's coordinator passes them)"
    ).hideHelp()
  )
  .option(
    '--grade-runner',
    'After collecting, grade the run in its runner (mst grade --runner), instead of on this machine'
  )
  .option(
    '--runner <name>',
    'Where to collect trials: local (the default), docker, or a plugin runner (<namespace>/runner/<name>)'
  )
  .option(
    '--runner-option <key=value>',
    "A runner option; repeat for more: shards=N, keep=never|failed|always, or the runner's own",
    (value: string, previous: string[]) => [...previous, value],
    [] as string[]
  )
  .addOption(removedFlag('-m, --manifest <path>', '--config'))
  .addOption(removedFlag('--arm <name>', '--variant'))
  .addOption(removedFlag('--env <name>', '--runner'))
  .addOption(removedFlag('--env-option <key=value>', '--runner-option'))
  .addOption(removedFlag('--grade-env', '--grade-runner'))
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
    "Grade a stored run's transcripts again with the eval config's graders, as a new run (<run-id>.g<n>)"
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
    '--runner <name>',
    'Where to grade: local (the default), docker, or a plugin runner (<namespace>/runner/<name>); judge keys go to its machines from --secrets-file'
  )
  .option(
    '--detach',
    'Grade from a coordinator machine the runner creates, and return (the run must be in the result store)'
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
    '--runner-option <key=value>',
    "A runner option; repeat for more: shards=N, keep=never|failed|always, or the runner's own",
    (value: string, previous: string[]) => [...previous, value],
    [] as string[]
  )
  .addOption(removedFlag('--env <name>', '--runner'))
  .addOption(removedFlag('--env-option <key=value>', '--runner-option'))
  .action(
    (runArg: string, options: Record<string, unknown>) =>
      rejectRemovedFlags(options) ??
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

// Optimize command: a stored tool optimization, a step at a time (ADR 0008)
const optimizeCommand = program
  .command('optimize')
  .description(
    "Improve a server's tool metadata: measure it, try candidates in rounds, and get a recommendation"
  );
/** The flags every optimize command takes to find the eval and its optimization. */
function optimizeTarget(command: Command, withId = true): Command {
  command
    .requiredOption('-c, --config <path>', 'Path to an eval config JSON')
    .option('--plugins <paths...>', 'Plugin modules to load before each run')
    .option(
      '--output-dir <dir>',
      "The eval's directory: runs in <dir>/runs/, optimizations in <dir>/optimizations/"
    )
    .option(
      '--secrets-file <path>',
      'JSON or dotenv-style runtime secrets file'
    )
    .option(
      '--store <store>',
      'Credential store for connector servers: a directory or <namespace>/credential-store/<name>'
    )
    .option(
      '--results <store>',
      'Also keep each run in a result store: gs://<bucket>/<prefix>, file:<dir>, or <namespace>/result-store/<name>'
    )
    .option(
      '--root-dir <dir>',
      'Fallback directory for relative config paths; default location for results',
      '.'
    );
  if (withId)
    command.option(
      '--id <id>',
      'The optimization, or the end of its id (default: the latest)'
    );
  return command;
}
optimizeTarget(
  optimizeCommand
    .command('start')
    .description(
      'Measure the current tool metadata (the baseline) and store a new optimization'
    ),
  false
)
  .option(
    '--variant <name>',
    "The config's variant the candidates build on (default: its baseline)"
  )
  .option(
    '--tool <names...>',
    'The tools candidates may change: a name, or server.tool (default: every tool)'
  )
  .option(
    '--metric <name>',
    'The variant metric to improve: passRate (default), trialPassRate, or a metric key'
  )
  .option('--better <direction>', 'higher (default) or lower')
  .option(
    '--max-variants <n>',
    'Most candidates to run, across every round (default: 6)'
  )
  .option(
    '--regression-check <check>',
    'What breaks a regression case: significant (default) or any-case'
  )
  .option(
    '--allow-regressions',
    'Let a candidate that breaks regression cases win'
  )
  .option('--case <ids...>', 'Run only these case ids, every run')
  .option(
    '--filter-tag <tags...>',
    'Run the cases with any of these tags, every run'
  )
  .option('--max-cases <n>', 'Cases per dataset, every run')
  .option('--trials <n>', 'Trials per case, every run')
  .option(
    '--runner <name>',
    'Where every run collects trials: local (the default), docker, or <namespace>/runner/<name>'
  )
  .option(
    '--runner-option <key=value>',
    'A runner option; repeat for more',
    (value: string, previous: string[]) => [...previous, value],
    [] as string[]
  )
  .addOption(removedFlag('--env <name>', '--runner'))
  .addOption(removedFlag('--env-option <key=value>', '--runner-option'))
  .action(
    (options: Record<string, unknown>) =>
      rejectRemovedFlags(options) ??
      optimizeStart(options as unknown as OptimizeStartOptions)
  );
optimizeTarget(
  optimizeCommand
    .command('evidence')
    .description(
      'Show the tools, the baseline and each round so far: what the next candidates can learn from (held-out cases left out)'
    )
)
  .option('--json', 'Print the evidence as JSON, with full input schemas')
  .action((options: OptimizeEvidenceOptions) => optimizeEvidence(options));
optimizeTarget(
  optimizeCommand
    .command('try')
    .argument(
      '[file]',
      'Candidates as JSON: [{ "id", "description", "tools": { "<tool>": { "description" } } }], or - for stdin'
    )
    .description(
      'Check a round of candidates against the served tools, then run them'
    )
)
  .option('--retry', "Run the round that didn't finish again")
  .option(
    '--proposer <name>',
    'Who wrote the candidates, for the record (default: agent)'
  )
  .action((file: string | undefined, options: OptimizeTryOptions) =>
    optimizeTry(file, options)
  );
optimizeTarget(
  optimizeCommand
    .command('finish')
    .description(
      'End the optimization and write its recommendation (recommendation.md)'
    )
).action((options: OptimizeTargetOptions) => optimizeFinish(options));

// Cowork setup and recovery commands
const coworkCommand = program
  .command('cowork')
  .description('Prepare or recover the local macOS Cowork desktop');
coworkCommand
  .command('setup')
  .description('Initialize or validate the empty Claude 3P profile')
  .action(setupCowork);
coworkCommand
  .command('restore-connectors')
  .description(
    'Restore Claude account connector settings from an existing journal only'
  )
  .option(
    '--recover-stale-lock',
    'Reclaim a desktop lock only when its local owner is provably stopped'
  )
  .action(restoreCoworkConnectorsCommand);

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
  .option(
    '--history',
    "Open the eval's history page instead: the eval the path or --config names, or the newest"
  )
  .option('-c, --config <path>', 'With --history: the eval config')
  .option(
    '--output-dir <dir>',
    "With --config: the eval's directory, if mst run was given one"
  )
  .option('--root-dir <dir>', 'Fallback directory for relative paths', '.')
  .action(open);

// Runner command: prepare a runner once (ADR 0004)
program
  .command('runner')
  .description('Prepare runners that runs collect trials in')
  .command('setup')
  .description(
    "Prepare what runs in a runner need, once: docker builds MST's Linux Cowork image"
  )
  .argument('<runner>', 'docker, or <namespace>/runner/<name>')
  .option(
    '--runner-option <key=value>',
    "A runner option; repeat for more: the runner's own (docker: image, contexts, claudeDesktopVersion)",
    (value: string, previous: string[]) => [...previous, value],
    [] as string[]
  )
  .option(
    '--config <file>',
    "An eval config whose plugins the runner's machines need (docker installs them in its image)"
  )
  .option('--plugins <modules...>', "Plugin modules, for a plugin's runner")
  .option('--root-dir <dir>', 'Where relative plugin paths resolve', '.')
  .addOption(removedFlag('--env-option <key=value>', '--runner-option'))
  .action(
    (reference: string, options: Record<string, unknown>) =>
      rejectRemovedFlags(options) ??
      setupRunner(reference, options as unknown as RunnerSetupOptions)
  );

// `mst env` became `mst runner` (ADR 0013): recognized only to say so.
program
  .command('env', { hidden: true })
  .allowUnknownOption()
  .allowExcessArguments()
  .action(() => {
    throw new Error('`mst env` is now `mst runner`');
  });

// Verifiers command: a verifiers taskset on an MST client (ADR 0015)
program
  .command('verifiers')
  .description(
    'Run verifiers tasksets on MST clients: verifiers scores, MST runs the client'
  )
  .command('run')
  .description(
    "verifiers' vf-run with MST's harness, here, with uv: each rollout is one MST trial"
  )
  .argument(
    '<taskset>',
    'A taskset package directory (with a pyproject.toml), or an installable taskset package name'
  )
  .argument(
    '[verifiers-args...]',
    'After --: more vf-run options, passed through (they win over the ones here)'
  )
  .requiredOption('-m, --model <model>', 'The model, as the endpoint names it')
  .option('--client <client>', 'The MST client (mst clients lists them)', 'api')
  .option(
    '--api <api>',
    "The client's API family, anthropic or openai (default: openai for codex-cli, else anthropic)"
  )
  .option(
    '--base-url <url>',
    "The endpoint verifiers forwards model calls to (default: the API family's provider)"
  )
  .option(
    '--api-key-var <name>',
    "The variable holding the endpoint's key (default: ANTHROPIC_API_KEY or OPENAI_API_KEY)"
  )
  .option(
    '--client-option <key=value>',
    'A client option; repeat for more (a JSON value is parsed: timeout=300000)',
    (value: string, previous: string[]) => [...previous, value],
    [] as string[]
  )
  .option('--plugins <modules...>', 'MST plugins, for a plugin client')
  .option(
    '--workdir <dirs...>',
    'Subdirectories of a working directory the client runs in; its files come back with each rollout'
  )
  .option(
    '-n, --num-tasks <n>',
    "How many of the taskset's tasks (default: all)"
  )
  .option('-r, --rollouts <n>', 'Rollouts per task')
  .option('-c, --concurrency <n>', 'Rollouts at once')
  .option(
    '-o, --output-dir <dir>',
    'Where verifiers writes the run (default: outputs/ here)'
  )
  .option('--python <version>', 'The Python uv runs verifiers with', '3.12')
  .action(
    (taskset: string, verifiersArgs: string[], options: VerifiersRunOptions) =>
      verifiersRun(taskset, { ...options, verifiersArgs })
  );

// Collect command: a shard's worker, started by runners (ADR 0004)
program
  .command('collect', { hidden: true })
  .description("Collect a shard's trials (runners run this)")
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
  .option('--option-key <file>', "The run's option key file")
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

// History command: an eval's runs over time
program
  .command('history')
  .description(
    "An eval's runs over time, per variant, newest first: pass rates, judges, cost, tokens and time, with each run's change since the previous comparable run"
  )
  .argument(
    '[eval directory]',
    "An eval's directory (.mcp-test-results/<eval name>), instead of --config"
  )
  .option('-c, --config <path>', 'The eval config whose runs to show')
  .option(
    '--results <store>',
    "Read the runs in this result store, instead of the eval config's"
  )
  .option(
    '--output-dir <dir>',
    "The eval's directory, if mst run was given one"
  )
  .option('--root-dir <dir>', 'Fallback directory for relative paths', '.')
  .option('--variant <names...>', 'Only these variants')
  .option('--since <date>', 'Only runs collected on or after this date')
  .option('--limit <n>', 'Most runs per variant', '20')
  .option('--json', 'Print the history as JSON (mst.history/v1)')
  .option(
    '--rebuild',
    'Build every row again from the runs, and write history.json'
  )
  .action((directory: string | undefined, options: HistoryOptions) =>
    history(directory, options)
  );

// Grade shard command: a grade shard's worker, started by runners (ADR 0005)
program
  .command('grade-shard', { hidden: true })
  .description("Grade a shard of a stored run's cases (runners run this)")
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
