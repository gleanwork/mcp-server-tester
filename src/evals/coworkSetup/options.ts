import { z } from 'zod';

/** Native Cowork configuration only; this does not authorize the eval runner to
 * execute writes. Unset/false preserves Cowork's existing approval behavior.
 */
export const CoworkSetupConfigSchema = z
  .object({
    approveWriteTools: z.boolean().optional(),
    /**
     * The hosts Cowork's tools and VM may reach on MST's Linux desktop
     * (Claude Desktop's `coworkEgressAllowedHosts`): `["*"]`, the default,
     * for any public host; `[]` for none. Private and local addresses stay
     * blocked either way. Not applied to a macOS desktop, whose settings
     * MST doesn't own.
     */
    egressAllowedHosts: z.array(z.string().min(1)).max(500).optional(),
    /**
     * Cowork built-in tools to turn off on MST's Linux desktop (Claude
     * Desktop's `disabledBuiltinTools`), e.g. `["WebSearch"]` where the
     * model's provider can't run it. Added to the image's own list, which
     * stays off. Not applied to a macOS desktop.
     */
    disabledBuiltinTools: z.array(z.string().min(1)).max(100).optional(),
    /**
     * Tool search (Claude Desktop's `toolSearchEnabled`), on MST's Linux
     * desktop and in the macOS eval profile: Cowork lists MCP tools by name
     * and loads their definitions when the model asks for them, instead of
     * sending every connector's tools in every request. On unless set to
     * `false`, to match Cowork signed in to claude.ai, whose cloud sessions
     * have it on; Desktop leaves it off with a third-party provider
     * otherwise.
     */
    toolSearch: z.boolean().optional(),
    /**
     * What a headless run does when Cowork asks a clarifying question
     * (`AskUserQuestion`) on MST's Linux desktop. `first-option`, the
     * default, keeps the tool on and answers each question with its first
     * option, as ACE does. `disabled` turns the tool off, so the model
     * proceeds on its best assumption. The macOS eval profile always turns
     * the tool off.
     */
    clarifyingQuestions: z.enum(['first-option', 'disabled']).optional(),
  })
  .strict();

export type CoworkSetupConfig = z.infer<typeof CoworkSetupConfigSchema>;

/** Variant settings inherit defaults; an explicit false cancels a parent opt-in. */
export function resolveCoworkSetupConfig(
  defaults?: CoworkSetupConfig,
  override?: CoworkSetupConfig
): CoworkSetupConfig {
  try {
    const base = CoworkSetupConfigSchema.parse(
      defaults === undefined ? {} : defaults
    );
    const variant = CoworkSetupConfigSchema.parse(
      override === undefined ? {} : override
    );
    const egressAllowedHosts =
      variant.egressAllowedHosts ?? base.egressAllowedHosts;
    const disabledBuiltinTools =
      variant.disabledBuiltinTools ?? base.disabledBuiltinTools;
    const toolSearch = variant.toolSearch ?? base.toolSearch;
    const clarifyingQuestions =
      variant.clarifyingQuestions ?? base.clarifyingQuestions;
    return {
      approveWriteTools:
        variant.approveWriteTools ?? base.approveWriteTools ?? false,
      ...(egressAllowedHosts ? { egressAllowedHosts } : {}),
      ...(disabledBuiltinTools ? { disabledBuiltinTools } : {}),
      ...(toolSearch !== undefined ? { toolSearch } : {}),
      ...(clarifyingQuestions ? { clarifyingQuestions } : {}),
    };
  } catch {
    throw new Error('Invalid Cowork setup options.');
  }
}
