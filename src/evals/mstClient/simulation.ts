/**
 * MCP Client Simulation - Main entry point
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
  MstClientConfig,
  MstClientSimulationResult,
  MstClientSimulator,
  LLMProvider,
} from './types.js';
import { createVercelOrchestrator } from './adapters/vercel.js';
import { runCLIClient } from './adapters/cli/index.js';
import { ProviderSchema } from './clientOptions.js';

// Single orchestrator instance shared across all providers.
// Each provider is dynamically imported inside the orchestrator on first use.
const vercelOrchestrator: MstClientSimulator = createVercelOrchestrator();

const allProviders: readonly LLMProvider[] = ProviderSchema.options;

/**
 * Simulates a client interacting with an MCP server.
 *
 * The LLM chooses which tools to call based solely on their descriptions and
 * schemas, testing discoverability and parameter clarity at the level a real
 * user (via Claude Desktop, ChatGPT, etc.) would experience.
 *
 * Internal to the mst and claude-code clients: tests and evals reach it
 * through `runEvalDataset` / `runEvalCase` or an eval.
 *
 * @param mcp - MCP fixture API (used by the SDK client; ignored by the CLI client, which establishes its own connections)
 * @param input - The case's input: what the user asks the client to do
 * @param config - client configuration (provider, model, temperature, etc.)
 * @returns Simulation result with tool calls, final response, and latency data
 *
 */
export async function simulateMstClient(
  mcp: MCPFixtureApi,
  input: string,
  config: MstClientConfig,
  signal?: AbortSignal
): Promise<MstClientSimulationResult> {
  const clientType = config.clientType ?? 'sdk';

  if (clientType !== 'sdk' && config.skills && config.skills !== 'off') {
    throw new Error(
      `skills is only supported for the mst client; '${clientType}' clients manage skills themselves.`
    );
  }

  if (clientType === 'cli') {
    if (!config.cli) {
      throw new Error(
        `cli is required when clientType is 'cli'. ` +
          `Provide { command } with a shell command containing {{prompt}}.`
      );
    }
    const placeholder = config.cli.args.some((arg) =>
      arg.includes('{{systemPrompt}}')
    );
    if (config.systemPrompt !== undefined && !placeholder) {
      throw new Error(
        "systemPrompt reaches a CLI client only through a {{systemPrompt}} placeholder in cli.args (for Claude Code: '--append-system-prompt', '{{systemPrompt}}'), or use the claude-cli client."
      );
    }
    if (config.systemPrompt === undefined && placeholder) {
      throw new Error(
        'cli.args has a {{systemPrompt}} placeholder but no systemPrompt is set.'
      );
    }
    if (
      config.temperature !== undefined ||
      config.maxTokens !== undefined ||
      config.maxToolCalls !== undefined
    ) {
      throw new Error(
        'CLI clients do not support temperature, maxTokens or maxToolCalls.'
      );
    }
    return runCLIClient(
      {
        ...config.cli,
        timeout: config.timeout ?? config.cli.timeout,
        env: { ...config.env, ...config.cli.env },
      },
      input,
      signal,
      config.systemPrompt
    );
  }

  // Default: SDK client via Vercel AI SDK
  if (!config.provider) {
    throw new Error(
      `provider is required for the mst client. ` +
        `Supported: ${allProviders.join(', ')}`
    );
  }

  if (!isProviderAvailable(config.provider)) {
    throw new Error(
      `Unsupported provider: ${String(config.provider)}. ` +
        `Supported: ${allProviders.join(', ')}`
    );
  }
  return vercelOrchestrator.simulate(mcp, input, config, signal);
}

/**
 * Returns true if the given provider is supported.
 *
 * Note: this does not check whether the required @ai-sdk/* package is
 * installed — that is validated at simulation time with a helpful error.
 */
export function isProviderAvailable(provider: LLMProvider): boolean {
  return allProviders.includes(provider);
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
      'npm install ai @ai-sdk/google-vertex (requires Application Default Credentials — see docs/mst-client.md)',
  };

  const pkg = packageMap[provider];
  return pkg
    ? `${String(provider)} provider requires: ${pkg}`
    : `Unknown provider: ${String(provider)}`;
}
