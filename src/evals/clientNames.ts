/**
 * Built-in client names that changed (ADRs 0002 and 0011): how a reference
 * in a config or case is checked, and how a name a stored run recorded is
 * read. Kept apart from the clients themselves, so the run format's readers
 * don't load them.
 */

/**
 * Earlier names for built-in clients. In a config or case they are errors,
 * not aliases: each names its replacement.
 */
const RENAMED_CLIENTS: Readonly<Record<string, string>> = {
  mst: 'api',
  'vercel-sdk': 'api',
  'anthropic-api': 'api',
  'claude-cli': 'claude-code',
  'chatgpt-mac': 'chatgpt',
  'chatgpt-linux': 'chatgpt',
  cowork_cu: 'cowork',
  'anthropic.claude.cowork.desktop-app.macos': 'cowork',
  'openai.chatgpt.agent.desktop-app.macos': 'chatgpt',
  'openai.chatgpt.agent.desktop-app.linux': 'chatgpt',
};

/**
 * Client names that runs stored before a rename recorded, and the client
 * each is now. A stored run keeps the names it was written with; readers
 * see the current one.
 */
const STORED_CLIENT_NAMES: Readonly<Record<string, string>> = {
  mst: 'api',
};

/** How a built-in client's full name starts: `mst/client/api` is `api`. */
const BUILTIN_CLIENT_PREFIX = 'mst/client/';

/**
 * A client reference as MST compares and records it: a built-in's full
 * name (`mst/client/api`) is its bare name (`api`). Anything else is
 * returned unchanged. It doesn't check renames; `resolveClientName` does.
 */
export function bareClientName(reference: string): string {
  return reference.startsWith(BUILTIN_CLIENT_PREFIX)
    ? reference.slice(BUILTIN_CLIENT_PREFIX.length)
    : reference;
}

/**
 * A client reference, checked: a renamed built-in fails naming its
 * replacement, by its full name too (`mst/client/mst`); anything else is
 * returned unchanged.
 */
export function resolveClientName(reference: string): string {
  const full = reference.startsWith(BUILTIN_CLIENT_PREFIX);
  const name = full ? reference.slice(BUILTIN_CLIENT_PREFIX.length) : reference;
  if (Object.hasOwn(RENAMED_CLIENTS, name)) {
    const current = RENAMED_CLIENTS[name]!;
    throw new Error(
      `Client "${reference}" is now "${full ? BUILTIN_CLIENT_PREFIX + current : current}".`
    );
  }
  return reference;
}

/**
 * The client a stored run's recorded name means now: `mst` (before ADR
 * 0011) is `api`, by its full name `mst/client/mst` too, and a built-in's
 * full name reads as its bare name. Any other name is returned unchanged.
 * Read stored client names through this, never through
 * `resolveClientName`, which rejects them.
 */
export function storedClientName(name: string): string {
  const bare = bareClientName(name);
  return Object.hasOwn(STORED_CLIENT_NAMES, bare)
    ? STORED_CLIENT_NAMES[bare]!
    : bare;
}

/**
 * The client a stored `chatgpt` with each `clientOptions.surface` is now
 * (ADR 0011). `chatgpt-work` was what `chatgpt` always does.
 */
const STORED_CHATGPT_SURFACES: Readonly<Record<string, string>> = {
  codex: 'codex-app',
  'chatgpt-work': 'chatgpt',
};

/**
 * The desktop clients, which took `clientOptions.computerUseProvider` before
 * the OS of the trial's machine decided how they run, and named their action
 * budget `computerUseMaxActions` or `nativeMaxActions` before it was
 * `maxActions` (ADR 0011).
 */
const DESKTOP_CLIENTS: ReadonlySet<string> = new Set([
  'cowork',
  'chatgpt',
  'codex-app',
]);

/**
 * The earlier names of a desktop client's `maxActions`. When a stored run
 * has both (ChatGPT on macOS, which ignored `nativeMaxActions`), the first
 * is the budget it ran with.
 */
const STORED_MAX_ACTIONS_NAMES = [
  'computerUseMaxActions',
  'nativeMaxActions',
] as const;

/**
 * Options each built-in client accepted and never used, until they failed
 * validation (ADR 0011): the api and claude-code clients' servers (they run
 * with the eval's) and Claude Code's legacy plugin settings, and the desktop
 * clients' fixed `provider`. A stored run that recorded one ran without it.
 */
const STORED_UNUSED_OPTIONS: Readonly<Record<string, readonly string[]>> = {
  api: ['server', 'servers'],
  'claude-code': ['server', 'servers', 'apiToken', 'pluginDir', 'pluginMcpUrl'],
  cowork: ['provider'],
  chatgpt: ['provider'],
  'codex-app': ['provider'],
};

/**
 * A client and its options as a stored run recorded them (a run.json
 * variant), as MST names them now: the name through `storedClientName`,
 * and a `chatgpt` with `clientOptions.surface: "codex"` (before ADR 0011)
 * as `codex-app`, with `surface` left out of its options, so it compares
 * equal to a config written today. A stored `surface: "chatgpt-work"` is
 * left out the same way, and so is a desktop client's
 * `computerUseProvider` (before ADR 0011 too), and an option the client
 * never used (`STORED_UNUSED_OPTIONS`). A desktop client's
 * `computerUseMaxActions` or `nativeMaxActions` reads as `maxActions`.
 * Anything else is returned unchanged.
 */
export function storedClientSetup<
  T extends { client?: string; clientOptions?: Record<string, unknown> },
>(item: T): T {
  if (item.client === undefined) return item;
  let client = storedClientName(item.client);
  const gone = new Set<string>();
  const surface = item.clientOptions?.surface;
  if (
    client === 'chatgpt' &&
    typeof surface === 'string' &&
    Object.hasOwn(STORED_CHATGPT_SURFACES, surface)
  ) {
    client = STORED_CHATGPT_SURFACES[surface]!;
    gone.add('surface');
  }
  // The stored name `maxActions` is read from, when it has one.
  let budget: string | undefined;
  if (DESKTOP_CLIENTS.has(client) && item.clientOptions) {
    const stored = item.clientOptions;
    if (Object.hasOwn(stored, 'computerUseProvider'))
      gone.add('computerUseProvider');
    for (const old of STORED_MAX_ACTIONS_NAMES) {
      if (!Object.hasOwn(stored, old)) continue;
      gone.add(old);
      if (!Object.hasOwn(stored, 'maxActions')) budget ??= old;
    }
  }
  const unused = Object.hasOwn(STORED_UNUSED_OPTIONS, client)
    ? STORED_UNUSED_OPTIONS[client]!
    : [];
  for (const key of unused)
    if (item.clientOptions && Object.hasOwn(item.clientOptions, key))
      gone.add(key);
  if (!gone.size) return client === item.client ? item : { ...item, client };
  // Renamed where it was, so the options keep the order a config gives them.
  const options = Object.fromEntries(
    Object.entries(item.clientOptions!).flatMap(([key, value]) =>
      key === budget
        ? [['maxActions', value]]
        : gone.has(key)
          ? []
          : [[key, value]]
    )
  );
  const { clientOptions: _options, ...rest } = item;
  return {
    ...rest,
    client,
    ...(Object.keys(options).length ? { clientOptions: options } : {}),
  } as T;
}
