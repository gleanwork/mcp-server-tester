import { NATIVE_MAX_ACTIONS } from './linuxContract.js';

/** The range of an action budget, and the budget when none is set. */
interface ActionBudget {
  readonly default: number;
  readonly max: number;
}

/**
 * `maxActions` on the ChatGPT app (`chatgpt`, `codex-app`), by the OS the
 * trial runs on: Computer Use's budget on macOS, the accessibility
 * automation's on Linux (`NATIVE_MAX_ACTIONS` in `linuxContract.ts`). The
 * least is 1 on both.
 */
export const CHATGPT_MAX_ACTIONS: Readonly<
  Record<'darwin' | 'linux', ActionBudget>
> = {
  darwin: { default: 32, max: 64 },
  linux: NATIVE_MAX_ACTIONS,
};

/** `maxActions`'s range and default on each OS, for docs and messages. */
export function chatgptMaxActionsSummary(): string {
  const { darwin, linux } = CHATGPT_MAX_ACTIONS;
  return `on macOS, 1 to ${darwin.max} (default ${darwin.default}); on Linux, 1 to ${linux.max} (default ${linux.default})`;
}
