import { describe, expect, it } from 'vitest';
import {
  CLAUDE_COWORK_DESKTOP_MACOS_DRIVER,
  driverToSlug,
  getRegisteredExternalHostConfig,
  loadExternalHostConfig,
  listRegisteredExternalHostSlugs,
  normalizeHostDriver,
  parseDriverSlug,
} from './index.js';

describe('external host driver identity and built-in defaults', () => {
  it('round-trips structured driver ids to slugs', () => {
    const slug = driverToSlug(CLAUDE_COWORK_DESKTOP_MACOS_DRIVER);

    expect(slug).toBe('anthropic.claude.cowork.desktop-app.macos');
    expect(parseDriverSlug(slug)).toEqual(CLAUDE_COWORK_DESKTOP_MACOS_DRIVER);
  });

  it('normalizes driver slug strings to structured ids', () => {
    expect(
      normalizeHostDriver('anthropic.claude.cowork.desktop-app.macos')
    ).toEqual(CLAUDE_COWORK_DESKTOP_MACOS_DRIVER);
  });

  it('declares Claude Cowork as capability bindings, not a concrete runner', () => {
    const config = getRegisteredExternalHostConfig(
      'anthropic.claude.cowork.desktop-app.macos'
    );

    expect(config?.name).toBe('Claude Cowork Desktop');
    expect(config?.correlation).toEqual({
      strategy: 'prompt_marker',
      includeInPrompt: true,
    });
    expect(config?.capabilities).toMatchObject({
      control: [
        { uses: 'builtin:platform.macos' },
        {
          uses: 'builtin:anthropic.claude.activateCoworkSurface',
          with: { appName: 'Claude' },
        },
      ],
      input: { uses: 'builtin:desktop.macos.accessibilitySubmit' },
      completion: {
        uses: 'builtin:anthropic.claude.localAgentTrace',
        provides: ['trace'],
      },
      normalize: {
        uses: 'builtin:anthropic.claude.localAgentNormalize',
      },
    });
  });

  it('loads Claude Cowork defaults into concrete capability providers at runtime', async () => {
    const loaded = await loadExternalHostConfig({
      driver: 'anthropic.claude.cowork.desktop-app.macos',
    });

    expect(loaded.displayName).toBe('Claude Cowork Desktop');
    expect(loaded.capabilitiesUsed).toEqual([
      'control',
      'input',
      'completion',
      'trace',
      'normalize',
    ]);
    expect(
      loaded.loadedCapabilities.map((capability) => capability.binding.uses)
    ).toEqual([
      'builtin:platform.macos',
      'builtin:anthropic.claude.activateCoworkSurface',
      'builtin:desktop.macos.accessibilitySubmit',
      'builtin:anthropic.claude.localAgentTrace',
      'builtin:anthropic.claude.localAgentNormalize',
    ]);
  });

  it('returns no built-in defaults for syntactically valid unsupported drivers', () => {
    expect(
      getRegisteredExternalHostConfig('openai.chatgpt.chat.browser.web')
    ).toBeUndefined();
  });

  it('lists registered external hosts by structured driver slug', () => {
    expect(listRegisteredExternalHostSlugs()).toEqual([
      'anthropic.claude.chat.desktop-app.macos',
      'anthropic.claude.cowork.desktop-app.macos',
    ]);
  });
});
