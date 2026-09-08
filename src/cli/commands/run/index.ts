import { loadEvalManifest } from '../../../evals/evalManifest.js';
import { loadPlugins } from '../../../plugins/loadPlugins.js';

export interface RunOptions {
  manifest: string;
  plugins?: string[];
  rootDir?: string;
  dryRun?: boolean;
  arm?: string;
}

/**
 * Validate and plan a manifest run.
 *
 * Execution is intentionally deferred to the suite-runner branch. Keeping this
 * command functional as a validator gives plugins and editors a stable CLI
 * contract without pretending to run evaluations.
 */
export async function run(options: RunOptions): Promise<void> {
  const manifest = loadEvalManifest(options.manifest, {
    rootDir: options.rootDir,
    skipDatasetValidation: Boolean(options.dryRun),
  });
  if (options.plugins?.length) await loadPlugins(options.plugins);

  const plan = {
    name: manifest.name,
    datasets: manifest.datasets,
    servers: manifest.servers ?? [],
    host: manifest.host,
    arms: manifest.arms?.map((arm) => arm.name) ?? ['default'],
    selectedArm: options.arm,
  };

  if (options.dryRun) {
    process.stdout.write(`${JSON.stringify(plan, null, 2)}\n`);
    return;
  }

  throw new Error(
    'Manifest execution is not wired in the scaffolding branch; use --dry-run.'
  );
}
