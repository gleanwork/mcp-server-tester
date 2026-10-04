import { afterEach, describe, expect, it, vi } from 'vitest';
import { getHost } from './builtinHosts.js';
import { inheritHost, validateManifest } from './manifestValidation.js';

afterEach(() => vi.restoreAllMocks());

describe('built-in host names', () => {
  it.each([
    ['cowork_cu', 'cowork'],
    ['anthropic.claude.cowork.desktop-app.macos', 'cowork'],
    ['openai.chatgpt.agent.desktop-app.macos', 'chatgpt-mac'],
    ['openai.chatgpt.agent.desktop-app.linux', 'chatgpt-linux'],
  ])('%s is a deprecated name for %s, with one warning', (old, current) => {
    const warn = vi.spyOn(process, 'emitWarning').mockImplementation(() => {});
    expect(getHost(old)).toBe(getHost(current));
    getHost(old);
    const deprecations = warn.mock.calls.filter(
      ([message]) => typeof message === 'string' && message.includes(`"${old}"`)
    );
    expect(deprecations).toEqual([
      [
        `Host "${old}" is deprecated; use "${current}".`,
        { type: 'DeprecationWarning', code: 'MST_DEPRECATED_HOST' },
      ],
    ]);
  });

  it('chatgpt is the ChatGPT host for this platform', () => {
    vi.spyOn(process, 'emitWarning').mockImplementation(() => {});
    expect(getHost('chatgpt')).toBe(
      getHost(process.platform === 'linux' ? 'chatgpt-linux' : 'chatgpt-mac')
    );
  });

  it('an unknown host lists only the current names', () => {
    expect(() =>
      validateManifest({
        name: 'm',
        datasets: [{ type: 'file', path: 'x.json' }],
        host: { type: 'sdk' },
      })
    ).toThrow(
      'Host "sdk" is not available. Available: anthropic-api, chatgpt-linux, chatgpt-mac, claude-cli, cowork, vercel-sdk.'
    );
  });

  it('resolves a deprecated name before inheriting, so the arm keeps the manifest options', () => {
    vi.spyOn(process, 'emitWarning').mockImplementation(() => {});
    expect(
      inheritHost(
        { type: 'cowork', model: 'claude-sonnet-4-6' },
        { type: 'cowork_cu' }
      )
    ).toEqual({ type: 'cowork', model: 'claude-sonnet-4-6' });
  });
});
