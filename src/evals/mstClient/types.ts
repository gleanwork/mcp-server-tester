/**
 * Types and interfaces for client simulation mode
 *
 * This module provides types for testing MCP servers through clients,
 * validating tool descriptions, parameter clarity, and discoverability.
 */

import type { MCPFixtureApi } from '../../mcp/fixtures/mcpFixture.js';
import type {
  ClientDiagnostics,
  ClientSkillsMode,
  SkillLoad,
  UsageMetrics,
} from '../../types/index.js';
import type { TraceEvent } from '../evalFrameworkTypes.js';

/**
 * Client type for client simulation.
 *
 * - 'sdk': Programmatic via Vercel AI SDK (default). The framework's MCP connection is reused.
 * - 'cli': CLI-based clients (Claude Code). Spawns a process with its own MCP connection.
 */
type ClientType = 'sdk' | 'cli';

/**
 * LLM provider for SDK-based client simulation.
 *
 * Each provider runs through the Vercel AI SDK (`ai` package)
 * and requires its corresponding @ai-sdk/* package:
 *
 *   openai      → npm install ai @ai-sdk/openai
 *   anthropic   → npm install ai @ai-sdk/anthropic
 *   google      → npm install ai @ai-sdk/google
 *   azure       → npm install ai @ai-sdk/azure
 *   mistral     → npm install ai @ai-sdk/mistral
 *   deepseek    → npm install ai @ai-sdk/deepseek
 *   openrouter  → npm install ai @openrouter/ai-sdk-provider
 *   xai         → npm install ai @ai-sdk/xai
 */
export type LLMProvider =
  | 'openai'
  | 'anthropic'
  | 'azure'
  | 'google'
  | 'mistral'
  | 'deepseek'
  | 'openrouter'
  | 'xai'
  /**
   * Anthropic Claude via Google Vertex AI.
   * Requires @ai-sdk/google-vertex and Application Default Credentials (gcloud auth).
   * Set GOOGLE_VERTEX_PROJECT and GOOGLE_VERTEX_LOCATION env vars.
   * Use this instead of 'anthropic' in environments where api.anthropic.com is blocked.
   * @example model: 'claude-3-5-haiku@20241022'
   */
  | 'vertex-anthropic';

/**
 * Output format for CLI client processes.
 *
 * - 'stream-json': NDJSON (one JSON object per line). Used by Claude Code (`--output-format stream-json`).
 * - 'json': Single JSON object on stdout.
 */
type CLIOutputFormat = 'stream-json' | 'json';

/**
 * Configuration for a CLI client process.
 *
 * The process is spawned directly (no shell) with `command` and `args`.
 * Use `{{prompt}}` in any args entry as a placeholder for the natural
 * language prompt — the framework replaces it before spawning.
 *
 * Because args are passed directly to the process (not through a shell),
 * special characters in the scenario (quotes, newlines, `$`, etc.) are
 * handled safely without escaping.
 *
 * @example Claude Code
 * ```json
 * {
 *   "command": "claude",
 *   "args": ["-p", "{{prompt}}", "--output-format", "stream-json",
 *            "--verbose", "--mcp-config", "{...}"]
 * }
 * ```
 *
 * @example Custom CLI
 * ```json
 * {
 *   "command": "my-agent",
 *   "args": ["--prompt", "{{prompt}}", "--config", "./mcp.json"],
 *   "outputFormat": "json"
 * }
 * ```
 */
export interface CLIConfig {
  /** Claude Code only: validate these MCP servers in its startup stream. */
  claudeMcpServers?: string[];
  /** Child-process-only environment overrides. Undefined removes an inherited key. */
  env?: Record<string, string | undefined>;
  /**
   * CLI binary to invoke.
   */
  command: string;

  /**
   * Arguments to pass. Use `{{prompt}}` as a placeholder for the prompt.
   */
  args: string[];

  /**
   * How to parse stdout.
   * @default 'stream-json'
   */
  outputFormat?: CLIOutputFormat;

  /**
   * Timeout in milliseconds.
   * @default 120000 (2 minutes)
   */
  timeout?: number;
}

export type { ClientSkillsMode, SkillLoad } from '../../types/index.js';

/**
 * Configuration for client simulation
 */
export interface MstClientConfig {
  /** Execution-local environment overrides; never assigned to process.env. */
  env?: Record<string, string | undefined>;
  /** Execution deadline in milliseconds, including registered client-owned setup and teardown. */
  timeout?: number;
  /**
   * Client type for the simulation.
   *
   * - 'sdk': Programmatic via Vercel AI SDK (default). The framework's MCP connection is reused.
   * - 'cli': CLI-based clients (Claude Code). Spawns a process with its own MCP connection.
   *
   * @default 'sdk'
   */
  clientType?: ClientType;

  /**
   * LLM provider (required for 'sdk' client type, ignored for 'cli')
   */
  provider?: LLMProvider;

  /**
   * Read the API key from exactly this environment variable. For the
   * `anthropic` and `openai` providers this also turns off the LLM gateway
   * credentials (`ANTHROPIC_AUTH_TOKEN`, `MST_LLM_AUTH_COMMAND`); see
   * docs/llm-gateways.md.
   */
  apiKeyEnvVar?: string;

  /**
   * Model to use (provider-specific default if omitted)
   */
  model?: string;

