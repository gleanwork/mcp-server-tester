import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** Both macOS modes drive one app; Linux desktops are scoped to their data directory. */
export function coworkDesktopLease(
  dataDirectory: string,
  os: NodeJS.Platform = process.platform
): { directory: string; file: string } {
  return {
    directory: join(homedir(), '.mcp-server-tester'),
    file:
      os === 'darwin'
        ? 'cowork-desktop-macos.lock'
        : `cowork-desktop-${createHash('sha256').update(dataDirectory).digest('hex').slice(0, 12)}.lock`,
  };
}
