import { describe, expect, it } from 'vitest';
import { getClient, providerForModel } from './builtinClients.js';
import { validateEvalConfig } from './configValidation.js';
import { loadEvalConfigFromObject } from './evalConfig.js';
import { CHATGPT_APP_CLIENTS } from './chatgptClient.js';
import { storedClientName } from './clientNames.js';
import { playwrightClientOf } from './caseExecution.js';
import { runEvalCase } from './evalRunner.js';

describe('built-in client names', () => {
  it.each([
    ['mst', 'api'],
    ['vercel-sdk', 'api'],
    ['anthropic-api', 'api'],
    ['claude-cli', 'claude-code'],
    ['chatgpt-mac', 'chatgpt'],
    ['chatgpt-linux', 'chatgpt'],
    ['cowork_cu', 'cowork'],
    ['anthropic.claude.cowork.desktop-app.macos', 'cowork'],
    ['openai.chatgpt.agent.desktop-app.macos', 'chatgpt'],
    ['openai.chatgpt.agent.desktop-app.linux', 'chatgpt'],
  ])('%s fails naming %s', (old, current) => {
    expect(() => getClient(old)).toThrow(
      `Client "${old}" is now "${current}".`
    );
  });

  it('an eval config or a case naming mst fails naming api', () => {
    const config = {
      name: 'm',
      datasets: [{ type: 'file', path: 'x.json' }],
    };
    expect(() => validateEvalConfig({ ...config, client: 'mst' })).toThrow(
      'Client "mst" is now "api".'
    );
    expect(() =>
      validateEvalConfig({
        ...config,
        client: 'api',
        variants: [{ name: 'old', client: 'mst' }],
      })
    ).toThrow('Client "mst" is now "api".');
    // A case in a Playwright test, or the run it inherits from.
    expect(() =>
      playwrightClientOf({ id: 'c', input: 'hi', client: 'mst' }, undefined)
    ).toThrow('Client "mst" is now "api".');
    expect(() =>
      playwrightClientOf({ id: 'c', input: 'hi' }, { client: 'mst' })
    ).toThrow('Client "mst" is now "api".');
  });

  it('the full name mst/client/mst fails naming mst/client/api', () => {
    const config = {
      name: 'm',
      datasets: [{ type: 'file', path: 'x.json' }],
    };
    const renamed = 'Client "mst/client/mst" is now "mst/client/api".';
    expect(() => getClient('mst/client/mst')).toThrow(renamed);
    expect(() =>
      validateEvalConfig({ ...config, client: 'mst/client/mst' })
    ).toThrow(renamed);
    expect(() =>
      validateEvalConfig({
        ...config,
        client: 'api',
        variants: [{ name: 'old', client: 'mst/client/mst' }],
      })
    ).toThrow(renamed);
    expect(() =>
      playwrightClientOf(
        { id: 'c', input: 'hi', client: 'mst/client/mst' },
        undefined
      )
    ).toThrow(renamed);
    // The current full name still works.
    expect(getClient('mst/client/api')).toBe(getClient('api'));
  });

  it('a case runs on mst/client/api outside an eval, inheriting the run', () => {
    const run = {
      client: 'mst/client/api',
      model: 'claude-haiku-4-5',
      clientOptions: { temperature: 0 },
    };
    expect(playwrightClientOf({ id: 'c', input: 'hi' }, run)).toEqual({
      temperature: 0,
      model: 'claude-haiku-4-5',
    });
    // The case names the bare name; the run's full name is the same client.
    expect(
      playwrightClientOf({ id: 'c', input: 'hi', client: 'api' }, run)
    ).toEqual({ temperature: 0, model: 'claude-haiku-4-5' });
    expect(
      playwrightClientOf(
        { id: 'c', input: 'hi', client: 'mst/client/api' },
        undefined
      )
    ).toEqual({});
  });

  it('a stored run that says mst reads as api', () => {
    expect(storedClientName('mst')).toBe('api');
    expect(storedClientName('api')).toBe('api');
    expect(storedClientName('claude-code')).toBe('claude-code');
    expect(storedClientName('acme/client/desk')).toBe('acme/client/desk');
    // runEvalCase recorded a full name as it was given.
    expect(storedClientName('mst/client/mst')).toBe('api');
    expect(storedClientName('mst/client/api')).toBe('api');
  });

  it('codex fails naming codex-cli, and codex-app for the Codex surface', () => {
    const config = {
      name: 'm',
      datasets: [{ type: 'file', path: 'x.json' }],
    };
    const renamed =
      'Client "codex" is now "codex-cli". For the Codex surface of the ChatGPT desktop app, use "codex-app".';
    expect(() => getClient('codex')).toThrow(renamed);
    expect(() => validateEvalConfig({ ...config, client: 'codex' })).toThrow(
      renamed
    );
    expect(() =>
      validateEvalConfig({
        ...config,
        client: 'api',
        variants: [{ name: 'old', client: 'codex' }],
      })
    ).toThrow(renamed);
    expect(() =>
      playwrightClientOf({ id: 'c', input: 'hi', client: 'codex' }, undefined)
    ).toThrow(renamed);
    expect(() => getClient('mst/client/codex')).toThrow(
      'Client "mst/client/codex" is now "mst/client/codex-cli". For the Codex surface of the ChatGPT desktop app, use "codex-app".'
    );
    // The current names still work.
    expect(getClient('mst/client/codex-cli')).toBe(getClient('codex-cli'));
  });

  it('a stored run that says codex reads as codex-cli', () => {
    expect(storedClientName('codex')).toBe('codex-cli');
    expect(storedClientName('mst/client/codex')).toBe('codex-cli');
    expect(storedClientName('codex-cli')).toBe('codex-cli');
    expect(storedClientName('codex-app')).toBe('codex-app');
  });

  it('a result records the client and model the case ran on, by either name', async () => {
    async function completed() {
      return {
        kind: 'completed' as const,
        response: { success: true, response: 'ok', toolCalls: [] },
      };
    }
    const model = 'claude-haiku-4-5';
    async function requestOf(
      evalCase: { id: string; input: string; client?: string },
      client: string | undefined
    ) {
      const result = await runEvalCase(
        evalCase,
        {},
        { client, model, executeCase: completed, grade: false }
      );
      // The case ran with the model playwrightClientOf gives it.
      expect(playwrightClientOf(evalCase, { client, model }).model).toBe(model);
      return { client: result.request?.client, model: result.request?.model };
    }
    const ran = { client: 'api', model };
    const input = 'hi';
    expect(
      await requestOf({ id: 'a', input, client: 'api' }, 'mst/client/api')
    ).toEqual(ran);
    expect(
      await requestOf({ id: 'b', input, client: 'mst/client/api' }, 'api')
    ).toEqual(ran);
    expect(await requestOf({ id: 'c', input }, 'mst/client/api')).toEqual(ran);
    // A run that names no client runs on api.
    expect(
      await requestOf({ id: 'd', input, client: 'api' }, undefined)
    ).toEqual(ran);
  });

  it('chatgpt is the ChatGPT client, whose OS the trial machine picks', () => {
    expect(getClient('chatgpt')).toBe(CHATGPT_APP_CLIENTS.chatgpt);
  });

  it('codex-app is the Codex app client, by either name', () => {
    const client = CHATGPT_APP_CLIENTS['codex-app'];
    expect(getClient('codex-app')).toBe(client);
    expect(getClient('mst/client/codex-app')).toBe(client);
    expect(client).not.toBe(getClient('chatgpt'));
    const config = {
      name: 'm',
      datasets: [{ type: 'file', path: 'x.json' }],
      model: 'gpt-test',
    };
    // Read as an eval config is, the full name is the bare one.
    const loaded = loadEvalConfigFromObject(
      {
        ...config,
        client: 'mst/client/codex-app',
        variants: [
          { name: 'work', client: 'chatgpt' },
          { name: 'codex', client: 'mst/client/codex-app' },
        ],
      },
      { skipDatasetValidation: true }
    );
    expect(loaded.client).toBe('codex-app');
    expect(loaded.variants?.map((variant) => variant.client)).toEqual([
      'chatgpt',
      'codex-app',
    ]);
    expect(
      validateEvalConfig(loaded).variants?.map((variant) => variant.client)
    ).toEqual(['chatgpt', 'codex-app']);
    expect(() =>
      validateEvalConfig({ ...config, client: 'mst/client/codex-app' })
    ).not.toThrow();
  });

  describe('clientOptions.surface fails when the config loads, naming its replacement', () => {
    const config = {
      name: 'm',
      datasets: [{ type: 'file', path: 'x.json' }],
      model: 'gpt-test',
    };
    const toCodexApp =
      '`clientOptions.surface` is gone: use the `codex-app` client for the Codex surface, and remove `surface`.';
    const remove =
      '`clientOptions.surface` is gone: remove it. `chatgpt` always drives ChatGPT Work.';

    it('on the eval config', () => {
      expect(() =>
        validateEvalConfig({
          ...config,
          client: 'chatgpt',
          clientOptions: { surface: 'codex' },
        })
      ).toThrow(toCodexApp);
      expect(() =>
        validateEvalConfig({
          ...config,
          client: 'mst/client/chatgpt',
          clientOptions: { surface: 'chatgpt-work' },
        })
      ).toThrow(remove);
      expect(() =>
        validateEvalConfig({
          ...config,
          client: 'codex-app',
          clientOptions: { surface: 'codex' },
        })
      ).toThrow(
        '`clientOptions.surface` is gone: remove it. `codex-app` always drives the Codex surface.'
      );
    });

    it('on a variant, its own or inherited', () => {
      expect(() =>
        validateEvalConfig({
          ...config,
          client: 'api',
          variants: [
            { name: 'work', client: 'chatgpt' },
            {
              name: 'codex',
              client: 'chatgpt',
              clientOptions: { surface: 'codex' },
            },
          ],
        })
      ).toThrow(toCodexApp);
      // A variant that keeps the client inherits the eval's options.
      expect(() =>
        validateEvalConfig({
          ...config,
          client: 'chatgpt',
          clientOptions: { surface: 'chatgpt-work' },
          variants: [{ name: 'a' }, { name: 'b', model: 'gpt-other' }],
        })
      ).toThrow(remove);
    });
  });

  it('an unknown client lists only the canonical names', () => {
    expect(() =>
      validateEvalConfig({
        name: 'm',
        datasets: [{ type: 'file', path: 'x.json' }],
        client: 'sdk',
      })
    ).toThrow(
      'Client "sdk" is not available. Available: api, chatgpt, claude-code, codex-app, codex-cli, cowork.'
    );
  });
});

describe('providerForModel', () => {
  it.each([
    ['claude-sonnet-4-6', 'anthropic'],
    ['claude-haiku-4-5@20251001', 'vertex-anthropic'],
    ['gpt-5', 'openai'],
    ['o3-mini', 'openai'],
    ['gemini-2.5-pro', 'google'],
    ['mistral-large-latest', 'mistral'],
    ['deepseek-chat', 'deepseek'],
    ['grok-4', 'xai'],
  ])('%s is served by %s', (model, provider) => {
    expect(providerForModel(model)).toBe(provider);
  });

  it('leaves an unknown model to the provider setting', () => {
    expect(providerForModel('my-local-model')).toBeUndefined();
    expect(providerForModel(undefined)).toBeUndefined();
  });
});
