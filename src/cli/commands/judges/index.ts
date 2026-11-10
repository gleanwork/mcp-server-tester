/**
 * `mst judges`: the judges built in and in plugins, and what each takes.
 *
 *   mst judges [--plugins <module...> | --config <file>] [--json]
 *   mst judges show <ref> [--json]
 */
import type { ZodType } from 'zod';
import { listJudges } from '../../../judge/builtinJudges.js';
import { listPairwiseJudges } from '../../../evals/pairwiseComparison.js';
import { judgeVersionFields } from '../../../judge/judgeIdentity.js';
import {
  formatTable,
  inNamespaces,
  loadDiscoveryPlugins,
  optionsSchema,
  type DiscoveryOptions,
} from '../discoveryPlugins.js';

type JudgeKind = 'judge' | 'pairwise';

interface ListedJudge {
  ref: string;
  /** `judge` scores each trial; `pairwise` compares a candidate with the baseline. */
  kind: JudgeKind;
  /**
   * The judge's version (ADR 0009): a built-in's, the one a plugin judge
   * declares, or else its plugin's package version.
   */
  version?: string;
  /** The judge has no version MST can see change. */
  unversioned?: true;
  description?: string;
  requires: string[];
}

/** A version for a table: a content hash is cut to 12 characters. */
function shownVersion(entry: ListedJudge): string {
  if (entry.version === undefined)
    return entry.unversioned ? 'unversioned' : '';
  return /^[0-9a-f]{64}$/.test(entry.version)
    ? entry.version.slice(0, 12)
    : entry.version;
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
      ...judgeVersionFields(ref, definition),
      ...(definition.description !== undefined
        ? { description: definition.description }
        : {}),
      requires: [...(definition.requires ?? [])],
      schema: definition.schema,
    })),
    ...listPairwiseJudges().map(([ref, definition]) => ({
      ref,
      kind: 'pairwise' as const,
      ...judgeVersionFields(ref, definition),
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
  version,
  unversioned,
  description,
  requires,
}: JudgeEntry): ListedJudge => ({
  ref,
  kind,
  ...(version !== undefined ? { version } : {}),
  ...(unversioned ? { unversioned } : {}),
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
    shownVersion(entry),
    entry.requires.length ? `requires ${entry.requires.join(', ')}` : '',
    entry.description ?? '',
  ]);
  print(`${formatTable(rows)}\n`);
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
    options: optionsSchema(entry.schema, 'judge'),
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
      `  version   ${shownVersion(entry) || '-'}`,
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
