/**
 * `--detach` on the machine it's typed on (ADR 0007): check the run can
 * outlive this machine, create the coordinator machine through the
 * environment, copy the plan and eval config there, hand the coordinator the
 * secrets over its channel, and return once it has started.
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  getCredentialStore,
  isCredentialStoreReference,
} from '../../auth/grants/stores.js';
import { resolveConfigExtends } from '../configExtends.js';
import { connectorUses } from '../connectorServers.js';
import { loadEvalConfig } from '../evalConfig.js';
import { loadEvalPlugins } from '../evalPlugins.js';
import { parseResultsFlag } from '../builtinResultStores.js';
import {
  resolveEnvironment,
  LOCAL_ENVIRONMENT,
} from '../environments/builtinEnvironments.js';
import {
  evalResultStore,
  loadEvalDatasets,
  loadSecretsFile,
} from '../runEval.js';
import { DATASETS_FILE, PLAN_FILE } from './coordinate.js';
import { newDetachId, writeStatus, type DetachPlan } from './status.js';
import { parseEnvOptions } from '../environments/envOptions.js';
import { settingsFor } from '../../plugins/settings.js';

export interface DetachOptions {
  command: 'run' | 'grade';
  configPath: string;
  rootDir?: string;
  /** `mst grade`'s run, or the run `--resume` completes. */
  run?: string;
  /** `mst run --resume <run> --detach`. */
  resume?: boolean;
  env?: string;
  envOptions: readonly string[];
  results?: string;
  store?: string;
  secretsFile?: string;
  /** `mst run`'s selection and report flags, passed through. */
  runArgs: readonly string[];
  noGrade: boolean;
  gradeEnv: boolean;
  /** `--plugins`: local modules, which a coordinator machine doesn't have. */
  plugins?: readonly string[];
  log?: (line: string) => void;
}

export interface DetachResult {
  id: string;
  machine: string;
  evalName: string;
  storeLocation: string;
}

/** Why this run can't be detached, or undefined. Needs the eval's plugins loaded. */
async function refusal(
  options: DetachOptions,
  rootDir: string
): Promise<string | undefined> {
  if (options.plugins?.length)
    return "--detach can't take --plugins: the coordinator machine loads the eval config's plugins as its environment installed them.";
  if (!options.env || options.env === LOCAL_ENVIRONMENT)
    return "--detach needs --env: an environment whose machines run the shards, and that creates the coordinator's machine.";
  if (options.results?.startsWith('file:'))
    return `--detach needs a result store other machines reach, not ${options.results}.`;
  const loaded = loadEvalConfig(options.configPath, { rootDir });
  const namespaces = await loadEvalPlugins({
    configPath: options.configPath,
    evalConfig: loaded,
    rootDir,
  });
  const config = resolveConfigExtends(loaded, namespaces);
  if (!options.results) {
    const store = config.results?.store;
    if (!store)
      return '--detach needs a result store: give --results gs://<bucket>/<prefix> or set results.store in the eval config.';
    if (store.type === 'file')
      return "--detach needs a result store other machines reach, not the eval config's file store: give --results.";
  } else parseResultsFlag(options.results);
  if (options.command === 'run' && connectorUses(config).length > 0) {
    if (!options.store || !isCredentialStoreReference(options.store))
      return "--detach needs a credential store the coordinator machine reaches, for the eval's connector servers: give --store <namespace>/credential-store/<name> (sign in to it with mst auth --store).";
    if (!getCredentialStore(options.store).shared)
      return `--detach needs a shared credential store, and ${options.store} isn't one.`;
  }
  return undefined;
}

