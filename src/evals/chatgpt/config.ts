import type { CodexSetupConfig } from '../codexSetup/config.js';
import type { ChatgptAppReasoningEffort } from '../reasoningEffort.js';
import type {
  MarketplacePlugin,
  ClientPluginCredentials,
} from '../clientPlugins.js';
import type { ExternalClientCorrelationMetadata } from '../clientTelemetryTypes.js';

/**
 * What the ChatGPT app (`chatgpt`, `codex-app`) runs a trial with, resolved
 * from the client's options by `chatgptClient.ts`.
 */
export interface ChatgptAppConfig {
  /**
   * The OS of the machine that runs the trial (ADR 0011): Computer Use on
   * macOS, the accessibility automation on Linux.
   */
  os: 'darwin' | 'linux';
  /** End-to-end time limit for the trial. */
  timeoutMs?: number;
  /** Requested ChatGPT model ID (verified against the native turn record). */
  model?: string;
  reasoningEffort?: ChatgptAppReasoningEffort;
  /**
   * How the trial is matched to its native turn. `exact_prompt` (the
   * default) matches the unchanged prompt in a fresh native session;
   * `prompt_marker` appends a marker to the prompt.
   */
  correlation?: {
    strategy?: ExternalClientCorrelationMetadata['strategy'];
    /** Whether the marker goes in the prompt. Defaults to true for `prompt_marker`. */
    includeInPrompt?: boolean;
  };
  /** The managed MCP configuration (`config.toml`) MST installs for the run. */
  codexSetup?: CodexSetupConfig;
  /** Client plugins that MST installs into the fresh native profile before start. */
  plugins?: MarketplacePlugin[];
  /**
   * Resolved plugin MCP credentials (`<plugin>/<server>` -> token), from each
   * override's `auth.accessTokenEnv`. Never logged, receipted, or passed to the app.
   */
  pluginCredentials?: ClientPluginCredentials;
  /** App, automation and environment settings (`surface`, `maxActions`, ...). */
  options?: Record<string, unknown>;
}
