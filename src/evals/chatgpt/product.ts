import type { ChatgptSurface } from './driver.js';

/** The two products share the ChatGPT app, not their client identity. */
export interface DesktopProduct {
  readonly client: 'chatgpt' | 'codex-app';
  readonly surface: ChatgptSurface;
  readonly label: string;
}

export const CHATGPT_PRODUCT: DesktopProduct = {
  client: 'chatgpt',
  surface: 'chatgpt-work',
  label: 'ChatGPT',
};

export const CODEX_APP_PRODUCT: DesktopProduct = {
  client: 'codex-app',
  surface: 'codex',
  label: 'Codex app',
};
