import { chatgptLinux } from '../chatgpt/linux.js';
import { CODEX_APP_PRODUCT } from '../chatgpt/product.js';
import type { ChatgptDesktop } from '../chatgpt/desktop.js';

/** Codex uses the same Linux app transaction and native turn as ChatGPT. */
export const codexAppLinux: ChatgptDesktop = {
  ...chatgptLinux,
  product: CODEX_APP_PRODUCT,
};
