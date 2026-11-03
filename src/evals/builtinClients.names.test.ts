import { describe, expect, it } from 'vitest';
import { getClient, providerForModel } from './builtinClients.js';
import { validateEvalConfig } from './configValidation.js';
import { CHATGPT_CLIENT, CHATGPT_LINUX_CLIENT } from './chatgptClient.js';
import { storedClientName } from './clientNames.js';
import { playwrightClientOf } from './caseExecution.js';

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

  it('a stored run that says mst reads as api', () => {
    expect(storedClientName('mst')).toBe('api');
    expect(storedClientName('api')).toBe('api');
    expect(storedClientName('claude-code')).toBe('claude-code');
    expect(storedClientName('acme/client/desk')).toBe('acme/client/desk');
  });

  it('chatgpt is the ChatGPT client for this platform', () => {
    expect(getClient('chatgpt')).toBe(
      process.platform === 'linux' ? CHATGPT_LINUX_CLIENT : CHATGPT_CLIENT
    );
  });

  it('an unknown client lists only the canonical names', () => {
    expect(() =>
      validateEvalConfig({
        name: 'm',
        datasets: [{ type: 'file', path: 'x.json' }],
        client: 'sdk',
      })
    ).toThrow(
      'Client "sdk" is not available. Available: api, chatgpt, claude-code, codex, cowork.'
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
