import type { HostCapability } from './types.js';

export const REQUIRED_HOST_CAPABILITIES: HostCapability[] = [
  'control',
  'input',
  'completion',
  'trace',
  'normalize',
];

export function validateHostCapabilities(
  capabilities: readonly HostCapability[]
): HostCapability[] {
  const provided = new Set(capabilities);
  return REQUIRED_HOST_CAPABILITIES.filter(
    (capability) => !provided.has(capability)
  );
}
