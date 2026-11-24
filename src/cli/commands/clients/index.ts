/**
 * `mst clients`: the clients built in and in plugins, what each one is, what
 * a machine needs to run it, and the options it takes.
 *
 *   mst clients [--plugins <module...> | --config <file>] [--json]
 *   mst clients show <ref> [--json]
 *   mst clients setup <ref>
 *   mst clients recover <ref> [--recover-stale-lock]
 */
import { getClient, listClients } from '../../../evals/builtinClients.js';
import { resolveClientName } from '../../../evals/clientNames.js';
import { builtinShortName } from '../../../plugins/extensions.js';
import { parseExtensionReference } from '../../../plugins/plugin.js';
import { settingsFor } from '../../../plugins/settings.js';
import type {
  ClientDefinition,
  ClientOS,
  ClientRequirements,
} from '../../../evals/evalFrameworkTypes.js';
import {
  formatTable,
  inNamespaces,
  loadDiscoveryPlugins,
  type DiscoveryOptions,
} from '../discoveryPlugins.js';
import { clientOptionsSchema, clientOptionRows } from './options.js';

interface ListedClient {
  ref: string;
  description?: string;
  requirements: ClientRequirements;
  options: ReturnType<typeof clientOptionsSchema>;
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
      options: clientOptionsSchema(definition.schema),
    }));
}

/** `mst clients`: each client's requirements, options and defaults. */
export async function listClientCommand(
  options: DiscoveryOptions,
  print: (text: string) => void = (text) => process.stdout.write(text)
): Promise<void> {
  const entries = await clientEntries(options);
  if (options.json) {
    print(`${JSON.stringify(entries, null, 2)}\n`);
    return;
  }
  print(`${entries.map(clientText).join('\n\n')}\n`);
}

/** Lines under a heading, the heading on the first. */
function section(heading: string, lines: readonly string[] = []): string[] {
  const label = heading.padEnd(12);
  if (!lines.length) return [`  ${label} -`];
  return lines.map(
    (line, index) => `  ${index === 0 ? label : ' '.repeat(12)} ${line}`
  );
}

function clientText(entry: ListedClient): string {
  const { requirements } = entry;
  const rows = clientOptionRows(entry.options);
  // A union or other non-object plugin schema cannot be a flat option table.
  const optionText = rows.length
    ? formatTable(rows)
    : (entry.options.unavailable ??
      (entry.options.properties
        ? '(none declared)'
        : JSON.stringify(entry.options, null, 2)));
  return [
    entry.description !== undefined
      ? `${entry.ref}  ${entry.description}`
      : entry.ref,
    ...section('runs on', [clientOS(requirements)]),
    ...section('install', requirements.install),
    ...section('credentials', requirements.credentials),
    ...section('setup', requirements.setup),
    '  options (defaults; timeout in ms)',
    ...optionText.split('\n').map((line) => `    ${line}`),
  ].join('\n');
}

/** `mst clients show <ref>`: what a client needs and the options it takes. */
export async function showClient(
  ref: string,
  options: DiscoveryOptions,
  print: (text: string) => void = (text) => process.stdout.write(text)
): Promise<void> {
  // A renamed client fails naming its replacement, and `mst/client/<name>`
  // is the built-in `<name>`, as in an eval config.
  const wanted = builtinShortName(resolveClientName(ref), 'client');
  const entries = await clientEntries(options);
  const entry = entries.find((candidate) => candidate.ref === wanted);
  if (!entry) throw missingClient(ref, wanted, options);
  print(
    `${options.json ? JSON.stringify(entry, null, 2) : clientText(entry)}\n`
  );
}

/** Why `wanted` names no client that `options` loads. */
function missingClient(
  ref: string,
  wanted: string,
  options: DiscoveryOptions
): Error {
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
  return new Error(
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

/** The client `ref` names, loaded with its plugin's settings. */
async function loadClient(
  ref: string,
  options: DiscoveryOptions
): Promise<{
  ref: string;
  definition: ClientDefinition;
  settings?: Record<string, unknown>;
}> {
  // A renamed client fails naming its replacement, and `mst/client/<name>`
  // is the built-in `<name>`, as in an eval config.
  const wanted = builtinShortName(resolveClientName(ref), 'client');
  // Built-in clients need no plugin.
  const loaded =
    options.plugins?.length || options.config
      ? await loadDiscoveryPlugins(options)
      : undefined;
  const found = listClients().find(
    ([candidate]) =>
      candidate === wanted && inNamespaces(candidate, loaded?.namespaces ?? [])
  );
  if (!found) throw missingClient(ref, wanted, options);
  const settings = settingsFor(loaded?.settings, wanted);
  return {
    ref: wanted,
    definition: found[1],
    ...(settings ? { settings } : {}),
  };
}

/** `mst clients setup <ref>`: run the client's one-time machine setup. */
export async function setupClient(
  ref: string,
  options: DiscoveryOptions,
  print: (text: string) => void = (text) => process.stdout.write(text)
): Promise<void> {
  const client = await loadClient(ref, options);
  if (!client.definition.setup) {
    print(`${client.ref} needs no setup.\n`);
    return;
  }
  await client.definition.setup({
    print: (line) => print(`${line}\n`),
    ...(client.settings ? { settings: client.settings } : {}),
  });
}

export interface ClientRecoverOptions extends DiscoveryOptions {
  recoverStaleLock?: boolean;
}

/** `mst clients recover <ref>`: undo what a stopped run left changed. */
export async function recoverClient(
  ref: string,
  options: ClientRecoverOptions,
  print: (text: string) => void = (text) => process.stdout.write(text)
): Promise<void> {
  const client = await loadClient(ref, options);
  if (!client.definition.recover) {
    print(`${client.ref} has nothing to recover.\n`);
    return;
  }
  await client.definition.recover({
    print: (line) => print(`${line}\n`),
    recoverStaleLock: options.recoverStaleLock === true,
    ...(client.settings ? { settings: client.settings } : {}),
  });
}