/** Starts a detached run and returns once its coordinator is running. */
export async function detach(options: DetachOptions): Promise<DetachResult> {
  const log = options.log ?? ((line: string) => console.error(line));
  const rootDir = path.resolve(options.rootDir ?? '.');
  const reason = await refusal(options, rootDir);
  if (reason) throw new Error(reason);
  // Its plugins are loaded (`refusal`); the settings go with the eval config.
  const { settings } = loadEvalConfig(options.configPath, { rootDir });
  const { evalName, store } = await evalResultStore({
    configPath: options.configPath,
    rootDir,
    ...(options.results ? { results: options.results } : {}),
  });
  if (!store) throw new Error('--detach needs a result store.');
  const env = options.env!;
  const resolved = resolveEnvironment(env, parseEnvOptions(options.envOptions));
  if (!resolved.definition.coordinator)
    throw new Error(
      `${resolved.name} can't run a detached run's coordinator: it has no coordinator machine (ADR 0007).`
    );
  const secrets = options.secretsFile
    ? await loadSecretsFile(path.resolve(rootDir, options.secretsFile))
    : undefined;

  // Loaded here, with this machine's dataset credentials, and shipped.
  const datasets = await loadEvalDatasets({
    configPath: options.configPath,
    rootDir,
  });

  const id = newDetachId();
  const createdAt = new Date().toISOString();
  log(`[mst] Creating the coordinator machine for detached run ${id}…`);
  const machine = await resolved.definition.coordinator(resolved.options, {
    id,
    log,
    settings: settingsFor(settings, resolved.name),
  });
  const plan: DetachPlan = {
    format: 1,
    id,
    evalName,
    command: options.command,
    config: path.basename(options.configPath),
    ...(options.run ? { run: options.run } : {}),
    ...(options.resume ? { resume: true } : {}),
    env,
    envOptions: [...options.envOptions],
    ...(options.results ? { results: options.results } : {}),
    ...(options.store ? { store: options.store } : {}),
    runArgs: [...options.runArgs],
    noGrade: options.noGrade || options.gradeEnv,
    gradeEnv: options.gradeEnv,
    resumes: 1,
    secrets: secrets !== undefined,
    ...(machine.finish ? { finish: [...machine.finish] } : {}),
    createdAt,
  };
  const bundle = await fs.mkdtemp(path.join(os.tmpdir(), 'mst-detach-'));
  try {
    await fs.writeFile(
      path.join(bundle, PLAN_FILE),
      `${JSON.stringify(plan, null, 2)}\n`
    );
    // The eval config as written, with the settings it was loaded with: the
    // coordinator machine has no mst.config.json (ADR 0008).
    const written = JSON.parse(
      await fs.readFile(path.resolve(rootDir, options.configPath), 'utf8')
    ) as Record<string, unknown>;
    await fs.writeFile(
      path.join(bundle, plan.config),
      `${JSON.stringify(settings ? { ...written, settings } : written, null, 2)}
`
    );
    await fs.writeFile(
      path.join(bundle, DATASETS_FILE),
      JSON.stringify(datasets)
    );
    // Before the coordinator starts, so its own status replaces this one.
    await writeStatus(store, {
      format: 1,
      id,
      evalName,
      command: options.command,
      state: 'starting',
      machine: machine.id,
      env,
      createdAt,
      updatedAt: new Date().toISOString(),
      collected: 0,
      graded: 0,
      lines: [],
    });
    const remote = `${machine.workDir ?? '/mst'}/detached/${id}`;
    await machine.channel.put(bundle, remote);
    const abort = new AbortController();
    const started = machine.channel.exec(
      [...(machine.mst ?? ['mst']), 'coordinate', '--bundle', remote],
      {
        stdin: (async function* () {
          yield `${JSON.stringify(secrets ? { secrets } : {})}\n`;
        })(),
        signal: abort.signal,
      }
    );
    // Both streams at once, so neither fills while the other is read.
    let output = '';
    let errors = '';
    await Promise.all([
      (async () => {
        for await (const chunk of started.stdout) output += String(chunk);
      })(),
      (async () => {
        for await (const chunk of started.stderr) errors += String(chunk);
      })(),
    ]);
    const ok = output.includes('"type":"started"');
    const code = await started.exit;
    if (!ok)
      throw new Error(
        `The coordinator didn't start on ${machine.id} (exit ${code}): ${errors.trim().split('\n').slice(-3).join(' ') || output.trim()}`
      );
  } catch (error) {
    await machine.dispose({ keep: false }).catch(() => {});
    throw error;
  } finally {
    await fs.rm(bundle, { recursive: true, force: true });
  }
  return { id, machine: machine.id, evalName, storeLocation: store.location };
}
