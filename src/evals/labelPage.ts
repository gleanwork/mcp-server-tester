/**
 * `mst label <run> --judge <name>`: a page on this machine that shows a
 * person one of a judge's trials at a time, without the judge's verdict, and
 * stores their answer as a label (ADR 0009).
 *
 * The page binds to 127.0.0.1 and serves under a random path, and checks the
 * Host header, so another page in the browser can't read the run or write
 * labels.
 */

import { createHash, randomBytes } from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { BUILT_IN_RUBRICS } from '../judge/rubrics.js';
import type {
  EvalCaseResult,
  RunReportEvent,
  TrialResult,
} from '../types/reporter.js';
import { judgedItems, labelKey, type JudgedItem } from './judgedItems.js';
import { labelPageHtml } from './labelPageHtml.js';
import {
  checkImportedLabels,
  defaultSplit,
  readLabels,
  writeLabels,
  type ImportedLabel,
  type LabelSplit,
} from './labels.js';
import { trialTrace } from './runReport.js';
import {
  labelQuestion,
  readRunDirectory,
  type LabelRecord,
  type StoredRun,
} from './runFormat.js';

/** What a trial did, as the page shows it: never its scores. */
interface LabelPageTrial {
  answer?: string;
  /** Whether the client recorded what it called. */
  traced: boolean;
  events: RunReportEvent[];
}

/** One of a pairwise comparison's two sides, shown as A or B. */
interface LabelPageSide {
  /** The label that prefers this side. */
  label: 'baseline' | 'candidate';
  /** The trial the judge compared: the last one that ran. */
  trial: LabelPageTrial;
  /** That trial's index, and how many the case ran. */
  trialIndex: number;
  trialCount: number;
}

/**
 * One verdict to label. It names neither the variant nor the judge's
 * verdict, so neither sways the person.
 */
interface LabelPageItem {
  id: number;
  caseId: string;
  /** Pointwise: the trial's index. */
  trial?: number;
  input?: string;
  /** The answer the case expects, when it gives one. */
  reference?: string;
  split: LabelSplit;
  /** The stored label, when there is one. */
  label?: string;
  note?: string;
  /** Pointwise: the trial. */
  trace?: LabelPageTrial;
  /** Pairwise: the two sides, in an order fixed for the case. */
  sides?: [LabelPageSide, LabelPageSide];
}

/** What the page loads. */
interface LabelPageData {
  runId: string;
  judge: string;
  kind: 'pointwise' | 'pairwise';
  /**
   * The question the judge answers: `--question`, a built-in rubric, or a
   * custom rubric's text. Undefined when MST doesn't know it.
   */
  question?: string;
  items: LabelPageItem[];
}

export interface LabelPageOptions {
  /** The run directory. */
  directory: string;
  /** The judge's name in results, as its labels have it. */
  judge: string;
  /** Who is labeling. @default the OS user name */
  labeler?: string;
  /** The split new labels go in. @default each case's own */
  split?: LabelSplit;
  /** @default 0, any free port */
  port?: number;
  /** The judge's question, for a judge whose question MST doesn't know. */
  question?: string;
}

export interface LabelPageServer {
  /** The page's address, with its random path. */
  url: string;
  data: LabelPageData;
  /** How many labels the page has stored since it started. */
  written(): number;
  close(): Promise<void>;
}

/** The largest request body the page accepts: a label and a note. */
const MAX_BODY = 64 * 1024;

/**
 * Starts the label page for a run's judge. Throws when the run has no
 * answers to show (it redacts stored responses) or no verdicts from the
 * judge.
 */
