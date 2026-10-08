/**
 * The Codex SDK agent judge runtime.
 *
 * Codex runs in its OS sandbox in `read-only` mode: the agent can run shell
 * commands to read the workspace (so plugin scripts in the workspace run as
 * they are), but it cannot write files or reach the network. It starts with a
 * fresh, empty CODEX_HOME, so the caller's config, login, rules and session
 * history are not read, and it gets only the environment variables listed in
 * `env`.
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadJudgeSdk } from '../adapterSupport.js';
import {
  preview,
  runtimeEnv,
  type AgentJudgeResult,
  type AgentJudgeRuntime,
  type AgentJudgeStep,
  type AgentJudgeTask,
} from './runtime.js';

/** The part of `@openai/codex-sdk` the runtime uses. */
interface CodexSdk {
  Codex: new (options: Record<string, unknown>) => {
    startThread(options: Record<string, unknown>): {
      run(
        input: string,
        options: Record<string, unknown>
      ): Promise<{
        items: Array<Record<string, unknown> & { type: string }>;
        finalResponse: string;
        usage: {
          input_tokens: number;
          cached_input_tokens?: number;
          output_tokens: number;
          reasoning_output_tokens?: number;
        } | null;
      }>;
    };
  };
}

export interface CodexRuntimeOptions {
  /** API key. Defaults to CODEX_API_KEY, then OPENAI_API_KEY. */
  apiKey?: string;
  baseUrl?: string;
  /** Path to the codex binary. Defaults to the SDK's bundled one. */
  codexPath?: string;
  /** Extra environment variable names to pass through, such as proxy settings. */
  env?: readonly string[];
}

const DEFAULT_CODEX_JUDGE_MODEL = 'gpt-5.5';

function stepOf(
  item: Record<string, unknown> & { type: string }
): AgentJudgeStep | undefined {
  switch (item.type) {
    case 'command_execution':
      return {
        tool: 'shell',
        input: preview(item.command),
        output: preview(item.aggregated_output),
        isError: typeof item.exit_code === 'number' && item.exit_code !== 0,
      };
    case 'mcp_tool_call':
      return {
        tool: `${String(item.server)}.${String(item.tool)}`,
        input: preview(item.arguments),
        output: preview(item.result ?? item.error),
        isError: item.status === 'failed',
      };
    case 'web_search':
      return { tool: 'web_search', input: preview(item.query) };
    case 'file_change':
      return {
        tool: 'file_change',
        input: preview(item.changes),
        isError: true,
      };
    default:
      return undefined;
  }
}

/** A Codex SDK runtime. */
export function codexRuntime(
  options: CodexRuntimeOptions = {}
): AgentJudgeRuntime {
  return {
    id: 'codex',
    async run(task: AgentJudgeTask): Promise<AgentJudgeResult> {
      const apiKey =
        options.apiKey ??
        process.env.CODEX_API_KEY ??
        process.env.OPENAI_API_KEY;
      if (!apiKey)
        throw new Error(
          'Codex judge runtime requires an API key. Set CODEX_API_KEY or OPENAI_API_KEY.'
        );
      const { Codex } = await loadJudgeSdk<CodexSdk>(
        () => import('@openai/codex-sdk'),
        'Codex',
        '@openai/codex-sdk'
      );
      const home = await mkdtemp(join(tmpdir(), 'mst-codex-home-'));
      const started = Date.now();
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), task.timeoutMs);
      try {
        const codex = new Codex({
          apiKey,
          ...(options.baseUrl !== undefined && { baseUrl: options.baseUrl }),
          ...(options.codexPath !== undefined && {
            codexPathOverride: options.codexPath,
          }),
          env: runtimeEnv(options.env ?? [], { CODEX_HOME: home }),
          // Fresh CODEX_HOME already has no config, rules or history; these
          // also turn off what a future default might add.
          config: {
            history: { persistence: 'none' },
            shell_environment_policy: { inherit: 'core' },
          },
        });
        const thread = codex.startThread({
          model: task.model ?? DEFAULT_CODEX_JUDGE_MODEL,
          sandboxMode: 'read-only',
          workingDirectory: task.workspace,
          skipGitRepoCheck: true,
          approvalPolicy: 'never',
          networkAccessEnabled: false,
          webSearchMode: 'disabled',
          ...(task.effort !== undefined && {
            modelReasoningEffort: task.effort,
          }),
        });
        const input = task.system
          ? `${task.system}\n\n${task.prompt}`
          : task.prompt;
        const turn = await thread.run(input, {
          signal: controller.signal,
          ...(task.outputSchema !== undefined && {
            outputSchema: task.outputSchema,
          }),
        });
        const steps = turn.items
          .map(stepOf)
          .filter((s): s is AgentJudgeStep => s !== undefined);
        let json: unknown;
        if (task.outputSchema !== undefined) {
          try {
            json = JSON.parse(turn.finalResponse);
          } catch {
            json = undefined;
          }
        }
        return {
          text: turn.finalResponse,
          ...(json !== undefined && { json }),
          usage: {
            inputTokens: turn.usage?.input_tokens ?? 0,
            outputTokens: turn.usage?.output_tokens ?? 0,
            ...(turn.usage?.cached_input_tokens !== undefined && {
              cacheReadInputTokens: turn.usage.cached_input_tokens,
            }),
            ...(turn.usage?.reasoning_output_tokens !== undefined && {
              reasoningOutputTokens: turn.usage.reasoning_output_tokens,
            }),
            durationMs: Date.now() - started,
          },
          turns: turn.items.filter((i) => i.type === 'agent_message').length,
          steps,
          runtime: 'codex',
          model: task.model ?? DEFAULT_CODEX_JUDGE_MODEL,
        };
      } catch (err) {
        if (controller.signal.aborted)
          throw new Error(`Codex judge timed out after ${task.timeoutMs} ms`);
        throw err;
      } finally {
        clearTimeout(timer);
        await rm(home, { recursive: true, force: true });
      }
    },
  };
}
