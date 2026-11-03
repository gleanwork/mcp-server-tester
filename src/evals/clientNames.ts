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
 * 0011) is `api`. Any other name is returned unchanged. Read stored client
 * names through this, never through `resolveClientName`, which rejects them.
 */
export function storedClientName(name: string): string {
  return Object.hasOwn(STORED_CLIENT_NAMES, name)
    ? STORED_CLIENT_NAMES[name]!
    : name;
}
