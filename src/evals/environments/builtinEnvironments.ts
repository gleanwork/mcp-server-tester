import { z } from 'zod';
import { builtinShortName, extensionLookup } from '../../plugins/extensions.js';
import { parseExtensionOptions } from '../../plugins/plugin.js';
import type {
  EnvironmentDefinition,
  EnvironmentKeep,
} from '../evalFrameworkTypes.js';

/** The built-in environment: trials are collected in the `mst run` process. */
export const LOCAL_ENVIRONMENT = 'local';

const KEEP: readonly EnvironmentKeep[] = ['never', 'failed', 'always'];

/** `local` has no machines, and no options of its own. */
function builtinEnvironments(): Readonly<
  Record<string, EnvironmentDefinition>
> {
  return {
    [LOCAL_ENVIRONMENT]: {
      schema: z.object({}).strict(),
      description: 'Collect trials in the mst run process, on this machine.',
      maxShards: 1,
      async open() {
        return { async close() {} };
      },
    },
  };
}

const environments = extensionLookup('environments', builtinEnvironments);

/** Where a run collects its trials, as run.json records it. */
export interface RunEnvironment {
  /** `local`, or `<namespace>/env/<name>`. */
  name: string;
  shards: number;
  keep: EnvironmentKeep;
  /** The environment's own options, as its schema parsed them. */
  options: Record<string, unknown>;
}

/** An environment as a run uses it: `--env` and `--env-option`, checked. */
export interface ResolvedEnvironment extends RunEnvironment {
  definition: EnvironmentDefinition;
}

/**
 * The environment `reference` names (`--env`), with `rawOptions`
 * (`--env-option key=value`) checked. MST owns `shards` and `keep`; the
 * environment's schema checks the rest.
 */
export function resolveEnvironment(
  reference: string,
  rawOptions: Readonly<Record<string, string>>
): ResolvedEnvironment {
  const name = builtinShortName(reference, 'env');
  const definition = environments.get(name);
  const { shards: rawShards, keep: rawKeep, ...own } = rawOptions;
  const shards = rawShards === undefined ? 1 : Number(rawShards);
  if (rawShards !== undefined && !(/^\d+$/.test(rawShards) && shards > 0))
    throw new Error(
      `--env-option shards must be a positive integer, got "${rawShards}"`
    );
  if (name === LOCAL_ENVIRONMENT && shards > 1)
    throw new Error(
      `The local environment runs one shard: drop --env-option shards=${shards}, or use an environment that creates machines.`
    );
  if (definition.maxShards !== undefined && shards > definition.maxShards)
    throw new Error(
      `${name} runs at most ${definition.maxShards} shards: --env-option shards=${shards} is more.`
    );
  if (rawKeep !== undefined && !KEEP.includes(rawKeep as EnvironmentKeep))
    throw new Error(
      `--env-option keep must be never, failed or always, got "${rawKeep}"`
    );
  return {
    name,
    definition,
    shards,
    keep: (rawKeep as EnvironmentKeep | undefined) ?? 'never',
    options: parseExtensionOptions(
      definition.schema,
      own,
      `--env-option for ${name}`
    ),
  };
}
