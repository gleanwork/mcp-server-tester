import type { EvalConfig } from '../evalConfig.js';
import type { MarketplacePlugin, ClientStdioPaths } from '../hostPlugins.js';
import type {
  CoworkDriverOptions,
  CoworkDriverProvider,
  CoworkSubmissionReceipt,
  CoworkHitlReceipt,
} from './driver.js';

/** The desktop application a session runs, recorded with each case result. */
interface CoworkHostApp {
  name: string;
  version: string;
  /** `pinned`: the eval config's `host.options.appVersion`; else the installed app. */
  source: 'installed' | 'pinned';
}

/** The shared batch lifecycle does not choose OS paths or control an application.
 * Implementations must retain the existing bounded, no-resubmission contract. */
export interface CoworkPlatform {
  dataDirectory(options: { dataDir?: string }): string;
  prepare(options: {
    evalConfig: EvalConfig;
    env: Record<string, string | undefined>;
    model?: string;
    /** Validated host plugins; Cowork installs them via allowedPluginMarketplaces. */
    plugins?: readonly MarketplacePlugin[];
    /** Caller-owned runtime paths for a prepared Linux desktop. */
    stdioPaths?: ClientStdioPaths;
    /** macOS: run exactly this Claude Desktop version instead of the installed one. */
    appVersion?: string;
  }): Promise<{
    /** macOS returns the installed, caller-owned or pinned application path. */
    appPath?: string;
    /** macOS returns the application it runs. */
    app?: CoworkHostApp;
    /** macOS returns transaction-owned paths after installing its private profile. */
    stdioPaths?: ClientStdioPaths;
    dispose(): Promise<void>;
  }>;
  recover(): Promise<unknown>;
  /**
   * After a failed case, leave the app with no task running and no prompt
   * open, so the next case is independent. Never types or presses keys.
   * Optional: without it, a failed case stops the batch.
   */
  reset?(options: CoworkDriverOptions): Promise<void>;
  submit(
    query: string,
    options: CoworkDriverOptions
  ): Promise<CoworkSubmissionReceipt>;
  handleHitl(
    options: CoworkDriverOptions & { task?: string }
  ): Promise<CoworkHitlReceipt>;
}

export async function getCoworkPlatform(
  provider: CoworkDriverProvider
): Promise<CoworkPlatform> {
  if (process.platform === 'darwin' && provider === 'anthropic-computer-use')
    return (await import('./macos.js')).macCoworkPlatform;
  if (process.platform === 'linux' && provider === 'linux-desktop')
    return (await import('./linux.js')).linuxCoworkPlatform;
  throw new Error(
    `Cowork driver ${provider} is not supported on ${process.platform}.`
  );
}
