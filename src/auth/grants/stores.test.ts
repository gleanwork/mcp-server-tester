import { afterEach, describe, expect, it } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import {
  installPlugins,
  resetPluginsForTests,
} from '../../plugins/extensions.js';
import type { Plugin } from '../../plugins/plugin.js';
import {
  credentialStoreFor,
  getCredentialStore,
  isCredentialStoreReference,
} from './stores.js';
import type { CredentialStore } from './types.js';

afterEach(() => resetPluginsForTests());

const vault: CredentialStore = {
  get: async () => undefined,
  put: async () => {},
  delete: async () => {},
  withLock: (_key, fn) => fn(),
  describe: () => 'vault',
};

describe('--store', () => {
  it("takes a plugin's credential store by name, once its plugin is loaded", () => {
    installPlugins([
      {
        meta: { name: 'acme-plugin', namespace: 'acme' },
        credentialStores: { vault: { shared: true, create: () => vault } },
      } satisfies Plugin,
    ]);
    expect(isCredentialStoreReference('acme/credential-store/vault')).toBe(
      true
    );
    expect(credentialStoreFor('acme/credential-store/vault')).toBe(vault);
    expect(getCredentialStore('acme/credential-store/vault').shared).toBe(true);
  });

  it('takes a directory otherwise', () => {
    const dir = path.join(os.tmpdir(), 'grants');
    expect(isCredentialStoreReference(dir)).toBe(false);
    expect(credentialStoreFor(dir).describe()).toContain(dir);
  });

  it("rejects a plugin store whose create isn't a function", () => {
    expect(() =>
      installPlugins([
        {
          meta: { name: 'bad-plugin', namespace: 'bad' },
          credentialStores: { vault: { create: 'nope' } },
        } as unknown as Plugin,
      ])
    ).toThrow(/credentialStores.vault needs a create function/);
  });
});
