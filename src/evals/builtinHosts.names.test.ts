import { describe, expect, it } from 'vitest';
import { getHost, providerForModel } from './builtinHosts.js';
import { validateManifest } from './manifestValidation.js';
import { CHATGPT_HOST, CHATGPT_LINUX_HOST } from './chatgptHost.js';

describe('built-in client names', () => {
  it.each([
    ['vercel-sdk', 'mst'],
    ['anthropic-api', 'mst'],
    ['claude-cli', 'claude-code'],
    ['chatgpt-mac', 'chatgpt'],
    ['chatgpt-linux', 'chatgpt'],
    ['cowork_cu', 'cowork'],
    ['anthropic.claude.cowork.desktop-app.macos', 'cowork'],
    ['openai.chatgpt.agent.desktop-app.macos', 'chatgpt'],
    ['openai.chatgpt.agent.desktop-app.linux', 'chatgpt'],
  ])('%s fails naming %s', (old, current) => {
    expect(() => getHost(old)).toThrow(`Client "${old}" is now "${current}".`);
  });

  it('chatgpt is the ChatGPT client for this platform', () => {
    expect(getHost('chatgpt')).toBe(
      process.platform === 'linux' ? CHATGPT_LINUX_HOST : CHATGPT_HOST
    );
  });

  it('an unknown client lists only the canonical names', () => {
    expect(() =>
      validateManifest({
        name: 'm',
        datasets: [{ type: 'file', path: 'x.json' }],
        host: { type: 'sdk' },
      })
    ).toThrow(
      'Client "sdk" is not available. Available: chatgpt, claude-code, cowork, mst.'
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
