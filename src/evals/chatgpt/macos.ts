import { homedir } from 'node:os';
import type { ChatgptDesktop } from './desktop.js';
import { CHATGPT_PRODUCT } from './product.js';
import { stringOption } from './driver.js';
import { submitWithComputerUse } from './turn.js';
import {
  defaultChatgptAppPath,
  defaultChatgptBundleId,
  getChatgptApplicationController,
} from '../chatgptSetup/macController.js';

/** ChatGPT on macOS, using the shared app transaction and Computer Use loop. */
export const chatgptMacos: ChatgptDesktop = {
  product: CHATGPT_PRODUCT,
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
  validate() {
    /* macOS needs no validation beyond the shared config checks. */
  },
  bindingWindowMs: 30_000,
  nativeMarkdownEscapes: false,
  submit: submitWithComputerUse,
};
