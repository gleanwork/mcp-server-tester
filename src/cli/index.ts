/**
 * CLI entry point for @gleanwork/mcp-server-tester
 */

import { Command } from 'commander';
import { init } from './commands/init/index.js';
import { generate } from './commands/generate/index.js';
import { login } from './commands/login/index.js';
import { token } from './commands/token/index.js';
import { open } from './commands/open/index.js';
import { run } from './commands/run/index.js';
import { batch } from './commands/batch/index.js';
import packageJson from '../../package.json' with { type: 'json' };

const program = new Command();

program
  .name('mcp-server-tester')
  .description('CLI tools for MCP server evaluation and testing')
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
  .description('Generate eval dataset by interacting with MCP server')
  .option('-c, --config <path>', 'Path to MCP config')
  .option('-o, --output <path>', 'Output dataset path', 'data/dataset.json')
  .option('-s, --snapshot', 'Use Playwright snapshot testing for all cases')
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

// Run command
program
  .command('run')
  .description('Run an evaluation from a JSON config file')
  .requiredOption('-c, --config <path>', 'Path to eval config JSON')
  .option(
    '--plugins <paths...>',
    'Plugin directories to load before the run (registers judges, auth, hosts)'
  )
  .option(
    '--root-dir <dir>',
    'Base directory for resolving relative paths',
    '.'
  )
  .option('--output-dir <dir>', 'Directory for results.json output')
  .option('--dry-run', 'Validate config and plugins without executing evals')
  .action(run);

// Batch command
program
  .command('batch')
  .description('Run multiple evaluation configs')
  .option('--configs <paths...>', 'Evaluation config files')
  .option('--config-dir <dir>', 'Directory containing evaluation configs')
  .option(
    '--root-dir <dir>',
    'Base directory for resolving relative paths',
    '.'
  )
  .option('--output-root <dir>', 'Root directory for evaluation results')
  .option(
    '--parallel <number>',
    'Maximum number of evaluations to run in parallel'
  )
  .option('--dry-run', 'Validate config paths without executing evaluations')
  .action((options) =>
    batch({
      configPaths: options.configs,
      configDir: options.configDir,
      rootDir: options.rootDir,
      outputRoot: options.outputRoot,
      parallel: options.parallel ? Number(options.parallel) : undefined,
      dryRun: options.dryRun,
    })
  );

// Open command
program
  .command('open')
  .description('Open the MCP eval reporter UI in your browser')
  .option(
    '-d, --dir <directory>',
    'Report output directory',
    '.mcp-test-results'
  )
  .action(open);

program.parse();
