import { OPENAI_CHATGPT_CAPABILITIES } from './builtins/openaiChatgpt.js';
import type { ExternalClientCapabilityImplementation } from './types.js';

const BUILTIN_CAPABILITIES = new Map<
  string,
  ExternalClientCapabilityImplementation
>(
  OPENAI_CHATGPT_CAPABILITIES.map((implementation) => [
    implementation.id,
    implementation,
  ])
);

export function resolveBuiltinExternalClientCapability(
  uses: string
): ExternalClientCapabilityImplementation | undefined {
  return BUILTIN_CAPABILITIES.get(uses);
}
