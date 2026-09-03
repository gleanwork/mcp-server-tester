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
import { runDryRunProxy } from '../mcp/dryRunProxy.js';
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

// Batch command
program
  .command('batch')
  .description('Run multiple eval campaign configs with bounded concurrency')
  .option('--configs <paths...>', 'Config files to run')
  .option('--config-dir <dir>', 'Directory containing config JSON files')
  .option(
    '--root-dir <dir>',
    'Base directory for resolving relative paths',
    '.'
  )
  .option('--output-root <dir>', 'Root directory for per-config results')
  .option(
    '--parallel <count>',
    'Maximum configs to run concurrently',
    Number,
    1
  )
  .option('--mode <mode>', 'Override campaign mode')
  .option('--client-host <name>', 'Override client host')
  .option('--mcp-url <url>', 'Override MCP server URL')
  .option('--tools <names>', 'Comma-separated tool filter')
  .option('--max-cases <count>', 'Limit cases per evalset', Number)
  .option('--concurrency <count>', 'Maximum concurrent cases', Number)
  .option('--iterations <count>', 'Default LLM iterations', Number)
  .option('--max-tool-calls <count>', 'Maximum tool calls per host run', Number)
  .option('--judges <names...>', 'Override enabled custom judges')
  .option('--metrics <names...>', 'Override metrics')
  .option('--plugins <paths...>', 'Plugin directories to load before each run')
  .action(batch);

// Native-server dry-run proxy. This is normally launched by an MCP host,
// not by a user directly.
program
  .command('proxy')
  .description('Run a write-intercepting stdio proxy for a native MCP server')
  .requiredOption('--upstream-url <url>', 'Upstream streamable HTTP MCP URL')
  .requiredOption('--name <name>', 'Server name used in planned-write results')
  .option(
    '--token-env <name>',
    'Environment variable containing the bearer token',
    'MCP_PROXY_TOKEN'
  )
  .option('--header <headers...>', 'Extra upstream headers as NAME:VALUE')
  .option(
    '--always-write <tools...>',
    'Tools to intercept regardless of annotations'
  )
  .option(
    '--read-only <tools...>',
    'Tools to allow when annotations are missing'
  )
  .option('--planned-write-key <key>', 'Envelope key for intercepted writes')
  .action(
    async (options: {
      upstreamUrl: string;
      name: string;
      tokenEnv: string;
      header?: string[];
      alwaysWrite?: string[];
      readOnly?: string[];
      plannedWriteKey?: string;
    }) => {
      const headers: Record<string, string> = {};
      for (const raw of options.header ?? []) {
        const separator = raw.indexOf(':');
        if (separator <= 0)
          throw new Error(`Invalid --header ${raw}; expected NAME:VALUE`);
        headers[raw.slice(0, separator).trim()] = raw
          .slice(separator + 1)
          .trim();
      }
      await runDryRunProxy({
        name: options.name,
        upstreamUrl: options.upstreamUrl,
        token: process.env[options.tokenEnv] ?? '',
        headers,
        alwaysWriteTools: options.alwaysWrite,
        readOnlyTools: options.readOnly,
        plannedWriteKey: options.plannedWriteKey,
      });
    }
  );

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
  .option('--mode <mode>', 'Override campaign mode')
  .option('--client-host <name>', 'Override client host')
  .option('--mcp-url <url>', 'Override MCP server URL')
  .option('--server-b <url>', 'MCP server B URL for SxS mode')
  .option('--tools <names>', 'Comma-separated tool filter')
  .option('--version <version>', 'Evalset version or source identifier')
  .option('--max-cases <count>', 'Limit cases per evalset', Number)
  .option('--concurrency <count>', 'Maximum concurrent cases', Number)
  .option('--iterations <count>', 'Default LLM iterations', Number)
  .option('--max-tool-calls <count>', 'Maximum tool calls per host run', Number)
  .option('--judges <names...>', 'Override enabled custom judges')
  .option('--metrics <names...>', 'Override metrics')
  .option('--dry-run', 'Validate config and plugins without executing evals')
  .action(run);

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
