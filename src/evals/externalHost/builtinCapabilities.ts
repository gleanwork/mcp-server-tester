import { OPENAI_CHATGPT_CAPABILITIES } from './builtins/openaiChatgpt.js';
import type { ExternalHostCapabilityImplementation } from './types.js';

const BUILTIN_CAPABILITIES = new Map<
  string,
  ExternalHostCapabilityImplementation
>(
  OPENAI_CHATGPT_CAPABILITIES.map((implementation) => [
    implementation.id,
    implementation,
  ])
);

export function resolveBuiltinExternalHostCapability(
  uses: string
): ExternalHostCapabilityImplementation | undefined {
  return BUILTIN_CAPABILITIES.get(uses);
}
