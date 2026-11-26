/**
 * The files a first-party (claude.ai) Cowork task wrote. They stay in the
 * task's cloud VM, so MST reads each one claude.ai serves and saves it as
 * `outputs/` in the session folder, where a local session keeps its own, for
 * the trial's artifacts and its judges.
 *
 * claude.ai lists no session's files, so the paths come from the task: the
 * files it sent the user (`SendUserFile`), the ones its tools wrote, and any
 * other output path its events name.
 */
import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join, posix } from 'node:path';
import type { CloudSessionEvent } from './claudeAi.js';
import { describeError } from '../../utils/describeError.js';

/** The cloud folder Cowork keeps a task's output files in. */
const CLOUD_OUTPUTS_ROOT = '/mnt/user-data/outputs/';
/** Largest file MST saves; its base64 copy fits one cloud-control frame. */
export const MAX_CLOUD_OUTPUT_BYTES = 10 * 1024 * 1024;
/** Most files MST reads per task. */
const MAX_CLOUD_OUTPUT_FILES = 50;
/** Most bytes MST saves per task. */
const MAX_CLOUD_OUTPUT_TOTAL_BYTES = 100 * 1024 * 1024;
/** Waits before each retry of a read that failed transiently. */
let retryDelaysMs: readonly number[] = [1_000, 3_000];

/** Test seam: retry waits, so tests need not sleep through real backoff. */
export function setCloudOutputRetryDelaysForTests(
  delays: readonly number[]
): () => void {
  const previous = retryDelaysMs;
  retryDelaysMs = delays;
  return () => {
    retryDelaysMs = previous;
  };
}

/** What claude.ai answered for one output path. */
export type CloudFileRead =
  | { status: 'saved'; content: string }
  | { status: 'missing' | 'not_a_file' | 'too_large' };

/**
 * Where the task named a path: a file it sent the user, a file one of its
 * tools wrote, or a path its events mention elsewhere.
 */
export type CloudOutputSource = 'sent' | 'written' | 'mentioned';

/** One output path in `outputs.json`. */
export interface CloudOutputRecord {
  path: string;
  source: CloudOutputSource;
  status: 'saved' | 'missing' | 'not_a_file' | 'too_large' | 'error';
  bytes?: number;
  error?: string;
}

/** Tools whose input names a file they wrote. */
const WRITING_TOOLS: Readonly<Record<string, readonly string[]>> = {
  Write: ['file_path'],
  Edit: ['file_path'],
  MultiEdit: ['file_path'],
  NotebookEdit: ['notebook_path'],
};

/**
 * The output file a path names, relative to the outputs folder, or undefined
 * when it names none (a folder, a path outside it, or one that climbs out).
 */
export function cloudOutputName(path: string): string | undefined {
  if (!path.startsWith(CLOUD_OUTPUTS_ROOT) || path.length > 512) return;
  const name = path.slice(CLOUD_OUTPUTS_ROOT.length);
  // eslint-disable-next-line no-control-regex
  if (!name || name.endsWith('/') || /[\u0000-\u001f\\]/.test(name)) return;
  const parts = name.split('/');
  if (parts.some((part) => part === '' || part === '.' || part === '..'))
    return;
  return posix.normalize(name) === name ? name : undefined;
}

function toolUses(
  events: readonly CloudSessionEvent[]
): { name: string; input: Record<string, unknown> }[] {
  return events.flatMap(({ payload }) => {
    const message = payload?.type === 'assistant' ? payload.message : null;
    const content =
      message && typeof message === 'object'
        ? (message as { content?: unknown }).content
        : undefined;
    if (!Array.isArray(content)) return [];
    return content.flatMap((block: unknown) => {
      const use = block as { type?: unknown; name?: unknown; input?: unknown };
      return use?.type === 'tool_use' &&
        typeof use.name === 'string' &&
        use.input &&
        typeof use.input === 'object'
        ? [{ name: use.name, input: use.input as Record<string, unknown> }]
        : [];
    });
  });
}

/**
 * An output path named in free text (a command, a tool result, the answer)
 * runs to its extension: `…/outputs/Q3 report.docx` in
 * `"…/outputs/Q3 report.docx → file_uuid: …"`. Each extension boundary is a
 * candidate (up to three), so `notes.v2.md` is found too. A span ends where
 * the next output path starts.
 */
