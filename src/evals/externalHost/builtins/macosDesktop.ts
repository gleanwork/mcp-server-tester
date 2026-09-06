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
const DEFAULT_PASTE_SETTLE_DELAY_MS = 1_500;
const DEFAULT_APP_READY_TIMEOUT_MS = 30_000;
const DEFAULT_APPLESCRIPT_TIMEOUT_MS = 30_000;
const DEFAULT_APPLESCRIPT_MAX_BUFFER = 64 * 1024 * 1024;
const APP_READY_POLL_INTERVAL_MS = 200;

export const MACOS_DESKTOP_CAPABILITIES: ExternalHostCapabilityImplementation[] =
  [
    {
      id: 'builtin:platform.macos',
      capabilities: ['control'],
      setup: requireMacosCapability,
    },
    {
      id: 'builtin:desktop.macos.appLifecycle',
      capabilities: ['control'],
      setup: setupMacosAppLifecycleCapability,
      teardown: teardownMacosAppLifecycleCapability,
    },
    {
      id: 'builtin:desktop.macos.accessibilitySubmit',
      capabilities: ['control', 'input'],
      run: submitPromptCapability,
    },
  ];

export async function runAppleScript(
  script: string,
  options: { timeoutMs?: number; maxBuffer?: number; args?: string[] } = {}
): Promise<string> {
  const result = await execFileAsync(
    'osascript',
    ['-e', script, ...(options.args ?? [])],
    {
      maxBuffer: options.maxBuffer ?? DEFAULT_APPLESCRIPT_MAX_BUFFER,
      timeout: options.timeoutMs ?? DEFAULT_APPLESCRIPT_TIMEOUT_MS,
      killSignal: 'SIGKILL',
    }
  );
  return result.stdout;
}

export async function readMacosAccessibilityDescriptions(
  appName: string
): Promise<string> {
  return runAppleScript(buildMacosAccessibilityDescriptionsScript(appName), {
    timeoutMs: 15_000,
  });
}

export function buildMacosAccessibilityDescriptionsScript(
  appName: string
): string {
  return `
tell application "System Events" to tell process ${JSON.stringify(appName)} to set allElements to entire contents of front window
set textItems to {}
repeat with theElement in allElements
  try
    tell application "System Events" to set elementDescription to description of theElement
    if elementDescription is not missing value and elementDescription is not "" then set end of textItems to (elementDescription as text)
  end try
end repeat
set AppleScript's text item delimiters to linefeed
return textItems as text
`;
}

export async function readMacosAccessibilityText(
  appName: string
): Promise<string> {
  return runAppleScript(buildMacosAccessibilityTextScript(appName));
}

