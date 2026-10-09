/**
 * `mst datasets`: the datasets plugins provide.
 *
 *   mst datasets [--plugins <module...> | --config <file>] [--json]
 *   mst datasets show <ref> [--snapshot <id> | --source live] [--json]
 *   mst datasets pull <ref> [--snapshot <id> | --source live] [--out <file>]
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  getDatasetSource,
  listDatasetSources,
  loadDataset,
  takesNoOptions,
} from '../../../evals/builtinDatasetSources.js';
import type { DatasetConfig, EvalConfig } from '../../../evals/evalConfig.js';
import type { EvalDataset } from '../../../evals/datasetTypes.js';
import type { DatasetSummary } from '../../../evals/evalFrameworkTypes.js';
import { datasetContentHash } from '../../../evals/runFormat.js';
import { checkReferenceKind } from '../../../plugins/extensions.js';
import { parseExtensionReference } from '../../../plugins/plugin.js';
import {
  formatTable,
  inNamespaces,
  loadDiscoveryPlugins,
  type DiscoveryOptions,
} from '../discoveryPlugins.js';

export interface DatasetSelectOptions extends DiscoveryOptions {
  snapshot?: string;
  source?: string;
}

export interface DatasetPullOptions extends DatasetSelectOptions {
  out?: string;
}

interface Listed {
  ref: string;
  description?: string;
  snapshots?: true;
  /** A source that needs options isn't a dataset by itself; the config gives them. */
  needsOptions?: true;
  cases?: number;
  snapshot?: string;
  tags?: string[];
  /** describe() failed: why. */
  error?: string;
}

// The dataset alone: no selection, so every case is read.
const ALL_CASES = {
  name: 'mst-datasets',
  datasets: [],
} as unknown as EvalConfig;