const MENTION =
  /\/mnt\/user-data\/outputs\/(?:(?!\/mnt\/user-data\/outputs\/)[^"'`\\\n\r\t<>|*?]){1,240}/g;
const EXTENSION_END = /\.[A-Za-z0-9]{1,8}(?![A-Za-z0-9])/g;

function mentionedPaths(text: string): string[] {
  const paths: string[] = [];
  for (const [span] of text.matchAll(MENTION))
    for (const end of [...span.matchAll(EXTENSION_END)].slice(0, 3))
      paths.push(span.slice(0, end.index + end[0].length));
  return paths;
}

/**
 * The output paths a task names, in the order it named them: the files it
 * sent the user, then the files its tools wrote, then the ones its events
 * mention elsewhere.
 */
export function cloudOutputPaths(
  events: readonly CloudSessionEvent[]
): { path: string; source: CloudOutputSource }[] {
  const found = new Map<string, CloudOutputSource>();
  const add = (path: unknown, source: CloudOutputSource) => {
    if (
      typeof path === 'string' &&
      !found.has(path) &&
      cloudOutputName(path) !== undefined
    )
      found.set(path, source);
  };
  const uses = toolUses(events);
  for (const { name, input } of uses)
    if (name === 'SendUserFile' && Array.isArray(input.files))
      for (const file of input.files) add(file, 'sent');
  for (const { name, input } of uses)
    for (const key of WRITING_TOOLS[name] ?? []) add(input[key], 'written');
  for (const { payload } of events)
    if (payload)
      for (const path of mentionedPaths(JSON.stringify(payload)))
        add(path, 'mentioned');
  return [...found].map(([path, source]) => ({ path, source }));
}

/** True once the task's last turn ended: a result after its last reply. */
export function cloudTaskFinished(
  events: readonly CloudSessionEvent[]
): boolean {
  const types = events.map(({ payload }) => payload?.type);
  return types.lastIndexOf('result') > types.lastIndexOf('assistant');
}

async function readWithRetries(
  read: (path: string) => Promise<CloudFileRead>,
  path: string
): Promise<CloudFileRead | { status: 'error'; error: string }> {
  let error: unknown;
  for (let attempt = 0; attempt <= retryDelaysMs.length; attempt++) {
    if (attempt > 0)
      await new Promise((resolve) =>
        setTimeout(resolve, retryDelaysMs[attempt - 1])
      );
    try {
      return await read(path);
    } catch (caught) {
      error = caught;
    }
  }
  return { status: 'error', error: describeError(error).slice(0, 500) };
}

/**
 * Saves the task's output files as `outputs/` in `sessionDir`, replacing any
 * earlier copy, and records them in `outputs.json`. A path claude.ai can't
 * serve is recorded, not fatal: the answer is still the trial's evidence. A
 * mention that names no file is left out; it was a guess from free text.
 */
export async function saveCloudOutputs(
  sessionDir: string,
  events: readonly CloudSessionEvent[],
  read: (path: string) => Promise<CloudFileRead>
): Promise<CloudOutputRecord[]> {
  const paths = cloudOutputPaths(events);
  const records: CloudOutputRecord[] = [];
  const staging = join(sessionDir, 'outputs.partial');
  await rm(staging, { recursive: true, force: true });
  let total = 0;
  for (const [index, { path, source }] of paths.entries()) {
    if (index >= MAX_CLOUD_OUTPUT_FILES) {
      records.push({
        path,
        source,
        status: 'error',
        error: `MST reads at most ${MAX_CLOUD_OUTPUT_FILES} output files per task.`,
      });
      continue;
    }
    const result = await readWithRetries(read, path);
    if (result.status !== 'saved') {
      if (
        source !== 'mentioned' ||
        (result.status !== 'missing' && result.status !== 'not_a_file')
      )
        records.push({ path, source, ...result });
      continue;
    }
    const bytes = Buffer.from(result.content, 'base64');
    if (bytes.length > MAX_CLOUD_OUTPUT_BYTES) {
      records.push({ path, source, status: 'too_large', bytes: bytes.length });
      continue;
    }
    if (total + bytes.length > MAX_CLOUD_OUTPUT_TOTAL_BYTES) {
      records.push({
        path,
        source,
        status: 'error',
        bytes: bytes.length,
        error: `MST saves at most ${MAX_CLOUD_OUTPUT_TOTAL_BYTES / 1024 / 1024} MiB of output files per task.`,
      });
      continue;
    }
    total += bytes.length;
    const target = join(staging, cloudOutputName(path)!);
    await mkdir(dirname(target), { recursive: true, mode: 0o700 });
    await writeFile(target, bytes, { mode: 0o600 });
    records.push({ path, source, status: 'saved', bytes: bytes.length });
  }
  const outputs = join(sessionDir, 'outputs');
  await rm(outputs, { recursive: true, force: true });
  if (records.some((record) => record.status === 'saved'))
    await rename(staging, outputs);
  else await rm(staging, { recursive: true, force: true });
  const manifest = join(sessionDir, 'outputs.json');
  await writeFile(
    `${manifest}.tmp`,
    `${JSON.stringify({ root: CLOUD_OUTPUTS_ROOT, files: records }, null, 2)}\n`,
    { mode: 0o600 }
  );
  await rename(`${manifest}.tmp`, manifest);
  return records;
}
