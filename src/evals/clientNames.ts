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

/**
 * A client reference, checked: a renamed built-in fails naming its
 * replacement; anything else is returned unchanged.
 */
export function resolveClientName(reference: string): string {
  if (Object.hasOwn(RENAMED_CLIENTS, reference))
    throw new Error(
      `Client "${reference}" is now "${RENAMED_CLIENTS[reference]}".`
    );
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