function summaryOf(value: unknown): DatasetSummary {
  if (typeof value !== 'object' || value === null) return {};
  const { cases, snapshot, tags } = value as Record<string, unknown>;
  return {
    ...(typeof cases === 'number' ? { cases } : {}),
    ...(typeof snapshot === 'string' ? { snapshot } : {}),
    ...(Array.isArray(tags)
      ? {
          tags: tags.filter((tag): tag is string => typeof tag === 'string'),
        }
      : {}),
  };
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Plugin dataset sources only: built-ins read files the config names. */
function isPluginReference(ref: string): boolean {
  return parseExtensionReference(ref).namespace !== undefined;
}

/** `mst datasets`: every dataset of the loaded plugins. */
export async function listDatasets(
  options: DiscoveryOptions,
  print: (text: string) => void = (text) => process.stdout.write(text)
): Promise<void> {
  const { namespaces, rootDir, configDir } =
    await loadDiscoveryPlugins(options);
  const entries = listDatasetSources().filter(
    ([ref]) => isPluginReference(ref) && inNamespaces(ref, namespaces)
  );
  const listed: Listed[] = await Promise.all(
    entries.map(async ([ref, source]): Promise<Listed> => {
      const base: Listed = {
        ref,
        ...(source.description !== undefined
          ? { description: source.description }
          : {}),
        ...(source.snapshots ? { snapshots: true as const } : {}),
        ...(takesNoOptions(ref, source) ? {} : { needsOptions: true as const }),
      };
      if (!source.describe) return base;
      try {
        return {
          ...base,
          ...summaryOf(await source.describe({ rootDir, configDir })),
        };
      } catch (error) {
        return { ...base, error: message(error) };
      }
    })
  );
  if (options.json) {
    print(`${JSON.stringify(listed, null, 2)}\n`);
    return;
  }
  if (listed.length === 0) {
    print(`No datasets in ${namespaces.join(', ') || 'the plugins'}.\n`);
    return;
  }
  const rows = listed.map((item) => [
    item.ref,
    item.cases === undefined ? '' : `${item.cases} cases`,
    item.snapshot === undefined ? '' : `snapshot ${item.snapshot}`,
    item.error !== undefined
      ? `(describe failed: ${item.error})`
      : [
          item.needsOptions ? '(takes options; use it in an eval config)' : '',
          item.tags?.length ? `tags: ${item.tags.join(', ')}` : '',
          item.description ?? '',
        ]
          .filter(Boolean)
          .join('  '),
  ]);
  print(`${formatTable(rows)}\n`);
}

/** Load the cases of `ref` as an eval config listing it would. */
async function loadNamed(
  ref: string,
  options: DatasetSelectOptions
): Promise<EvalDataset> {
  checkReferenceKind(ref, 'dataset');
  const { namespaces, rootDir, configDir } =
    await loadDiscoveryPlugins(options);
  if (!isPluginReference(ref) || !inNamespaces(ref, namespaces))
    throw new Error(
      `Dataset "${ref}" isn't in the loaded plugins (${namespaces.join(', ') || 'none'}).`
    );
  const source = getDatasetSource(ref);
  if (!takesNoOptions(ref, source))
    throw new Error(
      `"${ref}" takes options, so it isn't a dataset by itself: declare it in an eval config with its options.`
    );
  const config: DatasetConfig = {
    type: ref,
    ...(options.snapshot !== undefined ? { snapshot: options.snapshot } : {}),
    ...(options.source !== undefined
      ? { source: options.source as DatasetConfig['source'] }
      : {}),
  };
  return loadDataset(config, { rootDir, configDir, evalConfig: ALL_CASES });
}

/** How many cases have each value, most first. */
function countBy(values: string[]): Array<[string, number]> {
  const counts = new Map<string, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return [...counts].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
}

/** `mst datasets show <ref>`: what a dataset holds. */
export async function showDataset(
  ref: string,
  options: DatasetSelectOptions,
  print: (text: string) => void = (text) => process.stdout.write(text)
): Promise<void> {
  const dataset = await loadNamed(ref, options);
  const description = getDatasetSource(ref).description;
  const tags = countBy(
    dataset.cases.flatMap((evalCase) => evalCase.tags ?? [])
  );
  const judges = countBy(
    dataset.cases.flatMap((evalCase) => [
      ...new Set(
        (evalCase.judges ?? []).map((judge) =>
          typeof judge === 'string' ? judge : String(judge.type)
        )
      ),
    ])
  );
  const ids = dataset.cases.map((evalCase) => evalCase.id);
  const shown = {
    ref,
    ...(description !== undefined ? { description } : {}),
    ...(dataset.origin?.snapshot !== undefined
      ? { snapshot: dataset.origin.snapshot }
      : {}),
    ...(dataset.origin?.live ? { live: true } : {}),
    caseCount: ids.length,
    contentHash: datasetContentHash(dataset),
    tags: Object.fromEntries(tags),
    judges: Object.fromEntries(judges),
    caseIds: ids,
  };
  if (options.json) {
    print(`${JSON.stringify(shown, null, 2)}\n`);
    return;
  }
  const counted = (items: Array<[string, number]>) =>
    items.length ? items.map(([name, n]) => `${name} (${n})`).join(', ') : '-';
  const copy = dataset.origin?.live
    ? 'live'
    : dataset.origin?.snapshot !== undefined
      ? `snapshot ${dataset.origin.snapshot}`
      : '-';
  const lines = [
    ref,
    ...(description !== undefined ? [`  ${description}`] : []),
    `  copy      ${copy}`,
    `  cases     ${ids.length}`,
    `  hash      ${shown.contentHash}`,
    `  tags      ${counted(tags)}`,
    `  judges    ${counted(judges)}`,
    `  case ids  ${ids.slice(0, 10).join(', ')}${ids.length > 10 ? `, +${ids.length - 10} more` : ''}`,
  ];
  print(`${lines.join('\n')}\n`);
}

/** `mst datasets pull <ref>`: the cases as a dataset file. */
export async function pullDataset(
  ref: string,
  options: DatasetPullOptions,
  print: (text: string) => void = (text) => process.stdout.write(text),
  report: (text: string) => void = (text) => process.stderr.write(text)
): Promise<void> {
  const dataset = await loadNamed(ref, options);
  // A canonical dataset file: what a file dataset reads back.
  const { origin, snapshot: _snapshot, ...file } = dataset;
  const json = `${JSON.stringify(file, null, 2)}\n`;
  const copy = origin?.live
    ? 'live'
    : origin?.snapshot !== undefined
      ? `snapshot ${origin.snapshot}`
      : 'no snapshot';
  const summary = `${ref}: ${dataset.cases.length} cases (${copy}, hash ${datasetContentHash(dataset)})`;
  if (!options.out) {
    print(json);
    report(`${summary}\n`);
    return;
  }
  const out = path.resolve(options.out);
  await fs.mkdir(path.dirname(out), { recursive: true });
  await fs.writeFile(out, json);
  report(`${summary} -> ${options.out}\n`);
}