export async function startLabelPage(
  options: LabelPageOptions
): Promise<LabelPageServer> {
  const stored = await readRunDirectory(options.directory);
  if (stored.run.redactStoredResponses)
    throw new Error(
      `Run ${stored.run.runId} redacts stored responses, so it has no answers to label. Collect it again with "redactStoredResponses": false in the eval config, or label from another tool with mst label import.`
    );
  const all = judgedItems(stored);
  // One item per label: a question judged twice (by two models, say) gave
  // two verdicts that share one label.
  const keys = new Set<string>();
  const items = all.filter((item) => {
    if (labelQuestion(item) !== options.judge || item.verdict === undefined)
      return false;
    const key = labelKey(item);
    if (keys.has(key)) return false;
    keys.add(key);
    return true;
  });
  if (items.length === 0) {
    const names = [...new Set(all.map((item) => labelQuestion(item)))].sort();
    throw new Error(
      `Run ${stored.run.runId} has no verdicts from ${options.judge}${names.length ? `; its judges are ${names.join(', ')}` : ''}.`
    );
  }
  const labels = new Map(
    (await readLabels(options.directory)).map((label) => [
      labelKey(label),
      label,
    ])
  );
  // Every label of a case shares its split, so a case read while changing
  // a judge never measures it: a new label takes the split its case's
  // labels already have, then --split, then the default.
  const caseSplits = new Map<string, LabelSplit>();
  for (const label of labels.values())
    if (!caseSplits.has(label.caseId))
      caseSplits.set(label.caseId, label.split);
  function caseSplit(caseId: string): LabelSplit {
    return caseSplits.get(caseId) ?? options.split ?? defaultSplit(caseId);
  }
  const order = items
    .map((item) => ({ item, rank: hash(stored.run.runId, labelKey(item)) }))
    .sort((a, b) => a.rank.localeCompare(b.rank))
    .map(({ item }) => item);
  const data = pageData(
    stored,
    options.judge,
    order,
    labels,
    caseSplit,
    options.question
  );
  const token = randomBytes(18).toString('base64url');
  const html = labelPageHtml();
  let written = 0;

  async function label(body: unknown): Promise<LabelRecord> {
    const { id, label, note } = (body ?? {}) as Record<string, unknown>;
    const item = typeof id === 'number' ? order[id] : undefined;
    if (!item) throw new LabelPageError(404, 'No such item.');
    if (typeof label !== 'string')
      throw new LabelPageError(400, 'A label is a string.');
    if (note !== undefined && typeof note !== 'string')
      throw new LabelPageError(400, 'A note is a string.');
    const imported: ImportedLabel = {
      judge: item.judge,
      ...(item.criterion !== undefined ? { criterion: item.criterion } : {}),
      variant: item.variant,
      caseId: item.caseId,
      ...(item.trial !== undefined ? { trial: item.trial } : {}),
      ...(item.baseline !== undefined ? { baseline: item.baseline } : {}),
      label,
      // A label given again keeps its split; a new one takes its case's.
      ...(labels.has(labelKey(item)) ? {} : { split: caseSplit(item.caseId) }),
      ...(note ? { note } : {}),
      source: 'the label page',
    };
    let records: LabelRecord[];
    try {
      records = checkImportedLabels([imported], all, [...labels.values()], {
        ...(options.labeler !== undefined ? { labeler: options.labeler } : {}),
      });
    } catch (error) {
      throw new LabelPageError(
        400,
        error instanceof Error ? error.message : String(error)
      );
    }
    await writeLabels(options.directory, records);
    const record = records[0]!;
    labels.set(labelKey(record), record);
    if (!caseSplits.has(record.caseId))
      caseSplits.set(record.caseId, record.split);
    const shown = data.items[id as number]!;
    shown.label = record.label;
    shown.split = record.split;
    if (record.note !== undefined) shown.note = record.note;
    else delete shown.note;
    written++;
    return record;
  }

  const server = http.createServer((request, response) => {
    handle(request, response).catch((error: unknown) => {
      const status = error instanceof LabelPageError ? error.status : 500;
      send(response, status, {
        error: error instanceof Error ? error.message : String(error),
      });
    });
  });

  async function handle(
    request: http.IncomingMessage,
    response: http.ServerResponse
  ): Promise<void> {
    const { port } = server.address() as AddressInfo;
    const host = request.headers.host;
    if (!isLabelPageHost(host, port))
      throw new LabelPageError(403, 'Wrong host.');
    const url = new URL(request.url ?? '/', `http://${host}`);
    const prefix = `/${token}/`;
    if (!url.pathname.startsWith(prefix))
      throw new LabelPageError(404, 'Not found.');
    const route = url.pathname.slice(prefix.length);
    if (request.method === 'GET' && route === '') {
      response.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-store',
        'content-security-policy':
          "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'",
      });
      response.end(html);
      return;
    }
    if (request.method === 'GET' && route === 'api/items') {
      send(response, 200, data);
      return;
    }
    if (request.method === 'POST' && route === 'api/label') {
      if (!request.headers['content-type']?.startsWith('application/json'))
        throw new LabelPageError(415, 'Send JSON.');
      const record = await label(await readJson(request));
      send(response, 200, { label: record.label, split: record.split });
      return;
    }
    throw new LabelPageError(404, 'Not found.');
  }

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port ?? 0, '127.0.0.1', () => resolve());
  });
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/${token}/`,
    data,
    written: () => written,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections();
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}

class LabelPageError extends Error {
  constructor(
    readonly status: number,
    message: string
  ) {
    super(message);
  }
}

function send(
  response: http.ServerResponse,
  status: number,
  body: unknown
): void {
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  response.end(JSON.stringify(body));
}

async function readJson(request: http.IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY) throw new LabelPageError(413, 'Too large.');
    chunks.push(chunk as Buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  } catch {
    throw new LabelPageError(400, 'Not JSON.');
  }
}

/** A stable order that mixes the variants, so their trials don't come in runs. */
function hash(...parts: string[]): string {
  return createHash('sha256').update(parts.join('\0')).digest('hex');
}

/**
 * Whether a request's Host names the page, so another site's page can't
 * reach it through DNS rebinding. A browser leaves port 80 out of Host.
 */
export function isLabelPageHost(
  host: string | undefined,
  port: number
): boolean {
  if (host === undefined) return false;
  return ['127.0.0.1', 'localhost'].some(
    (name) => host === `${name}:${port}` || (port === 80 && host === name)
  );
}

/**
 * The question a judge answers, when the run says: a built-in rubric's
 * text, or a custom rubric's. A custom rubric (`{ text }`) is named
 * `rubric`, so it has a question only when every case's text is the same.
 */
function questionOf(stored: StoredRun, judge: string): string | undefined {
  if (judge in BUILT_IN_RUBRICS)
    return BUILT_IN_RUBRICS[judge as keyof typeof BUILT_IN_RUBRICS];
  const texts = new Set<string>();
  for (const variant of stored.summary.variants)
    for (const result of variant.result?.caseResults ?? []) {
      const judges = (result.request as { judges?: unknown } | undefined)
        ?.judges;
      for (const entry of Array.isArray(judges) ? judges : []) {
        const { type, rubric, options } = entry as {
          type?: unknown;
          rubric?: unknown;
          options?: { rubric?: unknown };
        };
        if (type !== 'rubric' || judge !== 'rubric') continue;
        // As grading reads it: `options` wins over the flat shorthand.
        const text = (
          (options?.rubric ?? rubric) as { text?: unknown } | undefined
        )?.text;
        if (typeof text === 'string') texts.add(text);
      }
    }
  return texts.size === 1 ? [...texts][0] : undefined;
}

function pageData(
  stored: StoredRun,
  judge: string,
  items: readonly JudgedItem[],
  labels: ReadonlyMap<string, LabelRecord>,
  splitOf: (caseId: string) => LabelSplit,
  question: string | undefined
): LabelPageData {
  const cases = new Map<string, EvalCaseResult>();
  for (const variant of stored.summary.variants)
    for (const result of variant.result?.caseResults ?? [])
      cases.set(`${variant.name}\0${result.id}`, result);
  const trialsOf = (variant: string, caseId: string) => {
    const result = cases.get(`${variant}\0${caseId}`);
    if (!result) return [];
    const trials: Array<TrialResult | EvalCaseResult> = result.trialResults
      ?.length
      ? result.trialResults
      : [result];
    return trials;
  };
  // A pairwise judge compares each side's case result, which is the last
  // trial that ran (evalRunner keeps it); a trial that threw has no trace.
  const sideOf = (
    label: LabelPageSide['label'],
    variant: string,
    caseId: string
  ): LabelPageSide => {
    const trials = trialsOf(variant, caseId);
    let index = trials.length - 1;
    while (index > 0 && !('trace' in trials[index]! && trials[index]!.trace))
      index--;
    const trial = trials[index];
    return {
      label,
      trial: trial ? pageTrial(trial) : { traced: false, events: [] },
      trialIndex: Math.max(index, 0),
      trialCount: trials.length,
    };
  };
  const pairwise = items.some((item) => item.baseline !== undefined);
  const known = question ?? questionOf(stored, judge);
  return {
    runId: stored.run.runId,
    judge,
    kind: pairwise ? 'pairwise' : 'pointwise',
    ...(known !== undefined ? { question: known } : {}),
    items: items.map((item, id): LabelPageItem => {
      const caseResult = cases.get(`${item.variant}\0${item.caseId}`);
      const existing = labels.get(labelKey(item));
      const reference = (
        caseResult?.request as { reference?: unknown } | undefined
      )?.reference;
      const base = {
        id,
        caseId: item.caseId,
        ...(item.input !== undefined ? { input: item.input } : {}),
        ...(typeof reference === 'string' ? { reference } : {}),
        split: existing?.split ?? splitOf(item.caseId),
        ...(existing ? { label: existing.label } : {}),
        ...(existing?.note !== undefined ? { note: existing.note } : {}),
      };
      if (item.baseline === undefined) {
        const trial = trialsOf(item.variant, item.caseId)[item.trial ?? 0];
        return {
          ...base,
          trial: item.trial ?? 0,
          trace: trial ? pageTrial(trial) : { traced: false, events: [] },
        };
      }
      const baseline = sideOf('baseline', item.baseline, item.caseId);
      const candidate = sideOf('candidate', item.variant, item.caseId);
      // Which side is A is fixed for the case but not always the baseline.
      const flip =
        parseInt(
          hash(
            stored.run.runId,
            item.baseline,
            item.variant,
            item.caseId
          ).slice(0, 2),
          16
        ) %
          2 ===
        1;
      return {
        ...base,
        sides: flip ? [candidate, baseline] : [baseline, candidate],
      };
    }),
  };
}

function pageTrial(trial: TrialResult | EvalCaseResult): LabelPageTrial {
  const { traced, events } = trialTrace(trial);
  // The whole answer, as the judge read it; the report shortens it.
  const answer = (trial as { trace?: { finalText?: string } }).trace?.finalText;
  return {
    ...(answer ? { answer } : {}),
    traced: traced ?? false,
    events,
  };
}
