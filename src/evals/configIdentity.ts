import { createHash } from 'node:crypto';
import type { EvalConfig } from './evalConfig.js';

/** Identity of the normalized eval config used to persist and resume a suite. */
export function configIdentity(evalConfig: EvalConfig): {
  configId: string;
  contentHash: string;
} {
  return {
    configId: evalConfig.name,
    contentHash: createHash('sha256')
      .update(JSON.stringify(evalConfig))
      .digest('hex'),
  };
}
