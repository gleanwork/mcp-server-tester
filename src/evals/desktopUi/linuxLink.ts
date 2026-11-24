/**
 * How a link reaches an app on Linux: one bounded run of the URL opener
 * (`xdg-open`, or the one the image names), without a shell. Both Linux
 * transports of the desktop interface open links this way.
 */
import { execFile, type ChildProcess } from 'node:child_process';
import { isAbsolute } from 'node:path';
import { DesktopUiError } from './desktopUi.js';

export interface LinuxLinkOptions {
  env: Record<string, string | undefined>;
  deadlineAt: number;
  /** The program that hands a link to the app. Default: `xdg-open`. */
  opener?: string;
  /** Sees the opener's process while it runs, so a close can stop it. */
  track?: (child: ChildProcess, done: boolean) => void;
}

/** Fails with `code` when the opener fails. Never retried. */
export async function openLinuxLink(
  url: string,
  code: string,
  options: LinuxLinkOptions
): Promise<void> {
  const { opener } = options;
  if (opener !== undefined && !isAbsolute(opener))
    throw new DesktopUiError('invalid_url_opener');
  const remaining = options.deadlineAt - Date.now();
  if (remaining <= 0) throw new DesktopUiError('deadline_exceeded');
  await new Promise<void>((resolve, reject) => {
    const child = execFile(
      opener ?? 'xdg-open',
      [url],
      {
        env: options.env,
        shell: false,
        timeout: Math.min(15_000, remaining),
        killSignal: 'SIGKILL',
        maxBuffer: 64 * 1024,
      },
      (error) => {
        options.track?.(child, true);
        if (error) reject(new DesktopUiError(code));
        else resolve();
      }
    );
    options.track?.(child, false);
  });
}
