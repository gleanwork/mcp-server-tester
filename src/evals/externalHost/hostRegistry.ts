import type { ExternalHostConfig } from './types.js';
import {
  CLAUDE_CHAT_DESKTOP_MACOS_DRIVER,
  CLAUDE_COWORK_DESKTOP_MACOS_DRIVER,
  driverToSlug,
} from './driverIdentity.js';

const EXTERNAL_HOST_REGISTRY: Record<
  string,
  Partial<ExternalHostConfig> & { name: string; description: string }
> = {
  [driverToSlug(CLAUDE_CHAT_DESKTOP_MACOS_DRIVER)]: {
    driver: CLAUDE_CHAT_DESKTOP_MACOS_DRIVER,
    name: 'Claude Chat Desktop',
    description:
      'Drives the regular Claude Desktop chat surface on macOS and captures low-confidence visible response evidence via Accessibility.',
    correlation: {
      strategy: 'prompt_marker',
      includeInPrompt: true,
    },
    capabilities: {
      control: { uses: 'builtin:platform.macos' },
      input: {
        uses: 'builtin:desktop.macos.accessibilitySubmit',
        with: {
          appName: 'Claude',
          createNewConversation: 'unless-disabled',
        },
      },
      completion: {
        uses: 'builtin:anthropic.claude.accessibilityTrace',
        provides: ['trace', 'normalize'],
      },
    },
  },
  [driverToSlug(CLAUDE_COWORK_DESKTOP_MACOS_DRIVER)]: {
    driver: CLAUDE_COWORK_DESKTOP_MACOS_DRIVER,
    name: 'Claude Cowork Desktop',
    description:
      'Drives the Claude Desktop Cowork surface on macOS and captures high-confidence local-agent trace evidence.',
    correlation: {
      strategy: 'prompt_marker',
      includeInPrompt: true,
    },
    capabilities: {
      control: [
        { uses: 'builtin:platform.macos' },
        { uses: 'builtin:anthropic.claude.coworkSurface' },
      ],
      input: {
        uses: 'builtin:desktop.macos.accessibilitySubmit',
        with: { appName: 'Claude', createNewConversation: false },
      },
      completion: {
        uses: 'builtin:anthropic.claude.localAgentTrace',
        provides: ['trace'],
      },
      normalize: {
        uses: 'builtin:anthropic.claude.localAgentNormalize',
      },
    },
  },
};

export function getRegisteredExternalHostConfig(
  driverSlug: string
): Partial<ExternalHostConfig> | undefined {
  return EXTERNAL_HOST_REGISTRY[driverSlug];
}

export function getRegisteredExternalHostDisplayName(
  driverSlug: string
): string | undefined {
  return EXTERNAL_HOST_REGISTRY[driverSlug]?.name;
}

export function getRegisteredExternalHostDescription(
  driverSlug: string
): string | undefined {
  return EXTERNAL_HOST_REGISTRY[driverSlug]?.description;
}

export function listRegisteredExternalHostSlugs(): string[] {
  return Object.keys(EXTERNAL_HOST_REGISTRY);
}
