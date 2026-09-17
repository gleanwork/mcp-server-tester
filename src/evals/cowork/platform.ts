import type { EvalManifest } from '../evalManifest.js';
import type {
  ComputerUseOptions,
  ComputerUseSubmissionResult,
  ComputerUseHitlResult,
} from './anthropicComputerUse.js';

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
    options: ComputerUseOptions
  ): Promise<ComputerUseSubmissionResult>;
  handleHitl(
    options: ComputerUseOptions & { task?: string }
  ): Promise<ComputerUseHitlResult>;
}

export async function getCoworkPlatform(): Promise<CoworkPlatform> {
  if (process.platform === 'darwin')
    return (await import('./macos.js')).macCoworkPlatform;
  throw new Error(
    `Cowork has no qualified ${process.platform} desktop adapter. The shared runner is portable; native execution is currently macOS-only.`
  );
}
