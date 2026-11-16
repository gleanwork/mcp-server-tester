/**
 * The contract between the Linux ChatGPT adapter (linuxDesktop.ts) and its
 * native driver (linuxDriverMain.ts): which variables the driver sees, its
 * action budget and the only error codes a receipt may carry.
 */

/** The desktop session the driver attaches to. */
export const LINUX_CHATGPT_SESSION_ENVIRONMENT = [
  'PATH',
  'HOME',
  'DISPLAY',
  'XAUTHORITY',
  'DBUS_SESSION_BUS_ADDRESS',
  'AT_SPI_BUS_ADDRESS',
  'XDG_RUNTIME_DIR',
  'XDG_CONFIG_HOME',
  'LANG',
  'LC_ALL',
] as const;

/** The isolated app profile. */
export const LINUX_CHATGPT_PROFILE_ENVIRONMENT = [
  'XDG_DATA_HOME',
  'XDG_CACHE_HOME',
  'XDG_STATE_HOME',
  'CODEX_HOME',
] as const;

/** Fixed values the adapter sets for the driver. */
export const LINUX_CHATGPT_HELPER_ENVIRONMENT = ['NO_AT_BRIDGE'] as const;

/** Desktop variables the Node adapter forwards to the driver. */
export const LINUX_CHATGPT_RUNTIME_ENVIRONMENT: readonly string[] = [
  ...LINUX_CHATGPT_SESSION_ENVIRONMENT,
  ...LINUX_CHATGPT_PROFILE_ENVIRONMENT,
];

export const NATIVE_MAX_ACTIONS = { default: 24, max: 64 };

export const LINUX_CHATGPT_ERROR_CODES = [
  'accessibility_tree_budget',
  'desktop_ambiguous',
  'action_unavailable',
  'action_missing_or_ambiguous',
  'action_acknowledgement_uncertain',
  'composer_text_unavailable',
  'composer_missing_or_ambiguous',
  'deadline_exceeded',
  'action_budget_exhausted',
  'state_transition_unobserved',
  'draft_prompt_not_applied',
  'send_missing_or_ambiguous',
  'invalid_surface',
  'profession_ambiguous',
  'continue_missing_or_ambiguous',
  'skip_missing_or_ambiguous',
  'intro_confirmation_ambiguous',
  'mode_missing_or_ambiguous',
  'surface_item_ambiguous',
  'announcement_ambiguous',
  'invalid_prompt',
  'surface_mismatch',
  'invalid_budget',
  'input_too_large',
  'invalid_input',
  'helper_missing',
  'helper_failed',
  'helper_timeout',
  'profession_geometry_invalid',
  // The accessibility bus (linuxAtspiBus.ts).
  'accessibility_dbus_unavailable',
  'invalid_dbus_address',
  'accessibility_bus_disconnected',
  'accessibility_bus_closed',
  'accessibility_dbus_error',
  'accessibility_invalid_reply',
  'accessibility_node_defunct',
  'accessibility_tree_invalid',
  'desktop_driver_failed',
] as const;

export type LinuxChatgptErrorCode = (typeof LINUX_CHATGPT_ERROR_CODES)[number];

export function pickEnvironment(
  environment: NodeJS.ProcessEnv,
  keys: readonly string[]
): Record<string, string> {
  return Object.fromEntries(
    keys.flatMap((key) => {
      const value = environment[key];
      return value === undefined ? [] : [[key, value]];
    })
  );
}
