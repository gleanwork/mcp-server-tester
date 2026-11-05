/** Entry points for the API client and the Claude Code CLI. */
import type { MCPFixtureApi } from '../../mcp/fixtures/mcpFixture.js';
import type { ClientRunResult } from '../evalFrameworkTypes.js';
import type { MstClientConfig, LLMProvider } from './types.js';
import { runVercelClient } from './adapters/vercel.js';
import { runCLIClient } from './adapters/cli/index.js';
import { ProviderSchema } from './clientOptions.js';

const allProviders: readonly LLMProvider[] = ProviderSchema.options;

/** Runs a model through its API over the caller's MCP connection. */
export async function runApiClient(
  mcp: MCPFixtureApi,
  input: string,
  config: MstClientConfig,
  signal?: AbortSignal
): Promise<ClientRunResult> {
  if (!config.provider) {
    throw new Error(
      `provider is required for the api client. ` +
        `Supported: ${allProviders.join(', ')}`
    );
  }
  if (!isProviderAvailable(config.provider)) {
    throw new Error(
      `Unsupported provider: ${String(config.provider)}. ` +
        `Supported: ${allProviders.join(', ')}`
    );
  }
  return runVercelClient(mcp, input, config, signal);
}

/** Runs Claude Code with its own MCP connections and parses its trace. */
export async function runClaudeCodeClient(
  input: string,
  config: MstClientConfig,
  signal?: AbortSignal
): Promise<ClientRunResult> {
  if (config.skills && config.skills !== 'off') {
    throw new Error(
      `skills is only supported for the api client; 'cli' clients manage skills themselves.`
    );
  }
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

/** Whether the provider is supported, independent of installed packages. */
export function isProviderAvailable(provider: LLMProvider): boolean {
  return allProviders.includes(provider);
}

/** Installation instructions for an optional provider package. */
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
