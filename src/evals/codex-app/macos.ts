import { chatgptMacos } from '../chatgpt/macos.js';
import { CODEX_APP_PRODUCT } from '../chatgpt/product.js';
import type { ChatgptDesktop } from '../chatgpt/desktop.js';

/** Codex uses the same macOS app transaction and native turn as ChatGPT. */
export const codexAppMacos: ChatgptDesktop = {
  ...chatgptMacos,
  product: CODEX_APP_PRODUCT,
};
