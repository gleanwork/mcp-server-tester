import { ANTHROPIC_CLAUDE_CAPABILITIES } from './builtins/anthropicClaude.js';
import { MACOS_DESKTOP_CAPABILITIES } from './builtins/macosDesktop.js';
import type { ExternalHostCapabilityImplementation } from './types.js';

const BUILTIN_CAPABILITIES = new Map<
  string,
  ExternalHostCapabilityImplementation
>(
  [...MACOS_DESKTOP_CAPABILITIES, ...ANTHROPIC_CLAUDE_CAPABILITIES].map(
    (implementation) => [implementation.id, implementation]
  )
);

export function listBuiltinExternalHostCapabilities(): ExternalHostCapabilityImplementation[] {
  return Array.from(BUILTIN_CAPABILITIES.values());
}

export function resolveBuiltinExternalHostCapability(
  uses: string
): ExternalHostCapabilityImplementation | undefined {
  return BUILTIN_CAPABILITIES.get(uses);
}
