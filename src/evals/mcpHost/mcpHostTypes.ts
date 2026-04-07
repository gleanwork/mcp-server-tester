/**
 * Types and interfaces for MCP host simulation mode
 *
 * This module provides types for testing MCP servers through MCP hosts,
 * validating tool descriptions, parameter clarity, and discoverability.
 */

import type { MCPFixtureApi } from '../../mcp/fixtures/mcpFixture.js';

/**
 * Host type for MCP host simulation.
 *
 * - 'sdk': Programmatic via Vercel AI SDK (default). The framework's MCP connection is reused.
 * - 'cli': CLI-based hosts (e.g., Claude Code, Codex). Spawns a process with its own MCP connection.
 * - 'browser': Web-based hosts (e.g., claude.ai). Uses Playwright/CDP. (Not yet implemented.)
 * - 'desktop': Desktop app hosts (e.g., Claude Desktop). Uses computer use. (Not yet implemented.)
 */
export type HostType = 'sdk' | 'cli' | 'browser' | 'desktop';

/**
 * LLM provider for SDK-based host simulation.
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
 * Output format for CLI host processes.
 *
 * - 'stream-json': NDJSON (one JSON object per line). Used by Claude Code (`--output-format stream-json`).
 * - 'json': Single JSON object on stdout.
 */
export type CLIOutputFormat = 'stream-json' | 'json';

/**
 * Configuration for a CLI host process.
 *
 * The process is spawned directly (no shell) with `command` and `args`.
 * Use `{{scenario}}` in any args entry as a placeholder for the natural
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
 *   "args": ["-p", "{{scenario}}", "--output-format", "stream-json",
 *            "--verbose", "--mcp-config", "{...}"]
 * }
 * ```
 *
 * @example Custom CLI
 * ```json
 * {
 *   "command": "my-agent",
 *   "args": ["--prompt", "{{scenario}}", "--config", "./mcp.json"],
 *   "outputFormat": "json"
 * }
 * ```
 */
export interface CLIConfig {
  /**
   * CLI binary to invoke.
   */
  command: string;

  /**
   * Arguments to pass. Use `{{scenario}}` as a placeholder for the prompt.
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

/**
 * Configuration for MCP host simulation
 */
export interface MCPHostConfig {
  /**
   * Host type for the simulation.
   *
   * - 'sdk': Programmatic via Vercel AI SDK (default). The framework's MCP connection is reused.
   * - 'cli': CLI-based hosts (e.g., Claude Code, Codex). Spawns a process with its own MCP connection.
   * - 'browser': Web-based hosts (not yet implemented).
   * - 'desktop': Desktop app hosts (not yet implemented).
   *
   * @default 'sdk'
   */
  hostType?: HostType;

  /**
   * LLM provider (required for 'sdk' host type, ignored for 'cli')
   */
  provider?: LLMProvider;

  /**
   * Environment variable name containing the API key
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
   * Maximum number of tool call steps to allow in a single conversation
   * @default 10
   */
  maxToolCalls?: number;

  /**
   * CLI host configuration (required for 'cli' host type).
   */
  cli?: CLIConfig;
}

/**
 * A tool call made by the LLM
 */
export interface LLMToolCall {
  /** Tool name */
  name: string;
  /** Tool arguments (as provided by LLM) */
  arguments: Record<string, unknown>;
  /** Optional tool call ID (for tracking) */
  id?: string;
}

/**
 * Result from an MCP host simulation
 */
export interface MCPHostSimulationResult {
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

  /** The conversation turns for attribution analysis */
  conversationHistory?: Array<{
    role: 'user' | 'assistant' | 'tool';
    content: string;
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
}

/**
 * Interface for MCP host simulators.
 *
 * The only built-in implementation is the Vercel AI SDK orchestrator
 * (src/evals/mcpHost/adapters/vercel.ts). Custom implementations can be
 * created for specialised testing needs.
 */
export interface MCPHostSimulator {
  /**
   * Simulates an MCP host interacting with an MCP server
   *
   * @param mcp - MCP fixture API
   * @param scenario - Natural language prompt describing what the LLM should do
   * @param config - MCP host configuration
   * @returns Simulation result with tool calls and response
   */
  simulate(
    mcp: MCPFixtureApi,
    scenario: string,
    config: MCPHostConfig
  ): Promise<MCPHostSimulationResult>;
}
