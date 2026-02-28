/**
 * Types and interfaces for LLM host simulation mode
 *
 * This module provides types for testing MCP servers through LLM hosts,
 * validating tool descriptions, parameter clarity, and discoverability.
 */

import type { MCPFixtureApi } from '../../mcp/fixtures/mcpFixture.js';

/**
 * LLM provider for host simulation.
 *
 * All providers run through the Vercel AI SDK (`ai` package).
 * Each provider requires its corresponding @ai-sdk/* package:
 *
 *   openai      → npm install ai @ai-sdk/openai
 *   anthropic   → npm install ai @ai-sdk/anthropic
 *   google      → npm install ai @ai-sdk/google
 *   azure       → npm install ai @ai-sdk/azure
 *   mistral     → npm install ai @ai-sdk/mistral
 *   ollama      → npm install ai @ai-sdk/ollama  (local, no API key)
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
  | 'ollama'
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
 * Configuration for LLM host simulation
 */
export interface LLMHostConfig {
  /**
   * LLM provider to use
   */
  provider: LLMProvider;

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
 * Result from an LLM host simulation
 */
export interface LLMHostSimulationResult {
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
 * Interface for LLM host simulators.
 *
 * The only built-in implementation is the Vercel AI SDK orchestrator
 * (src/evals/llmHost/adapters/vercel.ts). Custom implementations can be
 * created for specialised testing needs.
 */
export interface LLMHostSimulator {
  /**
   * Simulates an LLM host interacting with an MCP server
   *
   * @param mcp - MCP fixture API
   * @param scenario - Natural language prompt describing what the LLM should do
   * @param config - LLM host configuration
   * @returns Simulation result with tool calls and response
   */
  simulate(
    mcp: MCPFixtureApi,
    scenario: string,
    config: LLMHostConfig
  ): Promise<LLMHostSimulationResult>;
}
