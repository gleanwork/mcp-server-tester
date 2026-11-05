import { homedir } from 'node:os';
import { join } from 'node:path';
import type { SemanticDesktopTelemetry } from '../cowork/driver.js';
import {
  chatgptDesktopEnvironment,
  isLinuxChatgpt,
  stringOption,
  type ChatgptApplicationController,
} from '../chatgpt/driver.js';
import {
  runLinuxChatgptDesktop,
  type ChatgptPromptOpener,
} from '../chatgpt/linux.js';
import type { ChatgptAppConfig } from '../chatgpt/config.js';
import {
  createLinuxChatgptProfile,
  readLinuxChatgptEnvironment,
  validateLinuxChatgptConfig,
  type ChatgptPlatformProfile,
} from './linuxProfile.js';
import {
  defaultChatgptAppPath,
  defaultChatgptBundleId,
  getChatgptApplicationController,
} from './macController.js';

/** Comparable application identity; `leaseKey` claims the app within this process. */
interface ChatgptApplication {
  leaseKey: string;
  appPath?: string;
  bundleId?: string;
  desktopEnvironment?: NodeJS.ProcessEnv;
  /** Platform-owned config.toml; overrides codexSetup.configPath. */
  configPath?: string;
}

/** The shared batch lifecycle does not choose OS paths or control an application.
 * Implementations must retain the existing fail-closed, no-resubmission contract. */
export interface ChatgptPlatform {
  readonly name: 'macos' | 'linux';
  /** The OS it runs on, as `process.platform` names it. */
  readonly os: 'darwin' | 'linux';
  /** Linux always owns an isolated profile, so CODEX_HOME is always explicit. */
  readonly isolatedConfigHome: boolean;
  readonly permissionNotice?: string;
  /** Directory that holds the cross-process desktop lock. */
  lockHome(config: ChatgptAppConfig): string;
  application(
    config: ChatgptAppConfig,
    binding?: Record<string, unknown>
  ): ChatgptApplication;
  /** macOS: control the user's installed app. */
  controller?(
    application: ChatgptApplication
  ): Promise<ChatgptApplicationController>;
  /** Linux: create a fresh MST-owned profile, app controller, and readiness gate. */
  createProfile?(
    application: ChatgptApplication
  ): Promise<ChatgptPlatformProfile>;
  /** Optional native post-launch surface verification. */
  verifyReady?(
    config: ChatgptAppConfig,
    openPrompt: ChatgptPromptOpener
  ): Promise<SemanticDesktopTelemetry>;
}

export const MAC_CHATGPT_PLATFORM: ChatgptPlatform = {
  name: 'macos',
  os: 'darwin',
  isolatedConfigHome: false,
  permissionNotice:
    '[mst:chatgpt] Anthropic Computer Use requires Screen Recording and Accessibility permission. Keep ChatGPT visible and the desktop idle.\n',
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
  os: 'linux',
  isolatedConfigHome: true,
  lockHome(config) {
    return validateLinuxChatgptConfig(config).home;
  },
  application(config) {
    const environment = validateLinuxChatgptConfig(config);
    return {
      leaseKey: environment.home,
      configPath: join(environment.codexHome, 'config.toml'),
      desktopEnvironment: chatgptDesktopEnvironment(config),
    };
  },
  async createProfile(application) {
    return createLinuxChatgptProfile(
      readLinuxChatgptEnvironment(application.desktopEnvironment ?? {})
    );
  },
  async verifyReady(config, openPrompt) {
    const prepared = await runLinuxChatgptDesktop(
      'prepare',
      config,
      Date.now() + (config.timeoutMs ?? 60_000),
      undefined,
      openPrompt
    );
    return prepared.telemetry;
  },
};

/**
 * How the ChatGPT app runs on `os`, the OS of the machine that runs the trial
 * (ADR 0011): Computer Use on macOS, the accessibility automation on Linux.
 */
export function chatgptPlatformFor(os: NodeJS.Platform): ChatgptPlatform {
  if (os === 'darwin') return MAC_CHATGPT_PLATFORM;
  if (os === 'linux') return LINUX_CHATGPT_PLATFORM;
  throw new Error(`The ChatGPT app runs on macOS or Linux, not ${os}.`);
}

export function chatgptPlatform(config: ChatgptAppConfig): ChatgptPlatform {
  return isLinuxChatgpt(config) ? LINUX_CHATGPT_PLATFORM : MAC_CHATGPT_PLATFORM;
}
