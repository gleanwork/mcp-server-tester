/**
 * The Claude Agent SDK agent judge runtime.
 *
 * The agent gets the built-in `Read`, `Grep` and `Glob` tools, and a
 * permission check confines every path they touch to the workspace. It has no
 * shell, no write or edit tools, no web tools and no subagents. Plugin
 * commands are offered as in-process tools (`tools`), so a judge can run a
 * plugin's helpers without a shell. It starts with a fresh, empty
 * CLAUDE_CONFIG_DIR and loads no settings sources,
 * so the caller's settings, memory, CLAUDE.md files, skills, hooks and MCP
 * servers are not used. Its endpoint and credential come from
 * `resolveLLMEndpoint('anthropic')`; no other ANTHROPIC_* variable is passed.
 */

import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';
import type { z } from 'zod';
import { loadJudgeSdk } from '../adapterSupport.js';
import { resolveLLMEndpoint } from '../../llm/endpoint.js';
import { commandTool, type AgentJudgeTool } from './commands.js';
import {
  runtimeEnv,
  type AgentJudgeResult,
  type AgentJudgeRuntime,
  type AgentJudgeStep,
  type AgentJudgeTask,
} from './runtime.js';

export interface ClaudeRuntimeOptions {
  /** In-process tools, such as a plugin's trace helpers. */
  tools?: readonly AgentJudgeTool[];
  /** Extra environment variable names to pass through, such as proxy settings. */
  env?: readonly string[];
  /** Path to the Claude Code executable. Defaults to the SDK's bundled one. */
  claudePath?: string;
}

interface ClaudeSdk {
  query: (params: {
    prompt: string;
    options: Record<string, unknown>;
  }) => AsyncIterable<Record<string, unknown> & { type?: string }>;
  createSdkMcpServer: (options: { name: string; tools: unknown[] }) => unknown;
  tool: (
    name: string,
    description: string,
    input: Record<string, z.ZodType>,
    handler: (args: Record<string, unknown>) => Promise<{
      content: Array<{ type: 'text'; text: string }>;
      isError?: boolean;
    }>
  ) => unknown;
}

const DEFAULT_CLAUDE_AGENT_JUDGE_MODEL = 'claude-sonnet-4-5';
const READ_TOOLS = ['Read', 'Grep', 'Glob'] as const;
const TOOL_SERVER = 'judge';

/**
 * Claude Code's environment for an endpoint: the credential MST resolved,
 * and the base URL when it is overridden (a gateway).
 */
async function claudeCredentialEnv(): Promise<Record<string, string>> {
  const endpoint = await resolveLLMEndpoint('anthropic');
  if (!endpoint.apiKey && !endpoint.authToken)
    throw new Error(
      'Claude agent judge runtime requires an API key. Set ANTHROPIC_API_KEY, or ANTHROPIC_BASE_URL and ANTHROPIC_AUTH_TOKEN or MST_LLM_AUTH_COMMAND for a gateway.'
    );
  return {
    ...(endpoint.apiKey && { ANTHROPIC_API_KEY: endpoint.apiKey }),
    ...(endpoint.authToken && { ANTHROPIC_AUTH_TOKEN: endpoint.authToken }),
    ...(endpoint.overridden && { ANTHROPIC_BASE_URL: endpoint.baseURL }),
  };
}

