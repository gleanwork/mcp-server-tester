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
    return {
      approveWriteTools:
        variant.approveWriteTools ?? base.approveWriteTools ?? false,
      ...(egressAllowedHosts ? { egressAllowedHosts } : {}),
    };
  } catch {
    throw new Error('Invalid Cowork setup options.');
  }
}
