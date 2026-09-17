import type { EvalManifest } from '../evalManifest.js';
import type {
  CoworkDriverOptions,
  CoworkDriverProvider,
  CoworkSubmissionReceipt,
  CoworkHitlReceipt,
} from './driver.js';

/** The shared batch lifecycle does not choose OS paths or control an application.
 * Implementations must retain the existing bounded, no-resubmission contract. */
export interface CoworkPlatform {
  dataDirectory(options: { dataDir?: string }): string;
  prepare(options: {
    manifest: EvalManifest;
    env: Record<string, string | undefined>;
    model?: string;
  }): Promise<{ dispose(): Promise<void> }>;
  recover(): Promise<unknown>;
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
