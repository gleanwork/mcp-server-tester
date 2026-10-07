import type { ExternalClientConfig } from './types.js';
import {
  OPENAI_CHATGPT_AGENT_DESKTOP_MACOS_DRIVER,
  OPENAI_CHATGPT_AGENT_DESKTOP_LINUX_DRIVER,
  driverToSlug,
} from './driverIdentity.js';

const BUILTIN_DRIVERS: Record<
  string,
  Partial<ExternalClientConfig> & { name: string; description: string }
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
  [driverToSlug(OPENAI_CHATGPT_AGENT_DESKTOP_LINUX_DRIVER)]: {
    driver: OPENAI_CHATGPT_AGENT_DESKTOP_LINUX_DRIVER,
    name: 'ChatGPT Native Linux Desktop',
    description:
      'Drives a caller-prepared Linux ChatGPT desktop through AT-SPI with correlated native telemetry.',
    correlation: { strategy: 'exact_prompt' },
    capabilities: {
      control: [
        { uses: 'builtin:openai.chatgpt.configLifecycle' },
        { uses: 'builtin:openai.chatgpt.appLifecycle' },
        { uses: 'builtin:openai.chatgpt.nativeSurface' },
      ],
      input: { uses: 'builtin:openai.chatgpt.nativeSubmit' },
      completion: {
        uses: 'builtin:openai.chatgpt.nativeTrace',
        provides: ['trace', 'normalize'],
      },
    },
  },
};

export function getBuiltinDriverConfig(
  driverSlug: string
): Partial<ExternalClientConfig> | undefined {
  return BUILTIN_DRIVERS[driverSlug];
}

export function getBuiltinDriverDisplayName(
  driverSlug: string
): string | undefined {
  return BUILTIN_DRIVERS[driverSlug]?.name;
}

export function listBuiltinDriverSlugs(): string[] {
  return Object.keys(BUILTIN_DRIVERS);
}
