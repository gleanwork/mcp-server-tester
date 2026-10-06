/**
 * Agent judge runtimes.
 *
 * An agentic judge does not get the whole trace in one prompt. It gets a
 * read-only workspace of the run's evidence and works through it over several
 * turns with tools, the way a reviewer would. A runtime is the agent loop that
 * does this; judges never import an agent SDK, so a judge can move from one
 * runtime to another by configuration alone.
 *
 * Every runtime must:
 * - start in the workspace and be unable to write to it or outside it;
 * - have no network access from its tools;
 * - not read the caller's settings, memory, skills or instructions files;
 * - get only the environment variables the runtime itself needs.
 */

import type { UsageMetrics } from '../judgeTypes.js';

/** One agentic judge run. */
export interface AgentJudgeTask {
  /** The workspace the agent starts in and is confined to. */
  workspace: string;
  /** System instructions. Runtimes without a system role prepend them. */
  system?: string;
  /** The user message. */
  prompt: string;
  model?: string;
  /** Reasoning effort, such as `low`, `medium` or `high`. */
  effort?: string;
  /** Upper bound on agent turns. */
  maxTurns: number;
  /** Upper bound on spend, where the runtime can enforce one. */
  maxBudgetUsd?: number;
  /** Wall-clock limit in milliseconds. */
  timeoutMs: number;
  /** JSON Schema of the final answer, where the runtime can enforce one. */
  outputSchema?: Record<string, unknown>;
  /**
   * Plugin helper programs the agent may run. A runtime with a sandboxed
   * shell runs them there; one without offers each as a tool.
   */
  commands?: readonly WorkspaceCommand[];
}

/** A plugin helper program, such as a trace parser in the workspace. */
export interface WorkspaceCommand {
  /** Tool name, such as `trace`. */
  name: string;
  description: string;
  /** Program and leading arguments, such as `['python3', 'scripts/trace.py']`. */
  argv: readonly string[];
  /** Per-call limit. Default 60 s. */
  timeoutMs?: number;
}

/** One tool call the agent made, for audit. Output is truncated. */
export interface AgentJudgeStep {
  tool: string;
  input?: string;
  output?: string;
  isError?: boolean;
}

/** What a runtime returns. */
export interface AgentJudgeResult {
  /** The agent's final message. */
  text: string;
  /** The final message parsed as JSON, when an output schema was enforced. */
  json?: unknown;
  usage: Partial<UsageMetrics>;
  /** Agent turns used. */
  turns?: number;
  /** The tool calls, in order. */
  steps: AgentJudgeStep[];
  /** The runtime's id, as `AgentJudgeRuntime.id`. */
  runtime: string;
  model?: string;
}

/** An agent loop an agentic judge runs on. */
export interface AgentJudgeRuntime {
  readonly id: string;
  run(task: AgentJudgeTask): Promise<AgentJudgeResult>;
}

/** Limit on tool output kept per step in results. */
const STEP_PREVIEW_CHARS = 2000;

export function preview(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return text.length > STEP_PREVIEW_CHARS
    ? `${text.slice(0, STEP_PREVIEW_CHARS)}…[${text.length - STEP_PREVIEW_CHARS} more chars]`
    : text;
}

/**
 * The environment a runtime's child process gets: only the named variables,
 * plus the minimum a process needs to start. Nothing else from the caller,
 * such as other API keys or CI tokens, reaches the agent.
 */
export function runtimeEnv(
  names: readonly string[],
  extra: Record<string, string> = {}
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const name of ['PATH', 'HOME', 'TMPDIR', 'LANG', ...names]) {
    const value = process.env[name];
    if (value !== undefined && value !== '') env[name] = value;
  }
  return { ...env, ...extra };
}
