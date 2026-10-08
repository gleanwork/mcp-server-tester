/**
 * `mst judges`: the judges built in and in plugins, and what each takes.
 *
 *   mst judges [--plugins <module...> | --config <file>] [--json]
 *   mst judges show <ref> [--json]
 */
import { z, type ZodType } from 'zod';
import { listJudges } from '../../../judge/builtinJudges.js';
import { listPairwiseJudges } from '../../../evals/pairwiseComparison.js';
import {
  formatTable,
  inNamespaces,
  loadDiscoveryPlugins,
  type DiscoveryOptions,
} from '../discoveryPlugins.js';

type JudgeKind = 'judge' | 'pairwise';

interface ListedJudge {
  ref: string;
  /** `judge` scores each trial; `pairwise` compares a candidate with the baseline. */
  kind: JudgeKind;
  description?: string;
  requires: string[];
}

interface JudgeEntry extends ListedJudge {
  schema: ZodType;
  swapPositions?: boolean;
}

/** Every judge visible with `options`: built-ins and the loaded plugins'. */
async function judgeEntries(options: DiscoveryOptions): Promise<JudgeEntry[]> {
  // Built-in judges need no plugin.
  const { namespaces } =
    options.plugins?.length || options.config
      ? await loadDiscoveryPlugins(options)
      : { namespaces: [] as string[] };
  const entries: JudgeEntry[] = [
    ...listJudges().map(([ref, definition]) => ({
      ref,
      kind: 'judge' as const,
      ...(definition.description !== undefined
        ? { description: definition.description }
        : {}),
      requires: [...(definition.requires ?? [])],
      schema: definition.schema,
    })),
    ...listPairwiseJudges().map(([ref, definition]) => ({
      ref,
      kind: 'pairwise' as const,
      ...(definition.description !== undefined
        ? { description: definition.description }
        : {}),
      requires: [...(definition.requires ?? [])],
      schema: definition.schema,
      swapPositions: definition.swapPositions ?? true,
    })),
  ];
  return entries.filter((entry) => inNamespaces(entry.ref, namespaces));
}

const listed = ({
  ref,
  kind,
  description,
  requires,
}: JudgeEntry): ListedJudge => ({
  ref,
  kind,
  ...(description !== undefined ? { description } : {}),
  requires,
});

/** `mst judges`: judges, then pairwise judges, each sorted by reference. */
export async function listJudgeCommand(
  options: DiscoveryOptions,
  print: (text: string) => void = (text) => process.stdout.write(text)
): Promise<void> {
  const entries = await judgeEntries(options);
  if (options.json) {
    print(`${JSON.stringify(entries.map(listed), null, 2)}\n`);
    return;
  }
  const rows = entries.map((entry) => [
    entry.ref,
    entry.kind,
    entry.requires.length ? `requires ${entry.requires.join(', ')}` : '',
    entry.description ?? '',
  ]);
  print(`${formatTable(rows)}\n`);
}

/**
 * The options a judge takes, as JSON Schema (what an eval config's entry
 * may set besides `type`). A schema JSON Schema can't express says why.
 */
function optionsSchema(schema: ZodType): unknown {
  try {
    return z.toJSONSchema(schema, { io: 'input', unrepresentable: 'any' });
  } catch (error) {
    return {
      unavailable: `This judge's options schema can't be shown as JSON Schema (${error instanceof Error ? error.message : String(error)}).`,
    };
  }
}

/** `mst judges show <ref>`: what a judge needs and the options it takes. */
export async function showJudge(
  ref: string,
  options: DiscoveryOptions,
  print: (text: string) => void = (text) => process.stdout.write(text)
): Promise<void> {
  const entries = await judgeEntries(options);
  const matches = entries.filter((entry) => entry.ref === ref);
  if (matches.length === 0) {
    const known = entries.map((entry) => entry.ref).join(', ');
    throw new Error(
      `No judge "${ref}".${known ? ` Judges: ${known}.` : ''}${
        ref.includes('/') && !options.plugins?.length && !options.config
          ? ' Plugin judges need --plugins or --config.'
          : ''
      }`
    );
  }
  const shown = matches.map((entry) => ({
    ...listed(entry),
    ...(entry.swapPositions !== undefined
      ? { swapPositions: entry.swapPositions }
      : {}),
    options: optionsSchema(entry.schema),
  }));
  if (options.json) {
    print(
      `${JSON.stringify(shown.length === 1 ? shown[0] : shown, null, 2)}\n`
    );
    return;
  }
  const blocks = shown.map((entry) =>
    [
      `${entry.ref}  (${entry.kind === 'judge' ? 'judge: scores each trial' : 'pairwise judge: compares each variant with the baseline'})`,
      ...(entry.description !== undefined ? [`  ${entry.description}`] : []),
      `  requires  ${entry.requires.length ? entry.requires.join(', ') : '-'}`,
      ...(entry.swapPositions !== undefined
        ? [
            `  swaps     ${entry.swapPositions ? 'yes: each order, reconciled' : 'no'}`,
          ]
        : []),
      '  options',
      ...JSON.stringify(entry.options, null, 2)
        .split('\n')
        .map((line) => `    ${line}`),
    ].join('\n')
  );
  print(`${blocks.join('\n\n')}\n`);
}
