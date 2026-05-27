import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type {
  ExternalHostCapabilityContext,
  ExternalHostCapabilityImplementation,
  ExternalHostFailureKind,
  ExternalHostRunResult,
} from '../types.js';
import { driverToSlug, hostTypeFromDriver } from '../driverIdentity.js';

const execFileAsync = promisify(execFile);
const DEFAULT_SETTLE_DELAY_MS = 500;
const DEFAULT_APPLESCRIPT_TIMEOUT_MS = 30_000;
const DEFAULT_APPLESCRIPT_MAX_BUFFER = 64 * 1024 * 1024;

export const MACOS_DESKTOP_CAPABILITIES: ExternalHostCapabilityImplementation[] =
  [
    {
      id: 'builtin:platform.macos',
      capabilities: ['control'],
      run: requireMacosCapability,
    },
    {
      id: 'builtin:desktop.macos.accessibilitySubmit',
      capabilities: ['control', 'input'],
      run: submitPromptCapability,
    },
    {
      id: 'builtin:desktop.macos.wakeAccessibility',
      capabilities: ['control'],
      run: wakeAccessibilityCapability,
    },
  ];

export async function runAppleScript(
  script: string,
  options: { timeoutMs?: number; maxBuffer?: number } = {}
): Promise<string> {
  const result = await execFileAsync('osascript', ['-e', script], {
    maxBuffer: options.maxBuffer ?? DEFAULT_APPLESCRIPT_MAX_BUFFER,
    timeout: options.timeoutMs ?? DEFAULT_APPLESCRIPT_TIMEOUT_MS,
    killSignal: 'SIGKILL',
  });
  return result.stdout;
}

export function writeMacosClipboard(value: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = execFile('pbcopy', (error) => {
      if (error) {
        reject(new Error(error.message));
        return;
      }
      resolve();
    });
    child.stdin?.end(value);
  });
}

export async function readMacosAccessibilityText(
  appName: string
): Promise<string> {
  const script = `
on collectText(theElement)
  set output to {}
  try
    tell application "System Events" to set elementRole to role of theElement
    tell application "System Events" to set elementValue to value of theElement
    if (elementRole is "AXStaticText" or elementRole is "AXTextArea") and elementValue is not missing value then set end of output to (elementValue as text)
  end try
  try
    tell application "System Events" to set uiChildren to UI elements of theElement
    repeat with childElement in uiChildren
      set output to output & my collectText(childElement)
    end repeat
  end try
  return output
end collectText

tell application "System Events" to tell process ${JSON.stringify(appName)}
  set textItems to my collectText(front window)
end tell
set AppleScript's text item delimiters to linefeed
return textItems as text
`;
  return runAppleScript(script);
}

export async function readMacosFrontWindowContents(
  appName: string
): Promise<string> {
  const script = `tell application "System Events" to tell process ${JSON.stringify(
    appName
  )} to get entire contents of front window`;
  return runAppleScript(script);
}

/**
 * Forces a Chromium-based app (Electron) to populate its accessibility tree by
 * activating the app and simulating a click in the lower-center of the front
 * window — the area where chat composers typically live. Without this, the AX
 * tree exposes only window chrome (close/minimize buttons) and downstream
 * findTextArea/findSubmitButton calls fail with "no composer found".
 */
export async function wakeMacosAccessibility(
  appName: string,
  options: { settleDelayMs?: number } = {}
): Promise<void> {
  const settleDelayMs = options.settleDelayMs ?? 800;
  const script = `
tell application ${JSON.stringify(appName)} to activate
delay 0.3
tell application "System Events"
  tell process ${JSON.stringify(appName)}
    set frontmost to true
    set winPos to position of front window
    set winSize to size of front window
    set centerX to (item 1 of winPos) + (item 1 of winSize) / 2
    set composerY to (item 2 of winPos) + (item 2 of winSize) - 90
    click at {centerX as integer, composerY as integer}
  end tell
end tell
delay ${settleDelayMs / 1000}
return "ok"
`;
  await runAppleScript(script, { timeoutMs: 10_000 });
}

