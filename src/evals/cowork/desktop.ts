import type { EvalConfig } from '../evalConfig.js';
import type { ClaudeTranscript } from './transcript.js';
import type { MarketplacePlugin, ClientStdioPaths } from '../clientPlugins.js';
import type {
  CoworkDriverOptions,
  CoworkSubmissionReceipt,
  CoworkHitlReceipt,
} from './interaction.js';
import type { ClientApp } from '../installedApp.js';

/** The shared batch lifecycle does not choose OS paths or control an application.
 * Implementations must retain the existing bounded, no-resubmission contract. */
export interface CoworkDesktop {
  dataDirectory(options: { dataDir?: string }): string;
  prepare(options: {
    evalConfig: EvalConfig;
    env: Record<string, string | undefined>;
    model?: string;
    /** Validated client plugins; Cowork installs them via allowedPluginMarketplaces. */
    plugins?: readonly MarketplacePlugin[];
    /** Caller-owned runtime paths for a prepared Linux desktop. */
    stdioPaths?: ClientStdioPaths;
    /** macOS: run exactly this Claude Desktop version instead of the installed one. */
    appVersion?: string;
    /**
     * Linux owned-desktop mode: Claude Desktop's managed `otlp*` settings,
     * pointing its OpenTelemetry at MST's receiver (`telemetry.host`).
     */
    otlpSettings?: Record<string, unknown>;
  }): Promise<{
    /** macOS returns the installed, caller-owned or pinned application path. */
    appPath?: string;
    /** macOS returns the application it runs. */
    /** `pinned`: the eval config's `clientOptions.appVersion`; else the installed app. */
    app?: ClientApp;
    /** macOS returns transaction-owned paths after installing its private profile. */
    stdioPaths?: ClientStdioPaths;
    /**
     * Quits and relaunches the app with the session's settings: the reset
     * that needs no planner. macOS only.
     */
    restart?(): Promise<void>;
    dispose(): Promise<void>;
  }>;
  recover(): Promise<unknown>;
  /** Verify host-specific evidence before accepting a completed native transcript. */
  validateTranscript?(transcript: ClaudeTranscript): Promise<void>;
  /** Account connector names that count as eval MCP calls, not client built-ins. */
  mcpServerNames?(): readonly string[];
  /** Native account connector name to the eval's stable server label. */
  mcpServerLabels?(): Readonly<Record<string, string>>;
  /**
   * After a failed case, leave the app with no task running and no prompt
   * open, so the next case is independent. Never types or submits.
   * `restartApp` is the session's restart, the fallback when a gentler reset
   * fails. Optional: without it, a failed case stops the batch.
   */
  reset?(
    options: CoworkDriverOptions & { restartApp?: () => Promise<void> }
  ): Promise<void>;
  /**
   * After a failed case, before any reset: write what the app shows and its
   * own logs into `dir`, a directory the case's result keeps as artifacts.
   * Read-only and bounded; never acts on the app. Optional.
   */
  diagnose?(options: {
    dir: string;
    dataDir: string;
    env: Record<string, string | undefined>;
  }): Promise<void>;
  submit(
    query: string,
    options: CoworkDriverOptions
  ): Promise<CoworkSubmissionReceipt>;
  handleHitl(
    options: CoworkDriverOptions & { task?: string }
  ): Promise<CoworkHitlReceipt>;
}
