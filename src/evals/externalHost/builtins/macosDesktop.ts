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

-- Verify the app actually came to the foreground. tell-to-activate is
-- unreliable on multi-monitor / multi-Space setups when another app
-- (browser, terminal, etc.) holds focus-prevention precedence. Retry
-- bringing the app forward up to ~2 seconds; fail fast with a clear
-- error if the OS refuses, since otherwise our keystrokes route to
-- whatever app actually has focus and the eval times out 90s later.
set activated to false
repeat 10 times
  tell application "System Events" to tell process ${JSON.stringify(options.appName)}
    if frontmost then
      set activated to true
      exit repeat
    end if
    try
      set frontmost to true
    end try
  end tell
  delay 0.2
end repeat
if not activated then
  error ${JSON.stringify(options.appName)} & " could not be brought to the foreground (focus is held by another app); keystrokes would route to the wrong app"
end if

tell application "System Events"
  -- Force a known-focus state by opening a new conversation. Chromium's React
  -- app autofocuses the composer on a fresh chat view, even though
  -- AXFocusedUIElement doesn't expose that state to AppleScript. This avoids
  -- coordinate-based clicks that are fragile to window position, monitor
  -- placement, or layout drift.
  ${newConversation}
  -- Paste the prompt from clipboard. The caller has already written the
  -- prompt to the macOS clipboard via writeMacosClipboard. The keystroke
  -- routes to whatever has DOM focus inside the active window.
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
