import { z } from 'zod';

/** Native Cowork configuration only; this does not authorize the eval runner to
 * execute writes. Unset/false preserves Cowork's existing approval behavior.
 */
export const CoworkSetupConfigSchema = z
  .object({ approveWriteTools: z.boolean().optional() })
  .strict();

export type CoworkSetupConfig = z.infer<typeof CoworkSetupConfigSchema>;

/** Arm settings inherit defaults; an explicit false cancels a parent opt-in. */
export function resolveCoworkSetupConfig(
  defaults?: CoworkSetupConfig,
  override?: CoworkSetupConfig
): CoworkSetupConfig {
  try {
    const base = CoworkSetupConfigSchema.parse(
      defaults === undefined ? {} : defaults
    );
    const arm = CoworkSetupConfigSchema.parse(
      override === undefined ? {} : override
    );
    return {
      approveWriteTools:
        arm.approveWriteTools ?? base.approveWriteTools ?? false,
    };
  } catch {
    throw new Error('Invalid Cowork setup options.');
  }
}
