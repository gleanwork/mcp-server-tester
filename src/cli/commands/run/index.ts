import fs from 'node:fs';
import path from 'node:path';
import {
  loadEvalConfig,
  resolveEvalModeConfig,
  resolveEvalsetPaths,
} from '../../../evals/evalConfigSchema.js';
import { loadPlugins } from '../../../plugins/loadPlugins.js';

export interface RunOptions {
  config: string;
  plugins?: string[];
  rootDir?: string;
  dryRun?: boolean;
}

export async function run(options: RunOptions): Promise<void> {
  const rootDir = options.rootDir ?? process.cwd();
  const config = loadEvalConfig(options.config, {
    rootDir,
    skipEvalsetValidation: options.dryRun,
  });
  const modeConfig = resolveEvalModeConfig(config.mode);

  const pluginPaths =
    options.plugins ??
    config.plugins?.map((plugin) =>
      path.isAbsolute(plugin.dir)
        ? plugin.dir
        : path.resolve(rootDir, plugin.dir)
    ) ??
    [];

  if (pluginPaths.length > 0) {
    await loadPlugins(pluginPaths);
  }

  const evalsetPaths = resolveEvalsetPaths(config, rootDir);
  const output = {
    name: config.name,
    mode: config.mode,
    filterTags: modeConfig.filterTags,
    requiresJudges: modeConfig.requiresJudges,
    isServerComparison: modeConfig.isServerComparison,
    judges: config.judges ?? [],
    evalsetPaths,
    concurrency: config.concurrency ?? 1,
    maxCases: config.maxCases,
    mcpUrl: config.mcpUrl,
    clientHost: config.clientHost,
    pluginsLoaded: pluginPaths,
  };

  if (options.dryRun) {
    process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
    return;
  }

  // Phase 1: validate config + plugins. Full runEvalSuite wiring lands in a follow-up.
  const resultsDir = path.join(rootDir, '.mcp-test-results', config.name);
  fs.mkdirSync(resultsDir, { recursive: true });
  fs.writeFileSync(
    path.join(resultsDir, 'run-plan.json'),
    `${JSON.stringify(output, null, 2)}\n`
  );

  console.log(`Eval config validated: ${config.name}`);
  console.log(
    `Mode: ${config.mode} → filterTags=${output.filterTags.join(',') || '(none)'}`
  );
  console.log(`Evalsets: ${evalsetPaths.length}`);
  console.log(`Plugins loaded: ${pluginPaths.length}`);
  console.log(`Run plan written to ${path.join(resultsDir, 'run-plan.json')}`);
  console.log(
    'Note: full evaluation execution (runEvalSuite) is not wired yet — config + plugin loading only.'
  );
}
