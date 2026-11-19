/**
 * The failure of a native UI read or action. In its own module so a bundle
 * that only needs the error, such as the macOS desktop drivers, leaves the
 * AT-SPI bus (`linuxAtspiBus.ts`) out.
 */

/** A failure with a stable, allowlistable code and no native detail. */
export class AtspiError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = 'LinuxUiError';
  }
}
