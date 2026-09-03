import fs from 'node:fs';
import path from 'node:path';
import {
  loadEvalConfig,
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
    evalsetPaths,
    pluginsLoaded: pluginPaths,
  };

  if (options.dryRun) {
    process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
    return;
  }

  const resultsDir = path.join(rootDir, '.mcp-test-results', config.name);
  fs.mkdirSync(resultsDir, { recursive: true });
  const planPath = path.join(resultsDir, 'run-plan.json');
  fs.writeFileSync(planPath, `${JSON.stringify(output, null, 2)}\n`);

  console.log(`Eval config validated: ${config.name}`);
  console.log(`Mode: ${config.mode}`);
  console.log(`Evalsets: ${evalsetPaths.length}`);
  console.log(`Plugins loaded: ${pluginPaths.length}`);
  console.log(`Run plan written to ${planPath}`);
  console.log(
    'Note: evaluation execution is not wired yet; this scaffold only validates and plans the run.'
  );
}
