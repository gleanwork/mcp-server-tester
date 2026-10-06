import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';

// Read-only exception for trusted inference routing and its display label. In
// particular, MCP, plugin, tool-policy and updater settings must still fail
// closed. Never mutate a plist.
const INFERENCE_KEYS = new Set([
  'deploymentDisplayName',
  'disableDeploymentModeChooser',
  'inferenceCredentialHelper',
  'inferenceCredentialHelperTimeoutSec',
  'inferenceCredentialHelperTtlSec',
  'inferenceCredentialKind',
  'inferenceGatewayAuthScheme',
  'inferenceGatewayBaseUrl',
  'inferenceModels',
  'inferenceProvider',
  'modelDiscoveryEnabled',
]);
export function inferenceOnlyManagedPreferences(value: unknown): boolean {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Object.keys(value).every((key) => INFERENCE_KEYS.has(key))
  );
}

/** What an accepted managed-preferences file decides about inference. */
export interface ManagedInference {
  /** The file sets `inferenceProvider`, so Desktop takes inference from it. */
  setsProvider: boolean;
}

/**
 * Reads a root-owned managed-preferences plist and accepts it only when every
 * key is on the inference-only allowlist. Throws otherwise.
 */
export async function checkManagedInferencePreferences(
  file: string
): Promise<ManagedInference> {
  const error = 'Unable to change Cowork configuration safely.';
  const fd = await open(
    file,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
  );
  try {
    const before = await fd.stat();
    if (
      process.platform !== 'darwin' ||
      !before.isFile() ||
      before.uid !== 0 ||
      before.mode & 0o022 ||
      before.size > 1024 * 1024
    )
      throw new Error(error);
    const bytes = Buffer.alloc(before.size + 1);
    let length = 0;
    while (length < bytes.length) {
      const { bytesRead } = await fd.read(
        bytes,
        length,
        bytes.length - length,
        length
      );
      if (!bytesRead) break;
      length += bytesRead;
    }
    const after = await fd.stat();
    if (
      length !== before.size ||
      after.size !== before.size ||
      after.mtimeMs !== before.mtimeMs ||
      after.ctimeMs !== before.ctimeMs ||
      after.uid !== before.uid ||
      after.mode !== before.mode
    )
      throw new Error(error);
    const value = await new Promise<unknown>((resolve, reject) => {
      const child = execFile(
        '/usr/bin/plutil',
        ['-convert', 'json', '-o', '-', '-'],
        {
          env: { PATH: '/usr/bin:/bin' },
          timeout: 10_000,
          maxBuffer: 1024 * 1024,
        },
        (failure, stdout) => {
          if (failure) {
            reject(new Error(error));
            return;
          }
          try {
            resolve(JSON.parse(stdout));
          } catch {
            reject(new Error(error));
          }
        }
      );
      child.stdin?.on('error', () => reject(new Error(error)));
      child.stdin?.end(bytes.subarray(0, length));
    });
    if (!inferenceOnlyManagedPreferences(value)) throw new Error(error);
    const provider = (value as Record<string, unknown>).inferenceProvider;
    return {
      setsProvider: typeof provider === 'string' && provider.trim() !== '',
    };
  } catch {
    throw new Error(error);
  } finally {
    await fd.close();
  }
}
