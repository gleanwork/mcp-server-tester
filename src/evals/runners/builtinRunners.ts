import { z } from 'zod';
import { builtinShortName, extensionLookup } from '../../plugins/extensions.js';
import { parseExtensionOptions } from '../../plugins/plugin.js';
import { dockerRunner } from './docker.js';
import type { RunnerDefinition, RunnerKeep } from '../evalFrameworkTypes.js';

/** The built-in runner: trials are collected in the `mst run` process. */
export const LOCAL_RUNNER = 'local';

const KEEP: readonly RunnerKeep[] = ['never', 'failed', 'always'];

/**
 * `local` has no machines, and no options of its own. `docker` runs shards
 * in containers from MST's Linux Cowork image.
 */
function builtinRunners(): Readonly<Record<string, RunnerDefinition>> {
  return {
    [LOCAL_RUNNER]: {
      schema: z.object({}).strict(),
      description: 'Collect trials in the mst run process, on this machine.',
      maxShards: 1,
      async open() {
        return {
          async runShard() {
            throw new Error(
              'The local runner collects trials in the mst run process, not in shards.'
            );
          },
          async close() {},
        };
      },
    },
    docker: dockerRunner,
  };
}

const runners = extensionLookup('runners', builtinRunners);

/**
 * The OS the trials of the runner `name` run on, when MST knows it: this
 * machine's for `local`, otherwise the definition's declared OS. Undeclared
 * runners stay unknown; no machine is opened and no OS is guessed.
 */
export function runnerOS(reference: string): NodeJS.Platform | undefined {
  const name = builtinShortName(reference, 'runner');
  if (name === LOCAL_RUNNER) return process.platform;
  const os = runners.get(name).os;
  return os === 'macos' ? 'darwin' : os;
}

/** Where a run collects its trials, as run.json records it. */
export interface RecordedRunner {
  /** `local`, or `<namespace>/runner/<name>`. */
  name: string;
  shards: number;
  keep: RunnerKeep;
  /** The runner's own options, as its schema parsed them. */
  options: Record<string, unknown>;
}

/** A runner as a run uses it: `--runner` and `--runner-option`, checked. */
export interface ResolvedRunner extends RecordedRunner {
  definition: RunnerDefinition;
}

/**
 * The runner `reference` names (`--runner`), with `rawOptions`
 * (`--runner-option key=value`) checked. MST owns `shards` and `keep`; the
 * runner's schema checks the rest.
 */
export function resolveRunner(
  reference: string,
  rawOptions: Readonly<Record<string, string>>
): ResolvedRunner {
  const name = builtinShortName(reference, 'runner');
  const definition = runners.get(name);
  const { shards: rawShards, keep: rawKeep, ...own } = rawOptions;
  const shards = rawShards === undefined ? 1 : Number(rawShards);
  if (rawShards !== undefined && !(/^\d+$/.test(rawShards) && shards > 0))
    throw new Error(
      `--runner-option shards must be a positive integer, got "${rawShards}"`
    );
  if (name === LOCAL_RUNNER && shards > 1)
    throw new Error(
      `The local runner runs one shard: drop --runner-option shards=${shards}, or use a runner that creates machines.`
    );
  if (definition.maxShards !== undefined && shards > definition.maxShards)
    throw new Error(
      `${name} runs at most ${definition.maxShards} shards: --runner-option shards=${shards} is more.`
    );
  if (rawKeep !== undefined && !KEEP.includes(rawKeep as RunnerKeep))
    throw new Error(
      `--runner-option keep must be never, failed or always, got "${rawKeep}"`
    );
  return {
    name,
    definition,
    shards,
    keep: (rawKeep as RunnerKeep | undefined) ?? 'never',
    options: parseExtensionOptions(
      definition.schema,
      own,
      `--runner-option for ${name}`
    ),
  };
}
