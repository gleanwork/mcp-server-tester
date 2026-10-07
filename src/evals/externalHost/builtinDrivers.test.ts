import { describe, expect, it } from 'vitest';
import {
  OPENAI_CHATGPT_AGENT_DESKTOP_MACOS_DRIVER,
  driverToSlug,
  normalizeHostDriver,
} from './driverIdentity.js';
import {
  getBuiltinDriverConfig,
  listBuiltinDriverSlugs,
} from './builtinDrivers.js';
import { loadExternalHostConfig } from './capabilityRuntime.js';

describe('external host driver identity and built-in defaults', () => {
  it('defaults ChatGPT to exact-prompt matching and allows explicit markers', () => {
    const driver = 'openai.chatgpt.agent.desktop-app.macos';
    expect(getBuiltinDriverConfig(driver)?.correlation).toEqual({
      strategy: 'exact_prompt',
    });
    const loaded = loadExternalHostConfig({
      driver,
      correlation: { strategy: 'prompt_marker' },
    });
    expect(loaded.config.correlation).toEqual({ strategy: 'prompt_marker' });
  });
  it('defaults Linux to native capabilities without a planner', () => {
    const loaded = loadExternalHostConfig({
      driver: 'openai.chatgpt.agent.desktop-app.linux',
    });
    expect(loaded.loadedCapabilities.map((c) => c.binding.uses)).toEqual([
      'builtin:openai.chatgpt.configLifecycle',
      'builtin:openai.chatgpt.appLifecycle',
      'builtin:openai.chatgpt.nativeSurface',
      'builtin:openai.chatgpt.nativeSubmit',
      'builtin:openai.chatgpt.nativeTrace',
    ]);
  });
  it('round-trips structured driver ids to slugs', () => {
    const slug = driverToSlug(OPENAI_CHATGPT_AGENT_DESKTOP_MACOS_DRIVER);

    expect(slug).toBe('openai.chatgpt.agent.desktop-app.macos');
    expect(normalizeHostDriver(slug)).toEqual(
      OPENAI_CHATGPT_AGENT_DESKTOP_MACOS_DRIVER
    );
  });

  it('returns no built-in defaults for syntactically valid unsupported drivers', () => {
    expect(
      getBuiltinDriverConfig('openai.chatgpt.chat.browser.web')
    ).toBeUndefined();
  });

  it('lists built-in drivers by structured driver slug', () => {
    expect(listBuiltinDriverSlugs()).toEqual([
      'openai.chatgpt.agent.desktop-app.macos',
      'openai.chatgpt.agent.desktop-app.linux',
    ]);
  });
});
