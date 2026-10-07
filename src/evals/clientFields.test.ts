import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { clientFieldsOf, clientOf, clientPatchOf } from './clientFields.js';
import { loadEvalConfigFromObject } from './evalConfig.js';
import { validateEvalCase } from './datasetTypes.js';
import { resolveConfigExtends } from './configExtends.js';
import { validateEvalConfig } from './configValidation.js';
import { installPlugins, resetPluginsForTests } from '../plugins/extensions.js';

const HOST_IS_NOW =
  '`host` is now `client` (the client’s name), `model` and `clientOptions` (its other options)';

afterEach(() => resetPluginsForTests());

function load(evalConfig: Record<string, unknown>) {
  return loadEvalConfigFromObject(
    { name: 'm', datasets: ['./cases.json'], ...evalConfig },
    { skipDatasetValidation: true }
  );
}

describe('client, model and clientOptions', () => {
  it('reject the old client key in an eval config, a variant and a case', () => {
    expect(() => load({ host: { type: 'mst' } })).toThrow(HOST_IS_NOW);
    expect(() =>
      load({ variants: [{ name: 'a', host: { model: 'x' } }] })
    ).toThrow(HOST_IS_NOW);
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

  it("give a variant its own model, and drop another client's options", () => {
    const validated = validateEvalConfig(
      load({
        client: 'mst',
        model: 'claude-sonnet-4-6',
        clientOptions: { temperature: 0.2 },
        variants: [
          { name: 'haiku', model: 'claude-haiku-4-5' },
          { name: 'code', client: 'claude-code' },
        ],
      })
    );
    expect(validated.variants?.[0]).toMatchObject({
      client: 'mst',
      model: 'claude-haiku-4-5',
      clientOptions: { temperature: 0.2 },
    });
    expect(validated.variants?.[1]?.client).toBe('claude-code');
    expect(validated.variants?.[1]?.clientOptions ?? {}).not.toHaveProperty(
      'temperature'
    );
  });

  it("replace a shared config's client when the eval config sets one", () => {
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
    expect(resolveConfigExtends(base, ['acme'])).toMatchObject({
      client: 'acme/echo',
      clientOptions: { region: 'eu' },
      trials: 3,
    });
    const own = resolveConfigExtends(
      { ...base, clientOptions: { timeout: 5 } },
      ['acme']
    );
    // The eval config's options don't land on the shared config's client.
    expect(own.client).toBeUndefined();
    expect(own.clientOptions).toEqual({ timeout: 5 });
    expect(own.trials).toBe(3);
  });
});
