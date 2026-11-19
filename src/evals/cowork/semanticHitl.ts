/**
 * The HITL loop of a desktop driven through its accessibility tree: until the
 * bound native session completes, one bounded driver pass at a time. What a
 * pass may press is the driver's policy; how a pass runs is the caller's.
 */
import { setTimeout as delay } from 'node:timers/promises';
import {
  CoworkDriverError,
  CoworkHitlBudgetError,
  CoworkHitlError,
  CoworkUserQuestionError,
  type CoworkDriverOptions,
  type CoworkHitlReceipt,
  type CoworkPendingQuestion,
  type SemanticDesktopTelemetry,
} from './interaction.js';

/** How long a question may stay open after HITL first saw it. */
const QUESTION_ANSWER_TIMEOUT_MS = 60_000;

/** What one driver pass did. */
interface SemanticHitlPass {
  action_count: number;
  /** The scan couldn't finish (too large, or out of time): it saw nothing. */
  scanIncomplete?: boolean;
  /** The pass denied the task's request for a folder of the user's computer. */
  deniedFolderRequest?: boolean;
  /** The pass picked a question's first option, or advanced its page. */
  answered?: boolean;
}

/**
 * Runs one driver pass with at most `maxActions` actions. A pass that fails
 * throws a `CoworkDriverError`, with telemetry when it knows what it did.
 */
export type SemanticHitlRun = (
  mode: 'hitl' | 'answer',
  payload: object,
  maxActions: number
) => Promise<SemanticHitlPass>;

export function semanticTelemetry(
  started: number,
  actions: number,
  accounting: 'complete' | 'partial',
  hitl: {
    incompleteScans: number;
    folderRequestsDenied: number;
    questionsAnswered?: number;
  } = {
    incompleteScans: 0,
    folderRequestsDenied: 0,
  }
): SemanticDesktopTelemetry {
  return {
    accounting,
    duration_ms: Math.max(0, Date.now() - started),
    action_count: actions,
    ...(hitl.incompleteScans > 0
      ? { incomplete_scans: hitl.incompleteScans }
      : {}),
    ...(hitl.folderRequestsDenied > 0
      ? { folder_requests_denied: hitl.folderRequestsDenied }
      : {}),
    ...(hitl.questionsAnswered
      ? { questions_answered: hitl.questionsAnswered }
      : {}),
    planner: { status: 'not-applicable' },
    cost: { status: 'not-applicable' },
  };
}

/** `os` names the desktop in errors: `Linux` or `macOS`. */
export async function handleSemanticHitl(
  options: CoworkDriverOptions,
  run: SemanticHitlRun,
  os: string
): Promise<CoworkHitlReceipt> {
  if (!options.isComplete)
    throw new Error(`${os} HITL requires a bound native completion check.`);
  const started = Date.now();
  let actions = 0;
  // Passes whose scan couldn't finish (they saw no prompt, and HITL went
  // on), and folder requests HITL denied.
  const counts = {
    incompleteScans: 0,
    folderRequestsDenied: 0,
    questionsAnswered: 0,
  };
  // Set while the driver runs: a failure then may have acted on the app.
  let driving = false;
  const budget = options.maxActions ?? 12;
  // Each question HITL has seen (by tool call), and since when.
  const questionsSeen = new Map<string, number>();
  try {
    while (Date.now() < options.deadlineAt) {
      if (await options.isComplete())
        return {
          status: 'hitl_checked',
          action_count: actions,
          telemetry: semanticTelemetry(started, actions, 'complete', counts),
        };
      const question = options.pendingQuestion
        ? await options.pendingQuestion()
        : (await options.awaitingUser?.())
          ? ({ questions: [] } satisfies CoworkPendingQuestion)
          : undefined;
      if (question) {
        if (!question.questions.length)
          throw new CoworkUserQuestionError(
            options.pendingQuestion
              ? 'Cowork is waiting for an answer to a question (AskUserQuestion) that offers no usable options. No resubmission attempted.'
              : 'Cowork is waiting for an answer to a question (AskUserQuestion); a headless run cannot answer it. No resubmission attempted.',
            semanticTelemetry(started, actions, 'partial', counts)
          );
        const key = question.id ?? JSON.stringify(question.questions);
        const since = questionsSeen.get(key) ?? Date.now();
        questionsSeen.set(key, since);
        if (Date.now() - since > QUESTION_ANSWER_TIMEOUT_MS)
          throw new CoworkUserQuestionError(
            `Cowork's question (AskUserQuestion) didn't take its first option within ${QUESTION_ANSWER_TIMEOUT_MS / 1000} s. No resubmission attempted.`,
            semanticTelemetry(started, actions, 'partial', counts)
          );
        if (actions >= budget)
          throw new CoworkHitlBudgetError(
            `${os} HITL action budget exhausted.`,
            semanticTelemetry(started, actions, 'partial', counts)
          );
        // One page per pass: the first option, or the page's Submit/Next
        // once a multi-select option is checked. A pass that finds no
        // unambiguous control acts on nothing and the next looks again.
        driving = true;
        const result = await run(
          'answer',
          { questions: question.questions },
          Math.min(1, budget - actions)
        );
        driving = false;
        actions += result.action_count;
        if (result.answered) counts.questionsAnswered += 1;
        if (result.scanIncomplete) counts.incompleteScans += 1;
        await delay(
          Math.min(1_000, Math.max(0, options.deadlineAt - Date.now()))
        );
        continue;
      }
      if (actions >= budget)
        throw new CoworkHitlBudgetError(
          `${os} HITL action budget exhausted.`,
          semanticTelemetry(started, actions, 'partial', counts)
        );
      driving = true;
      const result = await run(
        'hitl',
        {
          approveWriteTools: options.approveWriteTools === true,
        },
        budget - actions
      );
      driving = false;
      actions += result.action_count;
      if (result.scanIncomplete) counts.incompleteScans += 1;
      if (result.deniedFolderRequest) counts.folderRequestsDenied += 1;
      await delay(Math.min(500, Math.max(0, options.deadlineAt - Date.now())));
    }
  } catch (error) {
    if (
      error instanceof CoworkHitlBudgetError ||
      error instanceof CoworkUserQuestionError
    )
      throw error;
    const partialActions =
      error instanceof CoworkDriverError
        ? (error.telemetry?.action_count ?? 0)
        : 0;
    // A driver call that failed without a receipt may have acted.
    const unknown =
      driving &&
      !(error instanceof CoworkDriverError && error.telemetry !== undefined);
    throw new CoworkHitlError(
      `${os} HITL failed for the bound native session: ${error instanceof Error ? error.message : String(error)}`,
      semanticTelemetry(started, actions + partialActions, 'partial', counts),
      actions + partialActions > 0 || unknown
    );
  }
  throw new CoworkDriverError(
    `${os} HITL deadline exceeded.`,
    semanticTelemetry(started, actions, 'partial', counts)
  );
}
