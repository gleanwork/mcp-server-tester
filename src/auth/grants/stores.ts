import path from 'node:path';
import { extensionLookup } from '../../plugins/extensions.js';
import { settingsFor, type SettingsSections } from '../../plugins/settings.js';
import { defaultGrantsDirectory, localCredentialStore } from './localStore.js';
import type { CredentialStore, CredentialStoreDefinition } from './types.js';

const credentialStores = extensionLookup(
  'credentialStores',
  (): Readonly<Record<string, CredentialStoreDefinition>> => ({})
);

/** `<namespace>/credential-store/<name>`: a plugin's store, not a directory. */
export function isCredentialStoreReference(value: string): boolean {
  return /^[^/\s]+\/credential-store\/[^/\s]+$/.test(value);
}

/** The plugin credential store `reference` names. Its plugin must be loaded. */
export function getCredentialStore(
  reference: string
): CredentialStoreDefinition {
  return credentialStores.get(reference);
}

/**
 * The store `--store` names: a plugin's (`<namespace>/credential-store/<name>`,
 * once its plugin is loaded) or a directory. Without one, MST's local
 * directory (`~/.mcp-server-tester/grants`). `settings` are the eval's plugin
 * settings; a plugin's store gets its plugin's (ADR 0008).
 */
export function credentialStoreFor(
  store: string | undefined,
  settings?: SettingsSections
): CredentialStore {
  if (store === undefined)
    return localCredentialStore(defaultGrantsDirectory());
  if (isCredentialStoreReference(store))
    return getCredentialStore(store).create({
      settings: settingsFor(settings, store),
    });
  return localCredentialStore(path.resolve(store));
}
