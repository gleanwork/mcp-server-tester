/**
 * What each desktop client runs on by default, on each OS: the one table of
 * defaults (ADR 0017). The client code that connects reads its default from
 * here, and `MST_DESKTOP_AUTOMATION` (`desktopUi/automation.ts`) chooses
 * another while a move is proven. A default of `agent-desktop` needs a
 * validation record in `docs/desktop-validation/`
 * (`tests/desktopValidation.test.ts`).
 */
import type { DesktopAutomation, DesktopOS } from './desktopUi/automation.js';

export const DESKTOP_DEFAULTS = {
  cowork: { linux: 'atspi', darwin: 'computer-use' },
  /** Cowork on the user's own account, which has no Computer Use planner. */
  'cowork-first-party': { linux: 'atspi', darwin: 'computer-use' },
  chatgpt: { linux: 'atspi', darwin: 'computer-use' },
  'codex-app': { linux: 'atspi', darwin: 'computer-use' },
} as const satisfies Record<string, Record<DesktopOS, DesktopAutomation>>;
