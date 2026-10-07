import type { ClientCapability } from './types.js';

export const REQUIRED_CLIENT_CAPABILITIES: ClientCapability[] = [
  'control',
  'input',
  'completion',
  'trace',
  'normalize',
];

export function validateClientCapabilities(
  capabilities: readonly ClientCapability[]
): ClientCapability[] {
  const provided = new Set(capabilities);
  return REQUIRED_CLIENT_CAPABILITIES.filter(
    (capability) => !provided.has(capability)
  );
}
