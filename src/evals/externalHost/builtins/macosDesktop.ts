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
const DEFAULT_SUBMIT_BUTTON_NAMES = ['Send', 'Submit'];

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

export async function runAppleScript(script: string): Promise<string> {
  const result = await execFileAsync('osascript', ['-e', script]);
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
  prompt: string,
  options: {
    appName: string;
    createNewConversation: boolean;
    settleDelayMs: number;
    submitButtonNames?: string[];
  }
): string {
  const settleDelayMs = options.settleDelayMs;
  const promptLiteral = JSON.stringify(prompt);
  const verificationNeedle = prompt.includes('[eval-run-marker:')
    ? '[eval-run-marker:'
    : prompt.trim().slice(0, 120);
  const verificationNeedleLiteral = JSON.stringify(verificationNeedle);
  const submitButtonNamesLiteral = appleScriptListLiteral(
    options.submitButtonNames?.length
      ? options.submitButtonNames
      : DEFAULT_SUBMIT_BUTTON_NAMES
  );

  const newConversation = options.createNewConversation
    ? `keystroke "n" using command down
  delay ${Math.max(settleDelayMs, 1500) / 1000}`
    : '';

  return `
on findTextArea(theElement)
  try
    tell application "System Events" to if role of theElement is "AXTextArea" then return theElement
  end try
  try
    tell application "System Events" to set uiChildren to UI elements of theElement
    repeat with childElement in uiChildren
      set foundElement to my findTextArea(childElement)
      if foundElement is not equal to missing value then return foundElement
    end repeat
  end try
  return missing value
end findTextArea

on normalizeText(valueToNormalize)
  try
    return my lowercaseText(valueToNormalize as text)
  on error
    return ""
  end try
end normalizeText

on lowercaseText(inputText)
  set upperChars to "ABCDEFGHIJKLMNOPQRSTUVWXYZ"
  set lowerChars to "abcdefghijklmnopqrstuvwxyz"
  set outputText to ""
  repeat with currentChar in characters of inputText
    set currentCharText to currentChar as text
    set charIndex to offset of currentCharText in upperChars
    if charIndex is greater than 0 then
      set outputText to outputText & character charIndex of lowerChars
    else
      set outputText to outputText & currentCharText
    end if
  end repeat
  return outputText
end lowercaseText

on elementLabel(theElement)
  set labels to {}
  try
    tell application "System Events" to if name of theElement is not missing value then set end of labels to name of theElement
  end try
  try
    tell application "System Events" to if description of theElement is not missing value then set end of labels to description of theElement
  end try
  try
    tell application "System Events" to if value of theElement is not missing value then set end of labels to value of theElement
  end try
  set AppleScript's text item delimiters to " "
  return my normalizeText(labels as text)
end elementLabel

on labelMatches(theElement, buttonNames)
  set labelText to my elementLabel(theElement)
  repeat with buttonName in buttonNames
    if labelText contains my normalizeText(buttonName) then return true
  end repeat
  return false
end labelMatches

on findSubmitButton(theElement, buttonNames)
  try
    tell application "System Events" to if role of theElement is "AXButton" and my labelMatches(theElement, buttonNames) then return theElement
  end try
  try
    tell application "System Events" to set uiChildren to UI elements of theElement
    repeat with childElement in uiChildren
      set foundElement to my findSubmitButton(childElement, buttonNames)
      if foundElement is not equal to missing value then return foundElement
    end repeat
  end try
  return missing value
end findSubmitButton

tell application ${JSON.stringify(options.appName)} to activate
delay ${settleDelayMs / 1000}
tell application "System Events"
  ${newConversation}
  tell process ${JSON.stringify(options.appName)}
    set frontmost to true
    set textAreaElement to my findTextArea(front window)
    if textAreaElement is equal to missing value then error "No composer text area found"
    click textAreaElement
    try
      set focused of textAreaElement to true
    end try
    try
      set value of textAreaElement to ${promptLiteral}
    end try
  end tell
  delay 0.1
  tell process ${JSON.stringify(options.appName)}
    set textAreaElement to my findTextArea(front window)
    if textAreaElement is equal to missing value then error "No composer text area found before submit"
    if value of textAreaElement does not contain ${verificationNeedleLiteral} then
      set frontmost to true
      click textAreaElement
      try
        set focused of textAreaElement to true
      end try
      keystroke "v" using command down
      delay 0.5
    end if
    if value of textAreaElement does not contain ${verificationNeedleLiteral} then error "Composer did not receive pasted eval prompt"
    set submitButtonElement to my findSubmitButton(front window, ${submitButtonNamesLiteral})
    if submitButtonElement is not equal to missing value then
      perform action "AXPress" of submitButtonElement
    else
      set frontmost to true
      click textAreaElement
      try
        set focused of textAreaElement to true
      end try
      key code 36
    end if
  end tell
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

function appleScriptListLiteral(values: string[]): string {
  return `{${values.map((value) => JSON.stringify(value)).join(', ')}}`;
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
