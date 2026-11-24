/**
 * Which automation Cowork on Linux runs on. Its own module, apart from
 * `linuxConnect.ts`, because the client (`linux.ts`) asks this on the
 * coordinator without connecting to anything: a bundle that only asks must
 * not carry the transports.
 *
 * The default is MST's own AT-SPI client, which Cowork on Linux ran on
 * before ADR 0017. `MST_DESKTOP_AUTOMATION=agent-desktop` runs the same
 * drivers over agent-desktop while that move is proven.
 */
import { DESKTOP_DEFAULTS } from '../desktopDefaults.js';
import {
  resolveDesktopAutomation,
  type DesktopAutomation,
} from '../desktopUi/automation.js';

/** The automation Cowork on Linux runs on in this environment. */
export function linuxCoworkAutomation(
  env: Record<string, string | undefined>
): DesktopAutomation {
  // Both of Cowork's modes on Linux run on the same drivers.
  return resolveDesktopAutomation(env, {
    name: 'cowork on Linux',
    default: DESKTOP_DEFAULTS.cowork.linux,
    supported: ['agent-desktop'],
  });
}