async function wakeAccessibilityCapability({
  config,
  run,
  binding,
  state,
}: ExternalHostCapabilityContext): Promise<ExternalHostRunResult | void> {
  try {
    const appName =
      runStringOption(config, binding, 'appName') ?? state.displayName;
    await wakeMacosAccessibility(appName, {
      settleDelayMs: runNumberOption(config, binding, 'settleDelayMs'),
    });
  } catch (err) {
    return desktopFailureResult({
      config,
      context: run,
      state,
      failureKind: classifyDesktopSubmissionFailure(formatError(err)),
      error: `Failed to wake macOS accessibility tree: ${formatError(err)}`,
      limitations: [
        'Chromium/Electron apps require a real mouse interaction before the macOS accessibility tree is populated.',
      ],
    });
  }
}

async function requireMacosCapability({
  config,
  run,
  binding,
  state,
}: ExternalHostCapabilityContext): Promise<ExternalHostRunResult | void> {
  if (process.platform === 'darwin') {
    return;
  }

  return desktopFailureResult({
    config,
    context: run,
    state,
    failureKind: 'unsupported_host',
    error:
      stringOption(binding.with, 'error') ??
      `${state.displayName} currently requires macOS automation support.`,
    limitations: [
      stringOption(binding.with, 'limitation') ??
        'Windows UI Automation support has not been added yet.',
    ],
  });
}

async function submitPromptCapability({
  config,
  run,
  binding,
  state,
}: ExternalHostCapabilityContext): Promise<ExternalHostRunResult | void> {
  try {
    const appName =
      runStringOption(config, binding, 'appName') ?? state.displayName;
    await submitPromptToMacosDesktopApp(run.submittedScenario, {
      appName,
      createNewConversation: shouldCreateNewConversation(
        binding.with?.createNewConversation,
        config
      ),
      settleDelayMs: runNumberOption(config, binding, 'settleDelayMs'),
      submitButtonNames: stringArrayOption(binding.with, 'submitButtonNames'),
    });
  } catch (err) {
    const message = formatError(err);
    return desktopFailureResult({
      config,
      context: run,
      state,
      failureKind: classifyDesktopSubmissionFailure(message),
      error: `Failed to submit prompt to desktop host: ${message}`,
      limitations: [
        'The desktop host app must be installed, signed in, and allowed in macOS Automation/Accessibility settings.',
      ],
    });
  }
}

export async function submitPromptToMacosDesktopApp(
  prompt: string,
  options: {
    appName: string;
    createNewConversation: boolean;
    settleDelayMs?: number;
    submitButtonNames?: string[];
  }
): Promise<void> {
  const settleDelayMs = options.settleDelayMs ?? DEFAULT_SETTLE_DELAY_MS;
  const script = buildMacosDesktopSubmitScript(prompt, {
    ...options,
    settleDelayMs,
  });
  await writeMacosClipboard(prompt);
  await runAppleScript(script);
}

export function buildMacosDesktopSubmitScript(
  _prompt: string,
  options: {
    appName: string;
    createNewConversation: boolean;
    settleDelayMs: number;
    submitButtonNames?: string[];
  }
): string {
  const settleDelayMs = options.settleDelayMs;

  const newConversation = options.createNewConversation
    ? `keystroke "n" using command down
  delay ${Math.max(settleDelayMs, 1500) / 1000}`
    : '';

  return `
tell application ${JSON.stringify(options.appName)} to activate
delay ${settleDelayMs / 1000}
tell application "System Events"
  ${newConversation}
  tell process ${JSON.stringify(options.appName)}
    set frontmost to true
    -- Click the lower-center of the front window where chat composers live.
    -- This focuses the composer AND wakes the Chromium AX tree as a side
    -- effect. Using a coordinate-based click avoids fragile recursive
    -- searches for AXTextArea — Cowork's composer may use a different role
    -- (AXTextField, AXTextInput) depending on Electron/Claude version.
    set winPos to position of front window
    set winSize to size of front window
    set centerX to (item 1 of winPos) + (item 1 of winSize) / 2
    set composerY to (item 2 of winPos) + (item 2 of winSize) - 90
    click at {centerX as integer, composerY as integer}
    delay 0.6
  end tell
  -- Paste the prompt from clipboard. The caller has already written the
  -- prompt to the macOS clipboard via writeMacosClipboard.
  keystroke "v" using command down
  delay 0.4
  -- Submit via Return.
  key code 36
end tell
`;
}

