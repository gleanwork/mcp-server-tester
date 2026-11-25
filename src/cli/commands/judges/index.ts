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
import { extensionOptionsSchema, optionsSection } from '../extensionOptions.js';
import { indented, outputWidth } from '../../utils/textLayout.js';

type JudgeKind = 'judge' | 'pairwise';

/** How text output is laid out; a test sets the width. */
interface TextOptions {
  width?: number;
}

const KIND_TEXT: Record<JudgeKind, string> = {
  judge: 'judge: scores each trial',
  pairwise: 'pairwise judge: compares each variant with the baseline',
};

const GROUP_HEADINGS: Record<JudgeKind, string> = {
  judge: 'Judges (score each trial)',
  pairwise: 'Pairwise judges (compare each variant with the baseline)',
};

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

/**
 * `mst judges`: judges, then pairwise judges, each sorted by reference, in a
 * table under its heading.
 */
export async function listJudgeCommand(
  options: DiscoveryOptions & TextOptions,
  print: (text: string) => void = (text) => process.stdout.write(text)
): Promise<void> {
  const entries = await judgeEntries(options);
  if (options.json) {
    print(`${JSON.stringify(entries.map(listed), null, 2)}\n`);
    return;
  }
  const width = options.width ?? outputWidth();
  const groups = (['judge', 'pairwise'] as const).flatMap((kind) => {
    const group = entries.filter((entry) => entry.kind === kind);
    if (!group.length) return [];
    const table = formatTable(
      [
        // A column no judge in the group fills is left out, heading too.
        [
          'Judge',
          group.some(shownVersion) ? 'Version' : '',
          group.some((entry) => entry.requires.length) ? 'Requires' : '',
          group.some((entry) => entry.description) ? 'Description' : '',
        ],
        ...group.map((entry) => [
          entry.ref,
          shownVersion(entry),
          entry.requires.join(', '),
          entry.description ?? '',
        ]),
      ],
      width - 2
    );
    return [
      [
        GROUP_HEADINGS[kind],
        ...table.split('\n').map((line) => `  ${line}`),
      ].join('\n'),
    ];
  });
  print(
    `${groups.join('\n\n')}\n\nWhat a judge requires, and its options: mst judges show <judge>\n`
  );
}

/** `mst judges show <ref>`: what a judge needs and the options it takes. */
export async function showJudge(
  ref: string,
  options: DiscoveryOptions & TextOptions,
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
  const width = options.width ?? outputWidth();
  const blocks = matches.map((entry) =>
    [
      entry.ref,
      ...(entry.description !== undefined
        ? indented(entry.description, width, '')
        : []),
      '',
      formatTable(
        [
          ['Kind', KIND_TEXT[entry.kind]],
          ['Version', shownVersion(entry) || 'none'],
          ['Requires', entry.requires.join(', ') || 'nothing'],
          ...(entry.swapPositions !== undefined
            ? [
                [
                  'Swaps',
                  entry.swapPositions
                    ? 'yes: asks in each order and reconciles the answers'
                    : 'no',
                ],
              ]
            : []),
        ],
        width
      ),
      ...optionsSection(
        // An option with no declared default shows `not declared`, as a
        // client's does: leaving it out may mean the judge's own default,
        // or no limit, and the schema doesn't say which.
        extensionOptionsSchema(entry.schema, 'judge'),
        'judge',
        width
      ),
    ].join('\n')
  );
  print(`${blocks.join('\n\n')}\n`);
}
