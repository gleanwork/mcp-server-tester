import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  actOnMacComputerUseNode,
  getMacComputerUseRuntime,
  observeMacComputerUseApp,
  type MacComputerUseApp,
  type MacComputerUseObservation,
  type MacComputerUseRuntime,
  waitForMacComputerUseText,
} from './macComputerUse.js';

const execFileAsync = promisify(execFile);
const DEFAULT_FRESH_COMPOSER_TIMEOUT_MS = 15_000;
const MAX_ACCESSIBILITY_VERIFIED_VALUE_LENGTH = 160;
const COWORK_COMPOSER_SELECTOR = /^text (?:entry )?area\b/i;
const COWORK_SEND_SELECTOR =
  /^button (?:Send message|Send|Submit|Start task)(?:,|$)/i;

export type MacCoworkPhase =
  | 'created'
  | 'composer_ready'
  | 'armed'
  | 'submitted'
  | 'session_bound'
  | 'terminal'
  | 'failed';

export interface MacCoworkCheckpoint {
  phase: MacCoworkPhase;
  appName: string;
  prompt: string;
  marker: string;
  startedAt?: string;
  submittedAt?: string;
  sessionId?: string;
  submissionMode?: 'computer-use-set-value';
  submissionConfidence?: 'high' | 'ambiguous';
  error?: string;
}

export interface MacCoworkSubmissionOptions {
  appName: string;
  marker: string;
  openFreshComposer?: boolean;
  freshComposerTimeoutMs?: number;
  deadlineAt?: number;
  computerUseProvider?: string;
  runtime?: MacComputerUseRuntime;
  openUrl?: (url: string) => Promise<void>;
  dependencies?: Partial<MacCoworkDependencies>;
}

export interface MacCoworkDependencies {
  ensureReady: typeof ensureMacComputerUseApp;
  openFreshComposer: typeof openFreshMacCoworkComposer;
  setComposerValue: typeof setMacCoworkComposerValue;
  submitDraft: typeof clickMacCoworkSend;
  observe: typeof observeMacComputerUseApp;
}

export interface MacCoworkSubmissionResult {
  checkpoint: MacCoworkCheckpoint;
  visibleText?: string;
}

export async function submitMacCoworkPrompt(
  prompt: string,
  options: MacCoworkSubmissionOptions
): Promise<MacCoworkSubmissionResult> {
  if (!prompt.trim()) throw new Error('Cowork prompt must be non-empty text.');

  const checkpoint: MacCoworkCheckpoint = {
    phase: 'created',
    appName: options.appName,
    prompt,
    marker: options.marker,
  };
  const deadlineAt = options.deadlineAt ?? Date.now() + 120_000;
  const runtime =
    options.runtime ?? getMacComputerUseRuntime(options.computerUseProvider);
  const dependencies = options.dependencies ?? {};
  const ensureReady = dependencies.ensureReady ?? ensureMacComputerUseApp;
  const openFreshComposer =
    dependencies.openFreshComposer ?? openFreshMacCoworkComposer;
  const setComposerValue =
    dependencies.setComposerValue ?? setMacCoworkComposerValue;
  const submitDraft = dependencies.submitDraft ?? clickMacCoworkSend;
  const observe = dependencies.observe ?? observeMacComputerUseApp;
  const app = await runtime.getApp(options.appName);

  try {
    await assertBeforeDeadline(deadlineAt, 'before opening Cowork');
    await ensureReady(app, deadlineAt);

    if (options.openFreshComposer !== false) {
      await openFreshComposer(options.appName, {
        app,
        runtime,
        timeoutMs: Math.min(
          options.freshComposerTimeoutMs ?? DEFAULT_FRESH_COMPOSER_TIMEOUT_MS,
          remainingMs(deadlineAt)
        ),
        deadlineAt,
        openUrl: options.openUrl,
      });
    }
    checkpoint.phase = 'composer_ready';

    await setComposerValue(app, prompt, { deadlineAt });
    const afterSet = await observe(app);
    if (!accessibilityTextContainsPrompt(afterSet.text, prompt)) {
      throw new Error(
        `Cowork composer did not contain the submitted prompt after Computer Use setValue (marker=${options.marker}).`
      );
    }

    // This is the at-most-once boundary. Any failure after this point must reconcile
    // native session evidence rather than invoke Computer Use submission again.
    checkpoint.phase = 'armed';
    checkpoint.startedAt = new Date().toISOString();
    checkpoint.submissionMode = 'computer-use-set-value';
    await assertBeforeDeadline(deadlineAt, 'before submitting Cowork');

    try {
      await submitDraft(app);
      checkpoint.submissionConfidence = 'high';
    } catch (error) {
      const current = await observe(app).catch(() => ({ text: '', nodes: [] }));
      if (accessibilityTextContainsPrompt(current.text, prompt)) throw error;
      checkpoint.submissionConfidence = 'ambiguous';
    }

    checkpoint.phase = 'submitted';
    checkpoint.submittedAt = new Date().toISOString();
    return { checkpoint, visibleText: afterSet.text };
  } catch (error) {
    checkpoint.phase = 'failed';
    checkpoint.error = formatError(error);
    throw Object.assign(new Error(checkpoint.error), { checkpoint });
  }
}

