import { execFile } from 'node:child_process';
import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);

export interface ActiveChatOwnership {
  /** Chats with a turn that started and has not completed or aborted. */
  active: number;
  /** Active chats MST did not start in this run. */
  unowned: number;
}

/**
 * Which local chats are mid-turn, and whether MST started each one. A chat is
 * MST's when it began after `sinceMs` with one of MST's submitted queries.
 * Only rollouts written since `sinceMs` are read: MST launched the app then,
 * so an older chat can only be live again if someone resumed it.
 */
export async function activeChatOwnership(
  sessionsRoot: string,
  sinceMs: number,
  queries: ReadonlySet<string>
): Promise<ActiveChatOwnership> {
  const result: ActiveChatOwnership = { active: 0, unowned: 0 };
  for (const file of await rolloutsSince(sessionsRoot, sinceMs)) {
    const chat = await readRollout(file);
    if (chat.started <= chat.ended) continue;
    result.active += 1;
    const owned =
      chat.startedAtMs !== undefined &&
      chat.startedAtMs >= sinceMs &&
      chat.userTexts.some((text) => queries.has(text.trim()));
    if (!owned) result.unowned += 1;
  }
  return result;
}

async function rolloutsSince(root: string, sinceMs: number): Promise<string[]> {
  const found: string[] = [];
  const walk = async (dir: string, depth: number): Promise<void> => {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isDirectory() && depth < 3) await walk(path, depth + 1);
      else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
        const info = await stat(path).catch(() => undefined);
        if (info && info.mtimeMs >= sinceMs) found.push(path);
      }
    }
  };
  // sessions/YYYY/MM/DD/rollout-*.jsonl
  await walk(root, 0);
  return found;
}

async function readRollout(file: string): Promise<{
  started: number;
  ended: number;
  startedAtMs?: number;
  userTexts: string[];
}> {
  const chat = {
    started: 0,
    ended: 0,
    startedAtMs: undefined as number | undefined,
    userTexts: [] as string[],
  };
  const text = await readFile(file, 'utf8').catch(() => '');
  for (const line of text.split('\n')) {
    if (!line) continue;
    let entry: {
      type?: unknown;
      payload?: {
        type?: unknown;
        role?: unknown;
        timestamp?: unknown;
        content?: unknown;
      };
    };
    try {
      entry = JSON.parse(line) as typeof entry;
    } catch {
      continue; // A line still being written.
    }
    const payload = entry.payload;
    if (!payload) continue;
    if (
      entry.type === 'session_meta' &&
      typeof payload.timestamp === 'string'
    ) {
      const ms = Date.parse(payload.timestamp);
      if (Number.isFinite(ms)) chat.startedAtMs = ms;
    } else if (entry.type === 'event_msg') {
      if (payload.type === 'task_started') chat.started += 1;
      else if (
        payload.type === 'task_complete' ||
        payload.type === 'turn_aborted'
      )
        chat.ended += 1;
    } else if (
      payload.type === 'message' &&
      payload.role === 'user' &&
      Array.isArray(payload.content)
    ) {
      for (const part of payload.content as { text?: unknown }[])
        if (typeof part?.text === 'string') chat.userTexts.push(part.text);
    }
  }
  return chat;
}

/** ChatGPT's own confirmation; MST answers only this prompt. */
const QUIT_PROMPT_SCRIPT = `
tell application "System Events"
  if not (exists process "ChatGPT") then return "absent"
  tell process "ChatGPT"
    repeat with w in windows
      try
        if exists button "Quit" of w then
          set texts to value of every static text of w
          set joined to ""
          repeat with t in texts
            set joined to joined & (t as text) & " "
          end repeat
          if joined contains "Quit ChatGPT?" and joined contains "local chats" then
            click button "Quit" of w
            return "confirmed"
          end if
        end if
      end try
    end repeat
  end tell
end tell
return "absent"`;

/**
 * Click Quit on ChatGPT's "Quit ChatGPT? Active local chats on this machine
 * will be interrupted" prompt. Returns false when that prompt is not shown.
 * Needs Accessibility permission, which the Computer Use driver already has.
 */
export async function confirmChatgptQuitPrompt(): Promise<boolean> {
  try {
    const { stdout } = await run('osascript', ['-e', QUIT_PROMPT_SCRIPT], {
      timeout: 15_000,
    });
    return stdout.trim() === 'confirmed';
  } catch {
    return false;
  }
}