function shouldCreateNewConversation(
  option: unknown,
  config: { options?: Record<string, unknown> }
): boolean {
  if (option === 'unless-disabled') {
    return configStringOption(config, 'newConversationShortcut') !== 'none';
  }
  return option === true;
}

function desktopFailureResult({
  config,
  context,
  state,
  failureKind,
  error,
  limitations,
}: {
  config: ExternalHostCapabilityContext['config'];
  context: ExternalHostCapabilityContext['run'];
  state: ExternalHostCapabilityContext['state'];
  failureKind: ExternalHostFailureKind;
  error: string;
  limitations: string[];
}): ExternalHostRunResult {
  return {
    success: false,
    toolCalls: [],
    error,
    externalHost: {
      driver: state.driver,
      driverSlug: driverToSlug(state.driver),
      displayName: state.displayName,
      hostName: state.displayName,
      hostType: config.hostType ?? hostTypeFromDriver(state.driver),
      hostVariant: config.variant,
      capabilitiesUsed: state.capabilitiesUsed,
      traceSource: 'none',
      traceConfidence: 'unknown',
      traceLimitations: limitations,
      artifacts: [],
      session: { runMarker: context.marker },
      correlation: context.correlation,
      failureKind,
    },
  };
}

function runStringOption(
  config: { options?: Record<string, unknown> },
  binding: { with?: Record<string, unknown> },
  key: string
): string | undefined {
  return stringOption(binding.with, key) ?? configStringOption(config, key);
}

function runNumberOption(
  config: { options?: Record<string, unknown> },
  binding: { with?: Record<string, unknown> },
  key: string
): number | undefined {
  const value = binding.with?.[key];
  return typeof value === 'number' ? value : configNumberOption(config, key);
}

function configStringOption(
  config: { options?: Record<string, unknown> },
  key: string
): string | undefined {
  return stringOption(config.options, key);
}

function configNumberOption(
  config: { options?: Record<string, unknown> },
  key: string
): number | undefined {
  const value = config.options?.[key];
  return typeof value === 'number' ? value : undefined;
}

function stringOption(
  options: Record<string, unknown> | undefined,
  key: string
): string | undefined {
  const value = options?.[key];
  return typeof value === 'string' ? value : undefined;
}

function stringArrayOption(
  options: Record<string, unknown> | undefined,
  key: string
): string[] | undefined {
  const value = options?.[key];
  if (!Array.isArray(value)) {
    return undefined;
  }
  const strings = value.filter(
    (item): item is string => typeof item === 'string'
  );
  return strings.length > 0 ? strings : undefined;
}

function classifyDesktopSubmissionFailure(
  message: string
): ExternalHostFailureKind {
  const lower = message.toLowerCase();
  if (
    lower.includes('not authorized') ||
    lower.includes('not permitted') ||
    lower.includes('assistive access') ||
    lower.includes('accessibility') ||
    lower.includes('automation')
  ) {
    return 'automation_permission_denied';
  }
  if (
    lower.includes('can’t get application') ||
    lower.includes("can't get application") ||
    lower.includes('application isn’t running') ||
    lower.includes("application isn't running")
  ) {
    return 'app_unavailable';
  }
  return 'submission_failed';
}

function formatError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
