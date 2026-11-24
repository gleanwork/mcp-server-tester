/**
 * `mst clients`: the clients built in and in plugins, what each one is, what
 * a machine needs to run it, and the options it takes.
 *
 *   mst clients [--plugins <module...> | --config <file>] [--json]
 *   mst clients show <ref> [--json]
 */
import { getClient, listClients } from '../../../evals/builtinClients.js';
import { resolveClientName } from '../../../evals/clientNames.js';
import { builtinShortName } from '../../../plugins/extensions.js';
import { parseExtensionReference } from '../../../plugins/plugin.js';
import type {
  ClientOS,
  ClientRequirements,
} from '../../../evals/evalFrameworkTypes.js';
import {
  formatTable,
  inNamespaces,
  loadDiscoveryPlugins,
  type DiscoveryOptions,
} from '../discoveryPlugins.js';
import {
  extensionOptionsSchema,
  optionsSection,
  type ExtensionOptionsSchema,
} from '../extensionOptions.js';
import { indented, listSection, outputWidth } from '../../utils/textLayout.js';

interface ListedClient {
  ref: string;
  description?: string;
  requirements: ClientRequirements;
  options: ExtensionOptionsSchema;
}

/** How text output is laid out; a test sets the width. */
interface TextOptions {
  width?: number;
}

const OS_NAMES: Record<ClientOS, string> = { macos: 'macOS', linux: 'Linux' };

/** Where a client runs, for people: `macOS, Linux`, or `any OS`. */
export function clientOS(requirements: ClientRequirements): string {
  return requirements.os?.length
    ? requirements.os.map((os) => OS_NAMES[os]).join(', ')
    : 'any OS';
}

/** Every client visible with `options`: built-ins and the loaded plugins'. */
async function clientEntries(
  options: DiscoveryOptions
): Promise<ListedClient[]> {
  // Built-in clients need no plugin.
  const { namespaces } =
    options.plugins?.length || options.config
      ? await loadDiscoveryPlugins(options)
      : { namespaces: [] as string[] };
  return listClients()
    .filter(([ref]) => inNamespaces(ref, namespaces))
    .map(([ref, definition]) => ({
      ref,
      ...(definition.description !== undefined
        ? { description: definition.description }
        : {}),
      requirements: definition.requirements ?? {},
      options: extensionOptionsSchema(definition.schema, 'client'),
    }));
}

/**
 * `mst clients`: a row for each client, with where it runs and what it is.
 * `--json` has each one's requirements and options too.
 */
export async function listClientCommand(
  options: DiscoveryOptions & TextOptions,
  print: (text: string) => void = (text) => process.stdout.write(text)
): Promise<void> {
  const entries = await clientEntries(options);
  if (options.json) {
    print(`${JSON.stringify(entries, null, 2)}\n`);
    return;
  }
  const table = formatTable(
    [
      ['Client', 'Runs on', 'Description'],
      ...entries.map((entry) => [
        entry.ref,
        clientOS(entry.requirements),
        entry.description ?? '',
      ]),
    ],
    options.width ?? outputWidth()
  );
  print(
    `${table}\n\nWhat a client needs, and its options: mst clients show <client>\n`
  );
}

/**
 * A client for people: what it is, where it runs, what a machine needs to
 * run it, and its options with their defaults.
 */
function clientText(entry: ListedClient, width: number): string {
  const { requirements } = entry;
  return [
    entry.ref,
    ...(entry.description !== undefined
      ? indented(entry.description, width, '')
      : []),
    '',
    `Runs on  ${clientOS(requirements)}`,
    ...listSection('Install', requirements.install, width),
    ...listSection('Credentials', requirements.credentials, width),
    ...listSection('Setup', requirements.setup, width),
    ...optionsSection(entry.options, 'client', width),
  ].join('\n');
}

/** `mst clients show <ref>`: what a client needs and the options it takes. */
export async function showClient(
  ref: string,
  options: DiscoveryOptions & TextOptions,
  print: (text: string) => void = (text) => process.stdout.write(text)
): Promise<void> {
  // A renamed client fails naming its replacement, and `mst/client/<name>`
  // is the built-in `<name>`, as in an eval config.
  const wanted = builtinShortName(resolveClientName(ref), 'client');
  const entries = await clientEntries(options);
  const entry = entries.find((candidate) => candidate.ref === wanted);
  if (!entry) {
    // The lookup an eval config uses says what is wrong: an unknown name,
    // a plugin that isn't loaded, or another kind of extension.
    let problem = `No client "${ref}".`;
    try {
      getClient(wanted);
    } catch (error) {
      if (error instanceof Error) problem = error.message;
    }
    // Only a plugin's client is fixed by loading plugins, not a reference
    // of another kind.
    const { namespace, kind } = parseExtensionReference(wanted);
    throw new Error(
      `${problem}${
        namespace !== undefined &&
        kind === 'client' &&
        !options.plugins?.length &&
        !options.config
          ? ' Plugin clients need --plugins or --config.'
          : ''
      }`
    );
  }
  print(
    `${
      options.json
        ? JSON.stringify(entry, null, 2)
        : clientText(entry, options.width ?? outputWidth())
    }\n`
  );
}
