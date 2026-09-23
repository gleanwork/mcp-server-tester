import { homedir } from 'node:os';
import type { SemanticDesktopTelemetry } from '../cowork/driver.js';
import {
  chatgptDesktopEnvironment,
  isLinuxChatgpt,
  readLaunchEnvironment,
  stringOption,
  type ChatgptApplicationController,
} from '../chatgpt/driver.js';
import {
  linuxChatgptHome,
  runLinuxChatgptDesktop,
  validateLinuxChatgptPaths,
} from '../chatgpt/linux.js';
import type { ExternalHostConfig } from '../externalHost/types.js';
import { getLinuxChatgptApplicationController } from './linuxController.js';
import {
  defaultChatgptAppPath,
  defaultChatgptBundleId,
  getChatgptApplicationController,
} from './macController.js';

/** Host options that differ by OS. Values are copied into ExternalHostConfig.options. */
export interface ChatgptHostOptions {
  computerUseProvider?: string;
  computerUseMaxActions?: number;
  desktopEnvironment?: Record<string, string>;
}

/** Comparable application identity; `leaseKey` claims the app within this process. */
export interface ChatgptApplication {
  leaseKey: string;
  appPath?: string;
  bundleId?: string;
  desktopEnvironment?: NodeJS.ProcessEnv;
}

/** The shared batch lifecycle does not choose OS paths or control an application.
 * Implementations must retain the existing fail-closed, no-resubmission contract. */
export interface ChatgptPlatform {
  readonly name: 'macos' | 'linux';
  readonly driver: string;
  /** Linux always owns an isolated profile, so CODEX_HOME is always explicit. */
  readonly isolatedConfigHome: boolean;
  readonly permissionNotice?: string;
  hostOptions(
    options: { computerUseProvider?: string; computerUseMaxActions?: number },
    environment: Record<string, string>
  ): ChatgptHostOptions;
  /** Directory that holds the cross-process desktop lock. */
  lockHome(config: ExternalHostConfig): string;
  application(
    config: ExternalHostConfig,
    binding?: Record<string, unknown>
  ): ChatgptApplication;
  controller(
    application: ChatgptApplication
  ): Promise<ChatgptApplicationController>;
  /** Optional native post-launch surface verification. */
  verifyReady?(config: ExternalHostConfig): Promise<SemanticDesktopTelemetry>;
}

export const MAC_CHATGPT_PLATFORM: ChatgptPlatform = {
  name: 'macos',
  driver: 'openai.chatgpt.agent.desktop-app.macos',
  isolatedConfigHome: false,
  permissionNotice:
    '[mst:chatgpt] Anthropic Computer Use requires Screen Recording and Accessibility permission. Keep ChatGPT visible and the desktop idle.\n',
  hostOptions(options) {
    return {
      computerUseProvider:
        options.computerUseProvider ?? 'anthropic-computer-use',
      computerUseMaxActions: options.computerUseMaxActions ?? 32,
    };
  },
  lockHome() {
    return homedir();
  },
  application(config, binding) {
    const bundleId =
      stringOption(binding, 'bundleId') ??
      stringOption(config.options, 'chatgptBundleId') ??
      defaultChatgptBundleId();
    return {
      leaseKey: bundleId,
      appPath:
        stringOption(binding, 'appPath') ??
        stringOption(config.options, 'chatgptAppPath') ??
        defaultChatgptAppPath(),
      bundleId,
    };
  },
  controller(application) {
    return getChatgptApplicationController({
      appPath: application.appPath,
      bundleId: application.bundleId,
    });
  },
};

export const LINUX_CHATGPT_PLATFORM: ChatgptPlatform = {
  name: 'linux',
  driver: 'openai.chatgpt.agent.desktop-app.linux',
  isolatedConfigHome: true,
  hostOptions(options, environment) {
    return {
      computerUseProvider: options.computerUseProvider,
      computerUseMaxActions: options.computerUseMaxActions,
      desktopEnvironment: environment,
    };
  },
  lockHome(config) {
    return linuxChatgptHome({
      ...process.env,
      ...readLaunchEnvironment(config.options?.desktopEnvironment),
    });
  },
  application(config) {
    const desktopEnvironment = chatgptDesktopEnvironment(config);
    return {
      leaseKey: validateLinuxChatgptPaths(config),
      desktopEnvironment,
    };
  },
  async controller(application) {
    return getLinuxChatgptApplicationController(application.desktopEnvironment);
  },
  async verifyReady(config) {
    const prepared = await runLinuxChatgptDesktop(
      'prepare',
      config,
      Date.now() + (config.timeoutMs ?? 60_000)
    );
    return prepared.telemetry;
  },
};

export function chatgptPlatform(config: ExternalHostConfig): ChatgptPlatform {
  return isLinuxChatgpt(config) ? LINUX_CHATGPT_PLATFORM : MAC_CHATGPT_PLATFORM;
}
