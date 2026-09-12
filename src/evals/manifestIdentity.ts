import { createHash } from 'node:crypto';
import type { EvalManifest } from './evalManifest.js';

/** Identity of the normalized manifest used to persist and resume a suite. */
export function manifestIdentity(manifest: EvalManifest): {
  manifestId: string;
  contentHash: string;
} {
  return {
    manifestId: manifest.name,
    contentHash: createHash('sha256')
      .update(JSON.stringify(manifest))
      .digest('hex'),
  };
}
