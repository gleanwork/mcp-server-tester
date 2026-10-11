import path from 'node:path';
import { resolveEnvironment } from '../../../evals/environments/builtinEnvironments.js';
import { installPlugins } from '../../../plugins/extensions.js';
import { loadPlugins } from '../../../plugins/loadPlugins.js';
import { parseEnvOptions } from '../run/index.js';

export interface EnvSetupOptions {
  /** `--env-option key=value`, each time it was given. */
  envOption?: string[];
  /** Plugin modules, for a plugin's environment. */
  plugins?: string[];
  rootDir?: string;
}

/** `mst env setup <environment>`: what runs in it need, prepared once. */
export async function setupEnvironment(
  reference: string,
  options: EnvSetupOptions
): Promise<void> {
  if (options.plugins?.length)
    installPlugins(
      await loadPlugins(options.plugins, {
        baseDir: path.resolve(options.rootDir ?? '.'),
      })
    );
  const environment = resolveEnvironment(
    reference,
    parseEnvOptions(options.envOption ?? [])
  );
  if (!environment.definition.setup) {
    console.log(`${environment.name} needs no setup.`);
    return;
  }
  await environment.definition.setup(environment.options, {
    log: (line) => console.error(`[mst] ${line}`),
  });
}
