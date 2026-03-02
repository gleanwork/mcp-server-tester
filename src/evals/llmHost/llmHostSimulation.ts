/**
 * LLM Host Simulation - Main entry point
 *
 * All providers (openai, anthropic, google, azure, mistral, deepseek,
 * openrouter, xai) run through the Vercel AI SDK orchestrator, which uses
 * generateText + stopWhen for a uniform multi-turn tool-calling loop with
 * built-in latency decomposition.
 *
 * Required packages per provider:
 *   openai      → npm install ai @ai-sdk/openai
 *   anthropic   → npm install ai @ai-sdk/anthropic
 *   google      → npm install ai @ai-sdk/google
 *   azure       → npm install ai @ai-sdk/azure
 *   mistral     → npm install ai @ai-sdk/mistral
 *   deepseek    → npm install ai @ai-sdk/deepseek
 *   openrouter  → npm install ai @openrouter/ai-sdk-provider
 *   xai         → npm install ai @ai-sdk/xai
 */

import type { MCPFixtureApi } from '../../mcp/fixtures/mcpFixture.js';
import type {
  LLMHostConfig,
  LLMHostSimulationResult,
  LLMHostSimulator,
  LLMProvider,
} from './llmHostTypes.js';
import { createVercelOrchestrator } from './adapters/vercel.js';

// Single orchestrator instance shared across all providers.
// Each provider is dynamically imported inside the orchestrator on first use.
const vercelOrchestrator: LLMHostSimulator = createVercelOrchestrator();

const allProviders: LLMProvider[] = [
  'openai',
  'anthropic',
  'azure',
  'google',
  'mistral',
  'deepseek',
  'openrouter',
  'xai',
  'vertex-anthropic',
];

const simulatorRegistry = new Map<LLMProvider, LLMHostSimulator>(
  allProviders.map((p) => [p, vercelOrchestrator])
);

/**
 * Simulates an LLM host interacting with an MCP server.
 *
 * The LLM chooses which tools to call based solely on their descriptions and
 * schemas, testing discoverability and parameter clarity at the level a real
 * user (via Claude Desktop, ChatGPT, etc.) would experience.
 *
 * All providers run through the Vercel AI SDK's generateText with maxSteps,
 * which handles multi-turn tool calling natively and provides per-step latency
 * decomposition (llmDurationMs vs. mcpDurationMs).
 *
 * @param mcp - MCP fixture API
 * @param scenario - Natural language prompt describing what the LLM should do
 * @param config - LLM host configuration (provider, model, temperature, etc.)
 * @returns Simulation result with tool calls, final response, and latency data
 *
 * @example
 * ```typescript
 * const result = await simulateLLMHost(mcp,
 *   "Find recent documents about MCP testing frameworks",
 *   { provider: 'anthropic', model: 'claude-3-5-sonnet-20241022' }
 * );
 *
 * expect(result.success).toBe(true);
 * expect(result.toolCalls.map(c => c.name)).toContain('search');
 * ```
 */
export async function simulateLLMHost(
  mcp: MCPFixtureApi,
  scenario: string,
  config: LLMHostConfig
): Promise<LLMHostSimulationResult> {
  const simulator = simulatorRegistry.get(config.provider);
  if (!simulator) {
    throw new Error(
      `Unsupported provider: ${String(config.provider)}. ` +
        `Supported: ${allProviders.join(', ')}`
    );
  }
  return simulator.simulate(mcp, scenario, config);
}

/**
 * Returns true if the given provider is supported.
 *
 * Note: this does not check whether the required @ai-sdk/* package is
 * installed — that is validated at simulation time with a helpful error.
 */
export function isProviderAvailable(provider: LLMProvider): boolean {
  return simulatorRegistry.has(provider);
}

/**
 * Returns a human-readable installation message for a given provider.
 *
 * @remarks This is a diagnostic utility for checking whether optional
 * @ai-sdk/* packages are installed. Not part of the primary usage path.
 */
export function getMissingDependencyMessage(provider: LLMProvider): string {
  const packageMap: Partial<Record<LLMProvider, string>> = {
    openai: 'npm install ai @ai-sdk/openai',
    anthropic: 'npm install ai @ai-sdk/anthropic',
    google: 'npm install ai @ai-sdk/google',
    azure: 'npm install ai @ai-sdk/azure',
    mistral: 'npm install ai @ai-sdk/mistral',
    deepseek: 'npm install ai @ai-sdk/deepseek',
    openrouter: 'npm install ai @openrouter/ai-sdk-provider',
    xai: 'npm install ai @ai-sdk/xai',
    'vertex-anthropic':
      'npm install ai @ai-sdk/google-vertex (requires Application Default Credentials — see docs/llm-host.md)',
  };

  const pkg = packageMap[provider];
  return pkg
    ? `${String(provider)} provider requires: ${pkg}`
    : `Unknown provider: ${String(provider)}`;
}
