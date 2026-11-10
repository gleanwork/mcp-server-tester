import { join } from 'node:path';
import type { ChatgptDesktop } from './desktop.js';
import { CHATGPT_PRODUCT } from './product.js';
import { chatgptDesktopEnvironment } from './driver.js';
import { runLinuxChatgptDesktop } from './linuxDesktop.js';
import { submitNatively } from './turn.js';
import { installedDebApp } from '../installedApp.js';
import {
  createLinuxChatgptProfile,
  readLinuxChatgptEnvironment,
  validateLinuxChatgptConfig,
} from '../chatgptSetup/linuxProfile.js';

/** ChatGPT on Linux, using the shared app transaction and native AT-SPI helper. */
export const chatgptLinux: ChatgptDesktop = {
  product: CHATGPT_PRODUCT,
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
  validate: validateLinuxChatgptConfig,
  /** The image installs ChatGPT as the `chatgpt` package (docker/chatgpt-linux). */
  async app() {
    return installedDebApp('chatgpt', 'ChatGPT');
  },
  /** Cold Linux first turns need time to flush. */
  bindingWindowMs: 120_000,
  nativeMarkdownEscapes: true,
  submit: submitNatively,
};