/** Whether `path` (absolute or relative to `root`) is inside `root`. */
export function insideWorkspace(root: string, path: string): boolean {
  const full = isAbsolute(path) ? resolve(path) : resolve(root, path);
  const rel = relative(root, full);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

/** The paths a read tool call touches; undefined when it names none. */
function toolPaths(input: Record<string, unknown>): string[] {
  return ['file_path', 'path', 'notebook_path']
    .map((key) => input[key])
    .filter((v): v is string => typeof v === 'string' && v !== '');
}

/**
 * Allows only the read tools and the runtime's own tools, and only inside
 * the workspace. A Grep or Glob without a path searches the working
 * directory, which is the workspace.
 */
export function workspacePermission(workspace: string, ownTools: Set<string>) {
  // Compare real paths, so an alias of the temp dir (macOS /var -> /private/var)
  // is inside and a symlink leading out is not.
  const realRoot = realpath(workspace).catch(() => resolve(workspace));
  return async (
    toolName: string,
    input: Record<string, unknown>
  ): Promise<
    | { behavior: 'allow'; updatedInput: Record<string, unknown> }
    | { behavior: 'deny'; message: string }
  > => {
    if (ownTools.has(toolName))
      return { behavior: 'allow', updatedInput: input };
    if (!(READ_TOOLS as readonly string[]).includes(toolName))
      return {
        behavior: 'deny',
        message: `${toolName} is not available to judges.`,
      };
    const root = await realRoot;
    for (const path of toolPaths(input)) {
      const full = isAbsolute(path) ? resolve(path) : resolve(root, path);
      let real: string;
      try {
        real = await realpath(full);
      } catch {
        // A missing path: check it lexically, against both spellings of the root.
        real = full;
        if (insideWorkspace(resolve(workspace), full)) continue;
      }
      if (!insideWorkspace(root, real))
        return {
          behavior: 'deny',
          message: `${path} is outside the workspace.`,
        };
    }
    return { behavior: 'allow', updatedInput: input };
  };
}

/** A Claude Agent SDK runtime. */
export function claudeRuntime(
  options: ClaudeRuntimeOptions = {}
): AgentJudgeRuntime {
  return {
    id: 'claude-agent',
    async run(task: AgentJudgeTask): Promise<AgentJudgeResult> {
      const sdk = await loadJudgeSdk<ClaudeSdk>(
        () => import('@anthropic-ai/claude-agent-sdk'),
        'Claude Agent',
        '@anthropic-ai/claude-agent-sdk'
      );
      const credentials = await claudeCredentialEnv();
      const root = await realpath(task.workspace);
      const configDir = await mkdtemp(join(tmpdir(), 'mst-claude-home-'));
      const tools = [
        ...(options.tools ?? []),
        ...(task.commands ?? []).map(commandTool),
      ];
      const ownTools = new Set(
        tools.map((t) => `mcp__${TOOL_SERVER}__${t.name}`)
      );
      const mcpServers = tools.length
        ? {
            [TOOL_SERVER]: sdk.createSdkMcpServer({
              name: TOOL_SERVER,
              tools: tools.map((t) =>
                sdk.tool(t.name, t.description, t.input, async (args) => {
                  try {
                    return {
                      content: [
                        { type: 'text', text: await t.run(args, root) },
                      ],
                    };
                  } catch (err) {
                    return {
                      content: [
                        {
                          type: 'text',
                          text:
                            err instanceof Error ? err.message : String(err),
                        },
                      ],
                      isError: true,
                    };
                  }
                })
              ),
            }),
          }
        : {};
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), task.timeoutMs);
      const model = task.model ?? DEFAULT_CLAUDE_AGENT_JUDGE_MODEL;
      const steps: AgentJudgeStep[] = [];
      const pending = new Map<string, AgentJudgeStep>();
      try {
        let result: Record<string, unknown> | undefined;
        for await (const message of sdk.query({
          prompt: task.prompt,
          options: {
            model,
            cwd: root,
            tools: [...READ_TOOLS],
            allowedTools: [...ownTools],
            disallowedTools: [
              'Bash',
              'Write',
              'Edit',
              'NotebookEdit',
              'WebFetch',
              'WebSearch',
              'Task',
              'Agent',
              'Skill',
            ],
            canUseTool: workspacePermission(root, ownTools),
            permissionMode: 'default',
            mcpServers,
            strictMcpConfig: true,
            settingSources: [],
            persistSession: false,
            // The caller's HOME: an organization's managed Claude Code
            // settings may fetch the credential with a helper that needs it.
            // Settings stay out: CLAUDE_CONFIG_DIR is fresh and no setting
            // sources load.
            env: runtimeEnv(['HOME', ...(options.env ?? [])], {
              ...credentials,
              CLAUDE_CONFIG_DIR: configDir,
            }),
            ...(options.claudePath !== undefined && {
              pathToClaudeCodeExecutable: options.claudePath,
            }),
            ...(task.system !== undefined && { systemPrompt: task.system }),
            ...(task.effort !== undefined && { effort: task.effort }),
            maxTurns: task.maxTurns,
            ...(task.maxBudgetUsd !== undefined && {
              maxBudgetUsd: task.maxBudgetUsd,
            }),
            ...(task.outputSchema !== undefined && {
              outputFormat: { type: 'json_schema', schema: task.outputSchema },
            }),
            abortController: controller,
          },
        })) {
          collectSteps(message, steps, pending);
          if (message.type === 'result') result = message;
        }
        if (!result)
          throw new Error('No result message received from Claude Agent SDK');
        if (result.subtype !== 'success') {
          const errors = Array.isArray(result.errors)
            ? result.errors.join(', ')
            : '';
          throw new Error(
            `Claude agent judge ${String(result.subtype)}${errors ? `: ${errors}` : ''}`
          );
        }
        const usage = (result.usage ?? {}) as Record<
          string,
          number | undefined
        >;
        return {
          text: typeof result.result === 'string' ? result.result : '',
          ...(result.structured_output !== undefined && {
            json: result.structured_output,
          }),
          usage: {
            inputTokens: usage.input_tokens ?? 0,
            outputTokens: usage.output_tokens ?? 0,
            ...(usage.cache_read_input_tokens !== undefined && {
              cacheReadInputTokens: usage.cache_read_input_tokens,
            }),
            ...(usage.cache_creation_input_tokens !== undefined && {
              cacheCreationInputTokens: usage.cache_creation_input_tokens,
            }),
            ...(typeof result.total_cost_usd === 'number' && {
              totalCostUsd: result.total_cost_usd,
            }),
            durationMs:
              typeof result.duration_ms === 'number' ? result.duration_ms : 0,
            ...(typeof result.duration_api_ms === 'number' && {
              durationApiMs: result.duration_api_ms,
            }),
          },
          ...(typeof result.num_turns === 'number' && {
            turns: result.num_turns,
          }),
          steps,
          runtime: 'claude-agent',
          model,
        };
      } catch (err) {
        if (controller.signal.aborted)
          throw new Error(
            `Claude agent judge timed out after ${task.timeoutMs} ms`
          );
        throw err;
      } finally {
        clearTimeout(timer);
        await rm(configDir, { recursive: true, force: true });
      }
    },
  };
}

function collectSteps(
  message: Record<string, unknown> & { type?: string },
  steps: AgentJudgeStep[],
  pending: Map<string, AgentJudgeStep>
): void {
  const content = (message.message as { content?: unknown } | undefined)
    ?.content;
  if (!Array.isArray(content)) return;
  for (const block of content as Array<Record<string, unknown>>) {
    if (block.type === 'tool_use' && typeof block.id === 'string') {
      const step: AgentJudgeStep = { tool: String(block.name) };
      steps.push(step);
      pending.set(block.id, step);
    } else if (
      block.type === 'tool_result' &&
      typeof block.tool_use_id === 'string'
    ) {
      const step = pending.get(block.tool_use_id);
      if (step && block.is_error === true) step.isError = true;
    }
  }
}