export function buildMacosAccessibilityTextScript(appName: string): string {
  return `
on collectText(theElement)
  set output to {}
  try
    tell application "System Events" to set elementDescription to description of theElement
    if elementDescription is not missing value and elementDescription is not "" then set end of output to (elementDescription as text)
  end try
  try
    tell application "System Events" to set elementTitle to title of theElement
    if elementTitle is not missing value and elementTitle is not "" then set end of output to (elementTitle as text)
  end try
  try
    tell application "System Events" to set elementRole to role of theElement
    tell application "System Events" to set elementValue to value of theElement
    if (elementRole is "AXStaticText" or elementRole is "AXTextArea") and elementValue is not missing value and elementValue is not "" then set end of output to (elementValue as text)
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
}

export async function readMacosFrontWindowContents(
  appName: string
): Promise<string> {
  const script = `tell application "System Events" to tell process ${JSON.stringify(
    appName
  )} to get entire contents of front window`;
  return runAppleScript(script);
}

interface MacosAppLifecycleState {
  appName: string;
  initialProcessIds: number[];
  processIds: number[];
  launchAttempted: boolean;
  quitAfterRun: boolean;
}

export function buildMacosAppLaunchArgs(
  appName: string,
  environment: Record<string, string> = {}
): string[] {
  const environmentArgs = Object.entries(environment).flatMap(
    ([key, value]) => ['--env', `${key}=${value}`]
  );
  return ['--fresh', ...environmentArgs, '-a', appName];
}

async function setupMacosAppLifecycleCapability({
  config,
  run,
  binding,
  state,
}: ExternalHostCapabilityContext): Promise<ExternalHostRunResult | void> {
  const appName =
    runStringOption(config, binding, 'appName') ?? state.displayName;
  const environment = {
    ...stringRecordOption(state.data, 'macosAppEnvironment'),
    ...stringRecordOption(config.options, 'environment'),
    ...stringRecordOption(binding.with, 'environment'),
  };
  const requireFreshInstance =
    runBooleanOption(config, binding, 'requireFreshInstance') ??
    Object.keys(environment).length > 0;
  const quitAfterRun =
    runBooleanOption(config, binding, 'quitAfterRun') ?? true;

  try {
    const initialProcessIds = await listMacosAppProcessIds(appName);
    const running = initialProcessIds.length > 0;
    if (running && requireFreshInstance) {
      return desktopFailureResult({
        config,
        context: run,
        state,
        failureKind: 'submission_failed',
        error: `${appName} is already running, so the requested isolated environment cannot be applied. Quit it or set requireFreshInstance to false to reuse it explicitly.`,
        limitations: [
          'LaunchServices applies environment variables only when it starts a new app process.',
        ],
      });
    }

    const lifecycleState: MacosAppLifecycleState = {
      appName,
      initialProcessIds,
      processIds: [],
      launchAttempted: false,
      quitAfterRun,
    };
    state.data[macosAppLifecycleStateKey(appName)] = lifecycleState;

    if (!running) {
      lifecycleState.launchAttempted = true;
      await execFileAsync(
        '/usr/bin/open',
        buildMacosAppLaunchArgs(appName, environment),
        {
          timeout: 15_000,
        }
      );
      lifecycleState.processIds = await waitForMacosAppStart(
        appName,
        initialProcessIds,
        15_000
      );
    }
  } catch (err) {
    const lifecycleState = state.data[macosAppLifecycleStateKey(appName)] as
      | MacosAppLifecycleState
      | undefined;
    if (lifecycleState?.launchAttempted) {
      lifecycleState.processIds = (
        await listMacosAppProcessIds(appName).catch(() => [])
      ).filter(
        (processId) => !lifecycleState.initialProcessIds.includes(processId)
      );
    }
    return desktopFailureResult({
      config,
      context: run,
      state,
      failureKind: classifyMacosDesktopFailure(formatError(err)),
      error: `Failed to prepare desktop host ${appName}: ${formatError(err)}`,
      limitations: [
        'The host app must be installed and launchable through macOS LaunchServices.',
      ],
    });
  }
}

async function teardownMacosAppLifecycleCapability({
  state,
  binding,
  config,
}: ExternalHostCapabilityContext): Promise<void> {
  const appName =
    runStringOption(config, binding, 'appName') ?? state.displayName;
  const lifecycleState = state.data[macosAppLifecycleStateKey(appName)] as
    | MacosAppLifecycleState
    | undefined;
  if (!lifecycleState || lifecycleState.processIds.length === 0) {
    return;
  }

  if (lifecycleState.quitAfterRun) {
    signalProcesses(lifecycleState.processIds, 'SIGTERM');
    try {
      await waitForProcessesToExit(lifecycleState.processIds, 5_000);
    } catch {
      signalProcesses(lifecycleState.processIds, 'SIGKILL');
      await waitForProcessesToExit(lifecycleState.processIds, 5_000);
    }
  }
}

function macosAppLifecycleStateKey(appName: string): string {
  return `macosAppLifecycle:${appName}`;
}

async function waitForMacosAppStart(
  appName: string,
  initialProcessIds: number[],
  timeoutMs: number
): Promise<number[]> {
  const initial = new Set(initialProcessIds);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const processIds = (await listMacosAppProcessIds(appName)).filter(
      (processId) => !initial.has(processId)
    );
    if (processIds.length > 0) {
      return processIds;
    }
    await delay(100);
  }
  throw new Error(`${appName} did not start within ${timeoutMs}ms`);
}

async function listMacosAppProcessIds(appName: string): Promise<number[]> {
  try {
    const result = await execFileAsync('/usr/bin/pgrep', ['-x', appName], {
      timeout: 5_000,
    });
    return result.stdout
      .trim()
      .split(/\s+/)
      .map(Number)
      .filter(Number.isInteger);
  } catch (err) {
    if (processExitCode(err) === 1) {
      return [];
    }
    throw err;
  }
}

function signalProcesses(processIds: number[], signal: NodeJS.Signals): void {
  for (const processId of processIds) {
    try {
      process.kill(processId, signal);
    } catch (err) {
      if (!isMissingProcessError(err)) {
        throw err;
      }
    }
  }
}

async function waitForProcessesToExit(
  processIds: number[],
  timeoutMs: number
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (processIds.every((processId) => !isProcessRunning(processId))) {
      return;
    }
    await delay(100);
  }
  throw new Error(
    `Processes ${processIds.join(', ')} did not exit within ${timeoutMs}ms`
  );
}

function isProcessRunning(processId: number): boolean {
  try {
    process.kill(processId, 0);
    return true;
  } catch (err) {
    if (isMissingProcessError(err)) {
      return false;
    }
    throw err;
  }
}

function isMissingProcessError(error: unknown): boolean {
  return (
    error instanceof Error &&
    'code' in error &&
    (error as NodeJS.ErrnoException).code === 'ESRCH'
  );
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
      promptElementDescription: runStringOption(
        config,
        binding,
        'promptElementDescription'
      ),
    });
  } catch (err) {
    const message = formatError(err);
    return desktopFailureResult({
      config,
      context: run,
      state,
      failureKind: classifyMacosDesktopFailure(message),
      error: `Failed to submit prompt to desktop host: ${message}`,
      limitations: [
        'The desktop host app must be installed, signed in, and allowed in macOS Automation/Accessibility settings.',
      ],
    });
  }
}

export async function ensureMacosDesktopAppReady(
  appName: string,
  timeoutMs = DEFAULT_APP_READY_TIMEOUT_MS
): Promise<void> {
  await runAppleScript(buildMacosDesktopReadyScript(appName, timeoutMs), {
    timeoutMs: timeoutMs + 5_000,
  });
}

export function buildMacosDesktopReadyScript(
  appName: string,
  timeoutMs: number
): string {
  const attempts = Math.max(
    1,
    Math.ceil(timeoutMs / APP_READY_POLL_INTERVAL_MS)
  );
  const error = `${appName} did not expose a ready window within ${timeoutMs}ms`;

  return `
ignoring application responses
  tell application ${JSON.stringify(appName)} to activate
end ignoring

tell application "System Events"
  set appReady to false
  repeat ${attempts} times
    if exists process ${JSON.stringify(appName)} then
      tell process ${JSON.stringify(appName)}
        if exists window 1 then
          set frontmost to true
          set appReady to true
          exit repeat
        end if
      end tell
    end if
    delay ${APP_READY_POLL_INTERVAL_MS / 1000}
  end repeat
end tell

if not appReady then error ${JSON.stringify(error)}
return "ok"
`;
}

export async function submitPromptToMacosDesktopApp(
  prompt: string,
  options: {
    appName: string;
    createNewConversation: boolean;
    settleDelayMs?: number;
    submitButtonNames?: string[];
    promptElementDescription?: string;
  }
): Promise<void> {
  const settleDelayMs = options.settleDelayMs ?? DEFAULT_SETTLE_DELAY_MS;
  const script = buildMacosDesktopSubmitScript(prompt, {
    ...options,
    settleDelayMs,
  });
  const verificationText =
    prompt
      .split(/\r?\n/)
      .find((line) => line.trim().length > 0)
      ?.trim()
      .slice(0, 80) ?? prompt.slice(0, 80);
  await ensureMacosDesktopAppReady(options.appName);
  await runAppleScript(script, { args: [prompt, verificationText] });
}

export function buildMacosDesktopSubmitScript(
  _prompt: string,
  options: {
    appName: string;
    createNewConversation: boolean;
    settleDelayMs: number;
    submitButtonNames?: string[];
    promptElementDescription?: string;
  }
): string {
  const settleDelayMs = options.settleDelayMs;

  const newConversation = options.createNewConversation
    ? `keystroke "n" using command down
  delay ${Math.max(settleDelayMs, 1500) / 1000}`
    : '';

  const promptElementDescription = options.promptElementDescription;
  const focusPromptElement = promptElementDescription
    ? `tell application "System Events" to tell process ${JSON.stringify(options.appName)}
      set promptElement to my findPromptElement(entire contents of front window, ${JSON.stringify(promptElementDescription)})
    end tell
    if promptElement is missing value then error "Could not focus the expected prompt text area: " & ${JSON.stringify(promptElementDescription)}
    tell application "System Events" to tell promptElement to perform action "AXPress"
    delay 0.5
    tell application "System Events" to tell process ${JSON.stringify(options.appName)}
      keystroke "a" using command down
      key code 51
    end tell`
    : '';
  const verifyPromptElement = promptElementDescription
    ? `tell application "System Events" to set promptElementValue to value of promptElement
    if promptElementValue is missing value then error "Expected prompt text area had no value after paste: " & ${JSON.stringify(promptElementDescription)}
    if (promptElementValue as text) does not contain verificationText then error "Pasted prompt was not found in the expected prompt text area: " & ${JSON.stringify(promptElementDescription)}`
    : '';

  return `
on findPromptElement(theElements, expectedDescription)
  repeat with theElement in theElements
    try
      tell application "System Events" to set elementRole to role of theElement
      tell application "System Events" to set elementDescription to description of theElement
      if elementRole is "AXTextArea" and elementDescription contains expectedDescription then return theElement
    end try
  end repeat
  return missing value
end findPromptElement

on run argv
  set promptText to item 1 of argv
  set verificationText to item 2 of argv
  set previousClipboard to the clipboard
  try
    tell application ${JSON.stringify(options.appName)} to activate
    delay ${settleDelayMs / 1000}

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

    tell application "System Events" to tell process ${JSON.stringify(options.appName)}
      ${newConversation}
    end tell
    ${focusPromptElement}

    set the clipboard to promptText
    tell application "System Events" to tell process ${JSON.stringify(options.appName)}
      keystroke "v" using command down
    end tell
    delay ${DEFAULT_PASTE_SETTLE_DELAY_MS / 1000}
    ${verifyPromptElement}

    tell application "System Events" to tell process ${JSON.stringify(options.appName)}
      key code 36
    end tell
    set the clipboard to previousClipboard
  on error errorMessage number errorNumber
    set the clipboard to previousClipboard
    error errorMessage number errorNumber
  end try
end run
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

function runBooleanOption(
  config: { options?: Record<string, unknown> },
  binding: { with?: Record<string, unknown> },
  key: string
): boolean | undefined {
  const value = binding.with?.[key];
  if (typeof value === 'boolean') {
    return value;
  }
  const configValue = config.options?.[key];
  return typeof configValue === 'boolean' ? configValue : undefined;
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

export function classifyMacosDesktopFailure(
  message: string
): ExternalHostFailureKind {
  const lower = message.toLowerCase();
  if (
    lower.includes('not authorized') ||
    lower.includes('not permitted') ||
    lower.includes('assistive access') ||
    lower.includes('not allowed to send apple events') ||
    lower.includes('-1743')
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

function stringRecordOption(
  options: Record<string, unknown> | undefined,
  key: string
): Record<string, string> | undefined {
  const value = options?.[key];
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return undefined;
  }
  const entries = Object.entries(value);
  if (!entries.every(([, entry]) => typeof entry === 'string')) {
    return undefined;
  }
  return Object.fromEntries(entries) as Record<string, string>;
}

function processExitCode(err: unknown): string | number | undefined {
  if (typeof err !== 'object' || err === null || !('code' in err)) {
    return undefined;
  }
  const code = err.code;
  return typeof code === 'string' || typeof code === 'number'
    ? code
    : undefined;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function formatError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
