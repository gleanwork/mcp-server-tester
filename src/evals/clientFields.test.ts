import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { clientFieldsOf, clientOf, clientPatchOf } from './clientFields.js';
import { loadEvalManifestFromObject } from './evalManifest.js';
import { validateEvalCase } from './datasetTypes.js';
import { resolveManifestExtends } from './manifestExtends.js';
import { validateManifest } from './manifestValidation.js';
import { installPlugins, resetPluginsForTests } from '../plugins/extensions.js';

const HOST_IS_NOW =
  '`host` is now `client` (the client’s name), `model` and `clientOptions` (its other options)';

afterEach(() => resetPluginsForTests());

function load(manifest: Record<string, unknown>) {
  return loadEvalManifestFromObject(
    { name: 'm', datasets: ['./cases.json'], ...manifest },
    { skipDatasetValidation: true }
  );
}

describe('client, model and clientOptions', () => {
  it('reject the old host key in a manifest, an arm and a case', () => {
    expect(() => load({ host: { type: 'mst' } })).toThrow(HOST_IS_NOW);
    expect(() => load({ arms: [{ name: 'a', host: { model: 'x' } }] })).toThrow(
      HOST_IS_NOW
    );
    expect(() =>
      validateEvalCase({ id: 'c', input: 'hi', host: { type: 'mst' } })
    ).toThrow(HOST_IS_NOW);
  });

  it('keep the name and model out of clientOptions', () => {
    expect(() =>
      load({ client: 'mst', clientOptions: { type: 'mst' } })
    ).toThrow('Name the client with `client`, not `clientOptions.type`.');
    expect(() =>
      load({ client: 'mst', clientOptions: { model: 'claude-haiku-4-5' } })
    ).toThrow('Set the model with `model`, not `clientOptions.model`.');
  });

  it('declare the client MST resolves', () => {
    expect(clientOf({})).toBeUndefined();
    expect(
      clientOf({ client: 'cowork', clientOptions: { timeout: 1 } })
    ).toEqual({ type: 'cowork', timeout: 1 });
    // Options without a name are the default client's.
    expect(clientOf({ clientOptions: { timeout: 1 } })).toEqual({
      type: 'claude-code',
      timeout: 1,
    });
    expect(clientPatchOf({ model: 'm' })).toEqual({ model: 'm' });
    expect(clientFieldsOf({ type: 'mst', model: 'm', temperature: 0 })).toEqual(
      { client: 'mst', model: 'm', clientOptions: { temperature: 0 } }
    );
  });

  it("give an arm its own model, and drop another client's options", () => {
    const validated = validateManifest(
      load({
        client: 'mst',
        model: 'claude-sonnet-4-6',
        clientOptions: { temperature: 0.2 },
        arms: [
          { name: 'haiku', model: 'claude-haiku-4-5' },
          { name: 'code', client: 'claude-code' },
        ],
      })
    );
    expect(validated.arms?.[0]).toMatchObject({
      client: 'mst',
      model: 'claude-haiku-4-5',
      clientOptions: { temperature: 0.2 },
    });
    expect(validated.arms?.[1]?.client).toBe('claude-code');
    expect(validated.arms?.[1]?.clientOptions ?? {}).not.toHaveProperty(
      'temperature'
    );
  });

  it("replace a shared config's client when the manifest sets one", () => {
    installPlugins([
      {
        meta: { name: 'acme-plugin', namespace: 'acme' },
        clients: {
          echo: {
            schema: z.object({ type: z.string() }).passthrough(),
            evidence: 'structured',
            run: async () => ({ finalText: '', events: [] }),
          },
        },
        configs: {
          recommended: {
            client: 'acme/echo',
            clientOptions: { region: 'eu' },
            trials: 3,
          },
        },
      },
    ]);
    const base = { name: 'm', datasets: [], extends: ['acme/recommended'] };
    expect(resolveManifestExtends(base, ['acme'])).toMatchObject({
      client: 'acme/echo',
      clientOptions: { region: 'eu' },
      trials: 3,
    });
    const own = resolveManifestExtends(
      { ...base, clientOptions: { timeout: 5 } },
      ['acme']
    );
    // The manifest's options don't land on the shared config's client.
    expect(own.client).toBeUndefined();
    expect(own.clientOptions).toEqual({ timeout: 5 });
    expect(own.trials).toBe(3);
  });
});
