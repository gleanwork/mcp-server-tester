/**
 * Which transport of the desktop interface a client runs on (ADR 0017).
 *
 * A client on an OS has one default, which is what it ran on before the ADR.
 * While a move to agent-desktop is proven, the machine that runs the trial
 * can choose it with `MST_DESKTOP_AUTOMATION=agent-desktop`. It is not an
 * eval config option: how a client runs is not configuration (ADR 0011). The
 * variable goes when the last default has changed.
 */

export const DESKTOP_AUTOMATION_ENV = 'MST_DESKTOP_AUTOMATION';

/**
 * The ways MST drives a desktop app. `computer-use` reads screenshots with a
 * planner model; the others read the OS accessibility tree.
 */
export const DESKTOP_AUTOMATIONS = [
  'atspi',
  'computer-use',
  'agent-desktop',
] as const;
export type DesktopAutomation = (typeof DESKTOP_AUTOMATIONS)[number];

/** The OSes MST has a desktop setup on. */
export type DesktopOS = 'linux' | 'darwin';

function isAutomation(value: string): value is DesktopAutomation {
  return (DESKTOP_AUTOMATIONS as readonly string[]).includes(value);
}

/**
 * The automation this environment chooses, or undefined for the client's
 * default. Fails on a value MST doesn't know, before anything touches the app.
 */
export function chosenDesktopAutomation(
  env: Record<string, string | undefined>
): DesktopAutomation | undefined {
  const value = env[DESKTOP_AUTOMATION_ENV];
  if (value === undefined || value === '') return undefined;
  if (!isAutomation(value))
    throw new Error(
      `${DESKTOP_AUTOMATION_ENV}=${JSON.stringify(value)} names no desktop automation; MST knows ${DESKTOP_AUTOMATIONS.join(', ')}.`
    );
  return value;
}

/**
 * The automation a client runs on here: the one this environment chooses
 * when the client can run on it, else the client's default. A choice the
 * client can't run on fails, before anything touches the app.
 */
export function resolveDesktopAutomation(
  env: Record<string, string | undefined>,
  client: {
    /** The client's name and OS, for the failure. */
    name: string;
    default: DesktopAutomation;
    /** What the client can run on besides its default. */
    supported?: readonly DesktopAutomation[];
  }
): DesktopAutomation {
  const chosen = chosenDesktopAutomation(env);
  if (chosen === undefined || chosen === client.default) return client.default;
  if (!client.supported?.includes(chosen))
    throw new Error(
      `${DESKTOP_AUTOMATION_ENV}=${chosen} is not a way ${client.name} can run; it runs on ${[client.default, ...(client.supported ?? [])].join(' or ')}.`
    );
  return chosen;
}
