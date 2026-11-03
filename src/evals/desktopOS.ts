/**
 * How a desktop client (`cowork`, `chatgpt`, `codex-app`) runs follows from
 * the OS of the machine that runs the trial, not from configuration (ADR
 * 0011): on macOS, Computer Use, with `computerUseModel` as its planner; on
 * Linux, the accessibility (AT-SPI) automation, with no planner.
 */

/** Why `clientOptions.computerUseProvider` fails, on every desktop client. */
export const COMPUTER_USE_PROVIDER_GONE =
  '`clientOptions.computerUseProvider` is gone: remove it. The OS of the machine that runs the trial decides how a desktop client runs: on macOS, Computer Use, with `computerUseModel` as its planner; on Linux, the accessibility automation, with no planner.';

/** An OS as messages name it. */
export function osName(os: NodeJS.Platform): string {
  return os === 'darwin' ? 'macOS' : os === 'linux' ? 'Linux' : os;
}