  /**
   * Maximum tokens for response
   */
  maxTokens?: number;

  /**
   * Temperature (0-1, lower is more deterministic)
   * @default 0
   */
  temperature?: number;

  /**
   * Text added to the client's system prompt, such as an organisation's
   * instructions. The SDK client puts it in the model's system prompt; a CLI
   * client gets it through a `{{systemPrompt}}` placeholder in `cli.args`
   * (the claude-code client adds `--append-system-prompt {{systemPrompt}}`).
   */
  systemPrompt?: string;

  /**
   * Maximum number of tool call steps to allow in a single conversation
   * @default 10
   */
  maxToolCalls?: number;

  /**
   * How the simulated client uses Agent Skills the server serves over MCP
   * (SEP-2640). SDK client only.
   *
   * - 'off' (default): skills are not offered to the model.
   * - 'catalog': like a SEP-2640 client, the system prompt lists each skill's
   *   name, description, server, and URI, and the model loads skills with a
   *   `read_skill` tool and supporting files with `read_resource`. Reads are
   *   verified against the skill's entry (digest, size, frontmatter).
   * - 'preload': every SKILL.md is placed in the system prompt up front.
   *
   * Loads are reported in `skillLoads`. Each SKILL.md the model loads (and
   * that passes verification) is also a `skill` event (`toolsTriggered` with
   * `kind: 'skill'`); preloads are not. Loads do not count as MCP tool calls.
   *
   * @default 'off'
   */
  skills?: ClientSkillsMode;

  /**
   * CLI client configuration (required for 'cli' client type).
   */
  cli?: CLIConfig;

  /**
   * Additional MCP server entries for CLI clients. Values follow the Claude
   * mcpServers JSON shape and may point at safe local proxies.
   */
  mcpServers?: Record<string, Record<string, unknown>>;
}

/**
 * A tool call made by the LLM
 */
export interface LLMToolCall {
  /** Explicit provenance, when known (do not infer native tools as MCP). */
  source?: 'mcp' | 'builtin';
  /** MCP server label, independent of the canonical tool name. */
  server?: string;
  /** Original provider-encoded name, retained for diagnostics. */
  rawName?: string;
  durationMs?: number;
  startedAt?: string;
  completedAt?: string;
  /** Tool name */
  name: string;
  /** Tool arguments (as provided by LLM) */
  arguments: Record<string, unknown>;
  /** Optional tool call ID (for tracking) */
  id?: string;
  /** Tool result text, when the client surfaces it (paired to this call) */
  output?: string;
  /** Explicit tool-result error status; absent when not observed. */
  isError?: boolean;
  /**
   * The event this call is: a host-native skill load, command, subagent or
   * tool search the parser typed, or a tool call (also when absent).
   */
  kind?: TraceEvent['kind'];
  /** `tool_search` only: the tools the search returned. */
  results?: TraceEvent['results'];
}

/**
 * Result from a client simulation
 */
export interface MstClientSimulationResult {
  /** Sanitized startup evidence, retained even when execution fails. */
  diagnostics?: ClientDiagnostics;
  /** Whether the simulation succeeded */
  success: boolean;

  /** Tool calls made by the LLM */
  toolCalls: Array<LLMToolCall>;

  /** Final response from the LLM */
  response?: string;

  /** Error message if simulation failed */
  error?: string;

  /** The scenario prompt that was given to the LLM */
  scenario?: string;

  /**
   * The conversation turns for attribution analysis.
   *
   * Tool turns reference their call via `toolCallId` rather than inlining the
   * (potentially large) result — hydrate the output from the matching
   * `toolCalls[]` entry. `content` holds assistant/user text.
   */
  conversationHistory?: Array<{
    role: 'user' | 'assistant' | 'tool';
    content?: string;
    toolCallId?: string;
  }>;

  /**
   * Milliseconds spent waiting for LLM responses
   * (excludes MCP tool execution time)
   */
  llmDurationMs?: number;

  /**
   * Milliseconds spent executing MCP tool calls
   * (excludes LLM response time)
   */
  mcpDurationMs?: number;

  /**
   * Token usage from the LLM during simulation.
   * Populated by SDK-based clients from the AI SDK response.
   */
  usage?: UsageMetrics;

  /** Skills the client loaded for the model (when `skills` is enabled). */
  skillLoads?: SkillLoad[];

  /**
   * Ordered trace of MCP tool calls and skill loads. Present when skills are
   * enabled; tool-call assertions read it so `kind: 'skill'` entries and
   * strict ordering work.
   */
  events?: TraceEvent[];
}

/**
 * Interface for client simulators.
 *
 * The only built-in implementation is the Vercel AI SDK orchestrator
 * (src/evals/mstClient/adapters/vercel.ts). Custom implementations can be
 * created for specialised testing needs.
 */
export interface MstClientSimulator {
  /**
   * Simulates a client interacting with an MCP server
   *
   * @param mcp - MCP fixture API
   * @param scenario - Natural language prompt describing what the LLM should do
   * @param config - client configuration
   * @returns Simulation result with tool calls and response
   */
  simulate(
    mcp: MCPFixtureApi,
    scenario: string,
    config: MstClientConfig,
    /** Optional enclosing client deadline; does not cover caller-owned fixtures. */
    signal?: AbortSignal
  ): Promise<MstClientSimulationResult>;
}
