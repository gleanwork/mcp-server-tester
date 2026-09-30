import { readdir } from 'node:fs/promises';
import { join } from 'node:path';

export const DEFAULT_APP_NAME = 'Claude';
export const POLL_INTERVAL_MS = 750;

export function formatError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function findFile(
  root: string,
  filename: string
): Promise<string | undefined> {
  const stack = [root];

  while (stack.length > 0) {
    const current = stack.pop()!;
    let entries;
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      const path = join(current, entry.name);
      if (entry.isFile() && entry.name === filename) {
        return path;
      }
      if (entry.isDirectory()) {
        stack.push(path);
      }
    }
  }

  return undefined;
}
