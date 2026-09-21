import type { ExternalHostConfig } from './types.js';
import {
  OPENAI_CHATGPT_AGENT_DESKTOP_MACOS_DRIVER,
  CLAUDE_CHAT_DESKTOP_MACOS_DRIVER,
  CLAUDE_COWORK_DESKTOP_MACOS_DRIVER,
  driverToSlug,
} from './driverIdentity.js';

const EXTERNAL_HOST_REGISTRY: Record<
  string,
  Partial<ExternalHostConfig> & { name: string; description: string }
> = {
  [driverToSlug(OPENAI_CHATGPT_AGENT_DESKTOP_MACOS_DRIVER)]: {
    driver: OPENAI_CHATGPT_AGENT_DESKTOP_MACOS_DRIVER,
    name: 'ChatGPT Agent Desktop',
    description:
      'Drives ChatGPT Work on macOS with Anthropic AI Computer Use and correlated native telemetry.',
    correlation: { strategy: 'exact_prompt' },
    capabilities: {
      control: [
        { uses: 'builtin:openai.chatgpt.configLifecycle' },
        { uses: 'builtin:openai.chatgpt.appLifecycle' },
        { uses: 'builtin:openai.chatgpt.computerUseSurface' },
      ],
      input: { uses: 'builtin:openai.chatgpt.computerUseSubmit' },
      completion: {
        uses: 'builtin:openai.chatgpt.computerUseTrace',
        provides: ['trace', 'normalize'],
      },
    },
  },
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
        {
          uses: 'builtin:anthropic.claude.activateCoworkSurface',
          with: { appName: 'Claude' },
        },
      ],
      input: {
        uses: 'builtin:desktop.macos.accessibilitySubmit',
        with: { appName: 'Claude', createNewConversation: true },
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