export async function ensureMacComputerUseApp(
  app: MacComputerUseApp,
  deadlineAt: number
): Promise<MacComputerUseObservation> {
  return waitForMacComputerUseText(
    app,
    (observation) =>
      observation.nodes.length > 0 || observation.text.length > 0,
    { deadlineAt }
  );
}

export async function openFreshMacCoworkComposer(
  appName: string,
  options: {
    app?: MacComputerUseApp;
    runtime?: MacComputerUseRuntime;
    timeoutMs?: number;
    deadlineAt?: number;
    openUrl?: (url: string) => Promise<void>;
  } = {}
): Promise<string> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_FRESH_COMPOSER_TIMEOUT_MS;
  const deadlineAt = Math.min(
    options.deadlineAt ?? Date.now() + timeoutMs,
    Date.now() + timeoutMs
  );
  const app =
    options.app ??
    (await (options.runtime ?? getMacComputerUseRuntime()).getApp(appName));
  await assertBeforeDeadline(
    deadlineAt,
    'before opening a fresh Cowork composer'
  );
  await (options.openUrl ?? openMacExternalUrl)('claude://cowork/new');

  const observation = await waitForMacComputerUseText(
    app,
    (current) => isFreshMacCoworkComposerText(current.text),
    { deadlineAt }
  );
  return observation.text;
}

export function isFreshMacCoworkComposerText(text: string): boolean {
  return (
    text.includes('Write your prompt to Claude') &&
    (text.includes('Automatically approve') ||
      text.includes('Manually approve'))
  );
}

export function accessibilityTextContainsPrompt(
  text: string,
  prompt: string
): boolean {
  const normalizedText = normalizeAccessibleText(text);
  const normalizedPrompt = normalizeAccessibleText(prompt);
  if (!normalizedPrompt) return false;
  if (normalizedPrompt.length <= MAX_ACCESSIBILITY_VERIFIED_VALUE_LENGTH) {
    return normalizedText.includes(normalizedPrompt);
  }
  return (
    normalizedText.includes(normalizedPrompt.slice(0, 80)) &&
    normalizedText.includes(normalizedPrompt.slice(-80))
  );
}

export async function setMacCoworkComposerValue(
  app: MacComputerUseApp,
  prompt: string,
  options: { deadlineAt: number }
): Promise<void> {
  await assertBeforeDeadline(
    options.deadlineAt,
    'before setting the Cowork composer'
  );
  await actOnMacComputerUseNode(
    app,
    COWORK_COMPOSER_SELECTOR,
    (node) => app.setValue(node.index, prompt),
    {
      verify: (observation) =>
        accessibilityTextContainsPrompt(observation.text, prompt),
    }
  );
}

export async function clickMacCoworkSend(
  app: MacComputerUseApp
): Promise<void> {
  await actOnMacComputerUseNode(
    app,
    COWORK_SEND_SELECTOR,
    (node) => app.click(node.index),
    {
      retries: 0,
    }
  );
}

export async function openMacExternalUrl(url: string): Promise<void> {
  await execFileAsync('/usr/bin/open', [url], { timeout: 15_000 });
}

function normalizeAccessibleText(value: string): string {
  return String(value ?? '')
    .replaceAll(/\s+/g, ' ')
    .trim();
}

function remainingMs(deadlineAt: number): number {
  return Math.max(1, deadlineAt - Date.now());
}

async function assertBeforeDeadline(
  deadlineAt: number,
  stage: string
): Promise<void> {
  if (Date.now() >= deadlineAt)
    throw new Error(`Cowork deadline expired ${stage}.`);
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
