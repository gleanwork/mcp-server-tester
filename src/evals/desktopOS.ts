/**
 * How a desktop client (`cowork`, `chatgpt`, `codex-app`) runs follows from
 * the OS of the machine that runs the trial, not from configuration (ADR
 * 0011): on macOS, Computer Use, with `computerUseModel` as its planner; on
 * Linux, the accessibility (AT-SPI) automation, with no planner.
 */

/** Why `clientOptions.computerUseProvider` fails, on every desktop client. */
export const COMPUTER_USE_PROVIDER_GONE =
  '`clientOptions.computerUseProvider` is gone: remove it. The OS of the machine that runs the trial decides how a desktop client runs: on macOS, Computer Use, with `computerUseModel` as its planner; on Linux, the accessibility automation, with no planner.';

/**
 * Why an earlier name of a desktop client's action budget fails: it is
 * `maxActions` on every desktop client, whatever OS the trial runs on.
 */
export function maxActionsRenamed(
  old: 'computerUseMaxActions' | 'nativeMaxActions'
): string {
  return `\`clientOptions.${old}\` is now \`maxActions\`: a desktop client's action budget has one name, whatever OS the trial runs on.`;
}

/**
 * Why `clientOptions.provider` fails on a desktop client: the client fixes
 * it, so the option, which took only that one value, did nothing.
 */
export function fixedProviderGone(
  client: string,
  provider: 'anthropic' | 'openai'
): string {
  return `\`${client}\` fixes its own provider (\`${provider}\`). Its credentials and any LLM gateway come from the environment: \`mst clients show ${client}\` lists them.`;
}

/** An OS as messages name it. */
export function osName(os: NodeJS.Platform): string {
  return os === 'darwin' ? 'macOS' : os === 'linux' ? 'Linux' : os;
}
