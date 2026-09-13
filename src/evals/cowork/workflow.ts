import { setTimeout as sleep } from 'node:timers/promises';
import {
  errorMessage,
  isFatalControlError,
  isRecord,
  remaining,
} from './deadline.js';
import type {
  CoworkComposerVerification,
  CoworkControl,
  CoworkControlState,
  CoworkInputMode,
} from './types.js';

/** Defaults to a fatal refusal without quarantine. Uncertainty requires quarantine. */
export class CoworkControlError extends Error {
  readonly fatal: boolean;
  readonly quarantine: boolean;

  constructor(
    message: string,
    options: {
      fatal?: boolean;
      /** External state may still change. Implies fatal; the host must not retry. */
      quarantine?: boolean;
    } = {}
  ) {
    super(message);
    this.name = 'CoworkControlError';
    this.quarantine = options.quarantine ?? false;
    this.fatal = this.quarantine || (options.fatal ?? true);
  }
}

/** Recognize explicit safe failures across separately loaded ESM/CJS copies. */
export function isCoworkControlError(
  error: unknown
): error is CoworkControlError {
  try {
    return (
      isRecord(error) &&
      error.name === 'CoworkControlError' &&
      typeof error.fatal === 'boolean' &&
      typeof error.quarantine === 'boolean'
    );
  } catch {
    return false;
  }
}

interface SubmissionDetails {
  inputMode: CoworkInputMode;
  verification: CoworkComposerVerification;
}

/** Verify a fresh task and persist the checkpoint before the only submit attempt. */
export async function submitCoworkPrompt(options: {
  control: CoworkControl;
  text: string;
  deadline: number;
  pollIntervalMs: number;
  beforeSubmit(this: void, details: SubmissionDetails): Promise<void>;
}): Promise<SubmissionDetails & { acknowledgementError?: string }> {
  const { control, text, deadline, pollIntervalMs, beforeSubmit } = options;
  const openDeadline = Math.min(Date.now() + 15_000, deadline);
  remaining(deadline);
  await control.openUrl('claude://cowork/new');
  let draft: CoworkControlState | undefined;
  while (Date.now() < openDeadline) {
    const state = await control.observe();
    if (state.composer && isFreshTask(state.pageUrl)) {
      draft = state;
      break;
    }
    await sleep(
      Math.min(pollIntervalMs, Math.max(1, openDeadline - Date.now()))
    );
  }
  if (!draft) throw new Error('fresh task URL and composer were not verified');
  // Observe only: never open approval menus or grant permissions.
  if (!draft.automaticallyApprove)
    throw new Error('fresh task did not inherit Automatically approve');

  let inputMode: CoworkInputMode = 'accessibility';
  let verification: CoworkComposerVerification | null = null;
  let pasteError: string | undefined;
  try {
    remaining(deadline);
    await control.paste(text);
    verification = matchesComposer(
      (await control.observe()).composer?.value,
      text
    );
    if (verification) inputMode = 'keyboard';
    else pasteError = 'pasted composer value did not match';
  } catch (error) {
    if (isFatalControlError(error)) throw error;
    pasteError = errorMessage(error);
  }
  if (inputMode !== 'keyboard') {
    // A fresh task may retain a draft. Replace it; do not require Home/empty AXValue.
    remaining(deadline);
    try {
      await control.setValue(text);
    } catch (error) {
      throw new Error(
        `${errorMessage(error)}; keyboard fill failed first: ${pasteError}`
      );
    }
    verification = matchesComposer(
      (await control.observe()).composer?.value,
      text
    );
    if (!verification)
      throw new Error(
        `composer did not contain the prompt; keyboard: ${pasteError}`
      );
  }
  if (!verification) throw new Error('composer verification unavailable');
  const current = await control.observe();
  if (
    !isFreshTask(current.pageUrl) ||
    !current.automaticallyApprove ||
    !matchesComposer(current.composer?.value, text)
  ) {
    throw new Error(
      'fresh task route, approval mode, or composer changed before submit'
    );
  }
  remaining(deadline);
  await beforeSubmit({ inputMode, verification });
  remaining(deadline);
  let acknowledgementError: string | undefined;
  try {
    if (inputMode === 'keyboard') await control.pressReturn();
    else await control.clickSend();
  } catch (error) {
    // Never click Send after a Return error. The first submission may be pending.
    acknowledgementError = errorMessage(error);
  }
  return { inputMode, verification, acknowledgementError };
}

function isFreshTask(url: string | undefined): boolean {
  return /^(?:https?:\/\/)?claude\.ai\/new(?:[/?#]|$)/i.test(url ?? '');
}

function normalize(value: string | undefined): string {
  return (value ?? '').replace(/\s+/g, ' ').trim();
}

function matchesComposer(
  value: string | undefined,
  original: string
): CoworkComposerVerification | null {
  const observed = normalize(value);
  const expected = normalize(original);
  if (observed === expected) return 'normalized-full';
  if (
    /\r|\n/.test(original) &&
    observed &&
    observed === normalize(original.split(/\r?\n/, 1)[0])
  )
    return 'first-line';
  const prefix = observed.replace(/(?:\s*(?:…|\.\.\.))$/, '').trimEnd();
  if (
    expected.length > 160 &&
    prefix.length >= 160 &&
    expected.startsWith(prefix)
  )
    return 'long-prefix';
  return null;
}
