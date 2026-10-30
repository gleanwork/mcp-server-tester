/**
 * Staged pairwise judges: an agentic pairwise judge described as data.
 *
 * A bundle is plain JSON: the files the judge needs (prompts, helper scripts),
 * trusted `prepare` programs that turn both trials into the judge's evidence
 * layout, and a graph of agent stages. Each stage is one agent run in the same
 * workspace; its prompt is built from bundle files, text and JSON, and can
 * quote what earlier stages answered. Stages whose dependencies are done run
 * in parallel. The judge's preference comes from verdict stages, each
 * answering `{ "preferred": "A" | "B" | "tie", "gap_score": 0-5 }` about
 * slots A and B.
 *
 * So a judge written and maintained elsewhere (say, a team's production judge
 * as prompt files) runs in MST without being reimplemented: a plugin builds the
 * bundle from those files and registers `stagedPairwiseJudge(bundle)`.
 *
 * Which run is slot A is the bundle's `order`: `randomized` (default) picks it
 * per case from a hash of `seed`, so the judge never knows which run is the
 * baseline and MST doesn't also swap positions; `baseline-first` puts the
 * baseline in A and lets MST swap.
 *
 * Workspace layout: `a/` and `b/` hold the trials in slots A and B, as for
 * `agenticPairwiseJudge` (`response.md`, `trace/`, `artifacts/`), `case.json`
 * the case, and the bundle's files at their paths. `prepare` programs run in
 * it, unsandboxed, as the plugin's own code would; agents then get it (or
 * its `workdir`) read-only. Placeholders' `{{workspace}}` is always the root.
 */

import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { z } from 'zod';
import type { JudgeCase, JudgeTrial } from '../judgeContract.js';
import { contentHash, sortKeys } from '../judgeIdentity.js';
import type {
  PairwiseDimension,
  PairwiseJudgeDefinition,
  PairwiseJudgeInput,
  PairwisePreference,
} from '../pairwiseContract.js';
import type { UsageMetrics } from '../judgeTypes.js';
import {
  AgentJudgeOptionsSchema,
  agentRuntime,
  optionsSchema,
  preflightRuntime,
  settings,
} from './agenticJudge.js';
import { runtimeEnv, type AgentJudgeResult } from './runtime.js';
import {
  confinedPath,
  createWorkspace,
  put,
  trialArtifacts,
  trialFiles,
  type WorkspaceFile,
} from './workspace.js';

/** Most of a failed `prepare` program's output kept in the error. */
const PREPARE_ERROR_TAIL = 2_000;
/** A verdict's gap: 0 (even) to 5 (decisive). */
const MAX_GAP = 5;

const BundleFileSchema = z.union([
  z.object({ path: z.string().min(1), content: z.string() }).strict(),
  z.object({ path: z.string().min(1), base64: z.string() }).strict(),
]);

/**
 * A piece of a prompt or written file: a bundle file verbatim, text, or JSON.
 * Text and JSON strings can hold placeholders (see `render`).
 */
const PartSchema = z.union([
  z.object({ file: z.string().min(1) }).strict(),
  z.object({ text: z.string() }).strict(),
  z
    .object({
      json: z.unknown(),
      /**
       * `pretty`: indented, sorted keys. `python`: one line, sorted keys,
       * `", "`/`": "` separators and non-ASCII escaped, as Python's
       * `json.dumps(..., sort_keys=True)` prints it, for prompts written
       * against that.
       */
      format: z.enum(['pretty', 'python']).default('pretty'),
    })
    .strict(),
]);
export type StagedJudgePart = z.input<typeof PartSchema>;

const StageSchema = z
  .object({
    id: z.string().regex(/^[A-Za-z0-9_-]+$/),
    /** Stages that must finish first. Only these can be quoted. */
    after: z.array(z.string()).default([]),
    system: z.array(PartSchema).optional(),
    prompt: z.array(PartSchema).min(1),
    /** Files written into the workspace before the stage runs. */
    writes: z
      .array(
        z
          .object({ path: z.string().min(1), content: z.array(PartSchema) })
          .strict()
      )
      .default([]),
    /**
     * `text`: any non-empty answer. `json`: the first JSON object in the
     * answer. `verdict`: a JSON A/B verdict (see the module comment).
     */
    output: z.enum(['text', 'json', 'verdict']).default('text'),
    /** Keys the answer must not contain at any depth, if it is JSON. */
    forbidKeys: z.array(z.string()).default([]),
    maxTurns: z.number().int().positive().optional(),
    model: z.string().min(1).optional(),
    effort: z.string().min(1).optional(),
  })
  .strict();
export type StagedJudgeStage = z.input<typeof StageSchema>;

export const StagedJudgeBundleSchema = z
  .object({
    schemaVersion: z.literal(1),
    name: z.string().min(1),
    description: z.string().optional(),
    /**
     * Input paths the judge needs, such as `candidate.artifactsDir`: when one
     * is missing, the comparison is recorded as skipped.
     */
    requires: z.array(z.string()).default([]),
    /** Recorded with every preference. Default: the bundle's SHA-256. */
    version: z.string().min(1).optional(),
    files: z.array(BundleFileSchema).default([]),
    /** Helper programs agents may run, as for `agenticPairwiseJudge`. */
    commands: z
      .array(
        z
          .object({
            name: z.string().min(1),
            description: z.string(),
            argv: z.array(z.string()).min(1),
            timeoutMs: z.number().int().positive().optional(),
          })
          .strict()
      )
      .default([]),
    /**
     * Where, under the workspace, agents start and are confined to: a
     * directory `prepare` lays out, such as one holding only the judge's
     * evidence. Default the workspace root.
     */
    workdir: z.string().min(1).optional(),
    /** Trusted programs run in the workspace, in order, before any stage. */
    prepare: z
      .array(
        z
          .object({
            argv: z.array(z.string()).min(1),
            timeoutMs: z.number().int().positive().default(120_000),
          })
          .strict()
      )
      .default([]),
    order: z
      .object({
        mode: z.enum(['randomized', 'baseline-first']).default('randomized'),
        /** Hashed to pick slot A; placeholders allowed. */
        seed: z.array(z.string()).default(['{{case.id}}']),
      })
      .strict()
      .default({ mode: 'randomized', seed: ['{{case.id}}'] }),
    stages: z.array(StageSchema).min(1),
    result: z
      .object({
        /** The verdict stage that decides the preference. */
        overall: z.string(),
        /** Named dimensions, from verdict stages. */
        dimensions: z.record(z.string(), z.string()).default({}),
      })
      .strict(),
    defaults: AgentJudgeOptionsSchema.optional(),
  })
  .strict();
export type StagedJudgeBundle = z.input<typeof StagedJudgeBundleSchema>;
type Bundle = z.output<typeof StagedJudgeBundleSchema>;
type Stage = z.output<typeof StageSchema>;
type Part = z.output<typeof PartSchema>;

/** A slot A/B verdict, and what it means for the candidate. */
export interface SlotVerdict {
  preferred: 'A' | 'B' | 'tie';
  gap: number;
  /** -5 to 5: positive favors the candidate. */
  advantage: number;
  explanation?: string;
}

interface StageResult {
  text: string;
  json?: unknown;
  verdict?: SlotVerdict;
  agent: AgentJudgeResult;
}

const PLACEHOLDER = /\{\{\s*([^}]+?)\s*\}\}/g;

/** The first JSON object in `text`, allowing prose or fences around it. */
export function firstJsonObject(text: string): Record<string, unknown> {
  const start = text.indexOf('{');
  if (start < 0) throw new Error('no JSON object in the answer');
  let depth = 0;
  let inString = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (ch === '\\') i++;
      else if (ch === '"') inString = false;
    } else if (ch === '"') inString = true;
    else if (ch === '{') depth++;
    else if (ch === '}' && --depth === 0) {
      const parsed: unknown = JSON.parse(text.slice(start, i + 1));
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed))
        return parsed as Record<string, unknown>;
      break;
    }
  }
  throw new Error('the answer has no complete JSON object');
}

function absoluteScore(raw: Record<string, unknown>, key: string): number {
  const value = raw[key];
  if (typeof value !== 'number' || !Number.isFinite(value))
    throw new Error(`${key} must be a number from 0 to 10`);
  if (value < 0 || value > 10)
    throw new Error(`${key} must be a number from 0 to 10`);
  return value;
}

/**
 * A verdict from a stage's JSON answer: `preferred` A, B or tie and
 * `gap_score` 0-5 (or both `absolute_score_a`/`_b` 0-10, whose difference
 * maps to the gap). A tie must have gap 0.
 */
export function parseSlotVerdict(
  raw: Record<string, unknown>,
  aIsCandidate: boolean
): SlotVerdict {
  const preferred =
    typeof raw.preferred === 'string' ? raw.preferred.trim().toLowerCase() : '';
  if (preferred !== 'a' && preferred !== 'b' && preferred !== 'tie')
    throw new Error('preferred must be one of A, B, or tie');
  const hasA = 'absolute_score_a' in raw;
  const hasB = 'absolute_score_b' in raw;
  if (hasA !== hasB)
    throw new Error(
      'absolute_score_a and absolute_score_b must be provided together'
    );
  let gap: number;
  if (raw.gap_score === undefined && hasA) {
    gap =
      (Math.abs(
        absoluteScore(raw, 'absolute_score_a') -
          absoluteScore(raw, 'absolute_score_b')
      ) *
        MAX_GAP) /
      10;
  } else {
    if (typeof raw.gap_score !== 'number' || !Number.isFinite(raw.gap_score))
      throw new Error('gap_score must be a number from 0 to 5');
    gap = raw.gap_score;
    if (gap < 0 || gap > MAX_GAP)
      throw new Error('gap_score must be a number from 0 to 5');
  }
  if (preferred === 'tie' && gap !== 0)
    throw new Error('tie verdict must use gap_score 0');
  const candidateSlot = aIsCandidate ? 'a' : 'b';
  const advantage =
    preferred === 'tie' ? 0 : preferred === candidateSlot ? gap : -gap;
  return {
    preferred: preferred === 'tie' ? 'tie' : (preferred.toUpperCase() as 'A'),
    gap,
    advantage,
    ...(typeof raw.explanation === 'string' && {
      explanation: raw.explanation,
    }),
  };
}

function hasKey(value: unknown, keys: ReadonlySet<string>): boolean {
  if (Array.isArray(value)) return value.some((v) => hasKey(v, keys));
  if (value && typeof value === 'object')
    return Object.entries(value).some(
      ([k, v]) => keys.has(k) || hasKey(v, keys)
    );
  return false;
}

/** `json.dumps(value, sort_keys=True)` as Python prints it. */
export function pythonJson(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  if (Array.isArray(value)) return `[${value.map(pythonJson).join(', ')}]`;
  if (typeof value === 'object')
    return `{${Object.keys(value)
      .sort()
      .map(
        (k) =>
          `${pythonJson(k)}: ${pythonJson((value as Record<string, unknown>)[k])}`
      )
      .join(', ')}}`;
  if (typeof value === 'string')
    return JSON.stringify(value).replace(
      /[\u007f-\uffff]/g,
      (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`
    );
  return JSON.stringify(value);
}

/** Everything a placeholder can name, at render time. */
interface RenderContext {
  workspace: string;
  case: JudgeCase;
  stages: ReadonlyMap<string, StageResult>;
}

/** The case's prompt, or its whole input as JSON when it has none. */
function caseInput(evalCase: JudgeCase): string {
  return typeof evalCase.input.prompt === 'string'
    ? evalCase.input.prompt
    : JSON.stringify(evalCase.input);
}

/**
 * A placeholder's value:
 * - `workspace`: the workspace's absolute path;
 * - `case.id`, `case.input` (the case's prompt);
 * - `stages.<id>.text`, `stages.<id>.json`: an earlier stage's answer;
 * - `file.text:<path>`, `file.json:<path>`: a workspace file, as written by
 *   `prepare` or an earlier stage.
 */
async function resolvePlaceholder(
  name: string,
  ctx: RenderContext
): Promise<unknown> {
  if (name === 'workspace') return ctx.workspace;
  if (name === 'case.id') return ctx.case.id;
  if (name === 'case.input') return caseInput(ctx.case);
  const stage = /^stages\.([A-Za-z0-9_-]+)\.(text|json)$/.exec(name);
  if (stage) {
    const result = ctx.stages.get(stage[1]!);
    if (!result) throw new Error(`Stage ${stage[1]} has not run`);
    if (stage[2] === 'text') return result.text;
    if (result.json === undefined)
      throw new Error(`Stage ${stage[1]} answered no JSON`);
    return result.json;
  }
  const file = /^file\.(text|json):(.+)$/.exec(name);
  if (file) {
    const content = await readFile(
      confinedPath(ctx.workspace, file[2]!),
      'utf8'
    );
    return file[1] === 'json' ? JSON.parse(content) : content;
  }
  throw new Error(`Unknown placeholder {{${name}}}`);
}

async function renderString(value: string, ctx: RenderContext) {
  let out = '';
  let last = 0;
  for (const match of value.matchAll(PLACEHOLDER)) {
    const resolved = await resolvePlaceholder(match[1]!, ctx);
    out += value.slice(last, match.index);
    out += typeof resolved === 'string' ? resolved : JSON.stringify(resolved);
    last = match.index + match[0].length;
  }
  return out + value.slice(last);
}

/** JSON with placeholders filled: a string that is one placeholder takes its value. */
async function renderJson(
  value: unknown,
  ctx: RenderContext
): Promise<unknown> {
  if (typeof value === 'string') {
    const whole = /^\{\{\s*([^}]+?)\s*\}\}$/.exec(value);
    return whole
      ? resolvePlaceholder(whole[1]!, ctx)
      : renderString(value, ctx);
  }
  if (Array.isArray(value))
    return Promise.all(value.map((v) => renderJson(v, ctx)));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value))
      out[k] = await renderJson(v, ctx);
    return out;
  }
  return value;
}

async function renderParts(
  parts: readonly Part[],
  files: ReadonlyMap<string, string>,
  ctx: RenderContext
): Promise<string> {
  const out: string[] = [];
  for (const part of parts) {
    if ('file' in part) out.push(files.get(part.file)!);
    else if ('text' in part) out.push(await renderString(part.text, ctx));
    else {
      const value = await renderJson(part.json, ctx);
      out.push(
        part.format === 'python'
          ? pythonJson(value)
          : `${JSON.stringify(sortKeys(value), null, 2)}\n`
      );
    }
  }
  return out.join('');
}

/** Stage ids a part list quotes. */
function quotedStages(parts: readonly Part[]): string[] {
  const ids: string[] = [];
  const scan = (value: unknown) => {
    if (typeof value === 'string')
      for (const m of value.matchAll(PLACEHOLDER)) {
        const s = /^stages\.([A-Za-z0-9_-]+)\./.exec(m[1]!);
        if (s) ids.push(s[1]!);
      }
    else if (Array.isArray(value)) value.forEach(scan);
    else if (value && typeof value === 'object')
      Object.values(value).forEach(scan);
  };
  for (const part of parts)
    scan('text' in part ? part.text : 'json' in part ? part.json : undefined);
  return ids;
}

/** Checks references and the stage graph; returns stages in dependency waves. */
function plan(bundle: Bundle): Stage[][] {
  const byId = new Map<string, Stage>();
  for (const stage of bundle.stages) {
    if (byId.has(stage.id)) throw new Error(`Duplicate stage ${stage.id}`);
    byId.set(stage.id, stage);
  }
  const paths = new Set(bundle.files.map((f) => f.path));
  const textFiles = new Set(
    bundle.files.filter((f) => 'content' in f).map((f) => f.path)
  );
  const ancestors = new Map<string, Set<string>>();
  const visiting = new Set<string>();
  const ancestorsOf = (id: string): Set<string> => {
    const known = ancestors.get(id);
    if (known) return known;
    if (visiting.has(id)) throw new Error(`Stage cycle through ${id}`);
    visiting.add(id);
    const out = new Set<string>();
    for (const dep of byId.get(id)!.after) {
      if (!byId.has(dep))
        throw new Error(`Stage ${id} is after unknown ${dep}`);
      out.add(dep);
      for (const a of ancestorsOf(dep)) out.add(a);
    }
    visiting.delete(id);
    ancestors.set(id, out);
    return out;
  };
  for (const stage of bundle.stages) {
    const before = ancestorsOf(stage.id);
    const parts = [
      ...stage.prompt,
      ...(stage.system ?? []),
      ...stage.writes.flatMap((w) => w.content),
    ];
    for (const part of parts)
      if ('file' in part && !textFiles.has(part.file))
        throw new Error(
          `Stage ${stage.id} quotes ${part.file}, not a text file in the bundle`
        );
    for (const quoted of quotedStages(parts))
      if (!before.has(quoted))
        throw new Error(
          `Stage ${stage.id} quotes stage ${quoted}, which is not before it`
        );
  }
  for (const [name, id] of [
    ['overall', bundle.result.overall],
    ...Object.entries(bundle.result.dimensions),
  ] as const) {
    if (byId.get(id)?.output !== 'verdict')
      throw new Error(`Result ${name} names ${id}, not a verdict stage`);
  }
  for (const file of bundle.files) confinedPath('/w', file.path);
  if (paths.size !== bundle.files.length)
    throw new Error('Duplicate bundle file path');
  const waves: Stage[][] = [];
  const done = new Set<string>();
  while (done.size < byId.size) {
    const wave = bundle.stages.filter(
      (s) => !done.has(s.id) && s.after.every((d) => done.has(d))
    );
    wave.forEach((s) => done.add(s.id));
    waves.push(wave);
  }
  return waves;
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

/** Whether slot A holds the candidate, from a hash of the seed. */
export function aIsCandidate(seed: readonly string[]): boolean {
  return createHash('sha256').update(seed.join('\x1f')).digest()[0]! >= 128;
}

function addUsage(total: Partial<UsageMetrics>, more: Partial<UsageMetrics>) {
  for (const [key, value] of Object.entries(more))
    if (typeof value === 'number')
      (total as Record<string, number>)[key] =
        ((total as Record<string, number>)[key] ?? 0) + value;
}

function runPrepare(
  argv: readonly string[],
  cwd: string,
  timeoutMs: number
): Promise<void> {
  const [program, ...args] = argv;
  return new Promise((resolvePromise, reject) => {
    execFile(
      program!,
      args,
      {
        cwd,
        env: runtimeEnv([]),
        timeout: timeoutMs,
        maxBuffer: 16 * 1024 * 1024,
        windowsHide: true,
      },
      (err, stdout, stderr) => {
        if (!err) return resolvePromise();
        const tail = `${stdout}${stderr}`.trim().slice(-PREPARE_ERROR_TAIL);
        reject(
          new Error(`prepare ${argv.join(' ')} failed: ${err.message}\n${tail}`)
        );
      }
    );
  });
}

function slotFiles(evalCase: JudgeCase, a: JudgeTrial, b: JudgeTrial) {
  return [
    ...trialFiles(evalCase, a, 'a').filter((f) => f.path !== 'a/case.json'),
    ...trialFiles(evalCase, b, 'b').filter((f) => f.path !== 'b/case.json'),
    { path: 'case.json', content: `${JSON.stringify(evalCase, null, 2)}\n` },
  ];
}

/** An agentic pairwise judge from a bundle (see the module comment). */
export function stagedPairwiseJudge(
  input: StagedJudgeBundle
): PairwiseJudgeDefinition {
  const bundle = StagedJudgeBundleSchema.parse(input);
  const waves = plan(bundle);
  const version = bundle.version ?? contentHash(input);
  const textFiles = new Map(
    bundle.files.flatMap((f) => ('content' in f ? [[f.path, f.content]] : []))
  );
  const files: WorkspaceFile[] = bundle.files.map((f) => ({
    path: f.path,
    content: 'content' in f ? f.content : Buffer.from(f.base64, 'base64'),
  }));
  const spec = { ...(bundle.defaults && { defaults: bundle.defaults }) };

  async function compare(
    { case: evalCase, baseline, candidate }: PairwiseJudgeInput,
    options: Record<string, unknown>
  ): Promise<PairwisePreference> {
    const config = settings(spec, options);
    const runtime = agentRuntime(config.runtime);
    const started = Date.now();
    const seedCtx = {
      workspace: '',
      case: evalCase,
      stages: new Map<string, StageResult>(),
    };
    const seed = await Promise.all(
      bundle.order.seed.map((s) => renderString(s, seedCtx))
    );
    const candidateIsA =
      bundle.order.mode === 'randomized' && aIsCandidate(seed);
    const [a, b] = candidateIsA ? [candidate, baseline] : [baseline, candidate];
    const workspace = await createWorkspace(
      [...slotFiles(evalCase, a, b), ...files],
      {
        keep: config.keepWorkspace,
        artifacts: [...trialArtifacts(a, 'a'), ...trialArtifacts(b, 'b')],
      }
    );
    try {
      for (const step of bundle.prepare)
        await runPrepare(step.argv, workspace.root, step.timeoutMs);
      const workdir = bundle.workdir
        ? confinedPath(workspace.root, bundle.workdir)
        : workspace.root;
      if (bundle.workdir && !(await isDirectory(workdir)))
        throw new Error(
          `The judge's workdir ${bundle.workdir} was not prepared`
        );
      const results = new Map<string, StageResult>();
      const ctx = {
        workspace: workspace.root,
        case: evalCase,
        stages: results,
      };
      const runStage = async (stage: Stage): Promise<void> => {
        for (const w of stage.writes)
          await put(workspace.root, {
            path: w.path,
            content: await renderParts(w.content, textFiles, ctx),
          });
        const remaining = config.timeoutMs - (Date.now() - started);
        if (remaining <= 0)
          throw new Error(`Timed out before stage ${stage.id}`);
        const agent = await runtime.run({
          workspace: workdir,
          ...(stage.system && {
            system: await renderParts(stage.system, textFiles, ctx),
          }),
          prompt: await renderParts(stage.prompt, textFiles, ctx),
          ...((stage.model ?? config.model) !== undefined && {
            model: stage.model ?? config.model,
          }),
          ...((stage.effort ?? config.effort) !== undefined && {
            effort: stage.effort ?? config.effort,
          }),
          maxTurns: stage.maxTurns ?? config.maxTurns,
          ...(config.maxBudgetUsd !== undefined && {
            maxBudgetUsd: config.maxBudgetUsd,
          }),
          timeoutMs: remaining,
          ...(bundle.commands.length > 0 && { commands: bundle.commands }),
        });
        const text = agent.text.trim();
        if (!text) throw new Error(`Stage ${stage.id} answered nothing`);
        let json: unknown;
        try {
          json = firstJsonObject(text);
        } catch (err) {
          if (stage.output !== 'text')
            throw new Error(`Stage ${stage.id}: ${(err as Error).message}`);
        }
        if (stage.forbidKeys.length && hasKey(json, new Set(stage.forbidKeys)))
          throw new Error(
            `Stage ${stage.id} answered a forbidden key (${stage.forbidKeys.join(', ')})`
          );
        const result: StageResult = { text, agent, json };
        if (stage.output === 'verdict') {
          try {
            result.verdict = parseSlotVerdict(
              json as Record<string, unknown>,
              candidateIsA
            );
          } catch (err) {
            throw new Error(
              `Stage ${stage.id} verdict: ${(err as Error).message}`
            );
          }
        }
        results.set(stage.id, result);
      };
      for (const wave of waves) await Promise.all(wave.map(runStage));

      const toSide = (v: SlotVerdict) =>
        v.advantage > 0 ? 'candidate' : v.advantage < 0 ? 'baseline' : 'tie';
      const overall = results.get(bundle.result.overall)!.verdict!;
      const dimensions: Record<string, PairwiseDimension> = {};
      for (const [name, id] of Object.entries(bundle.result.dimensions)) {
        const v = results.get(id)!.verdict!;
        dimensions[name] = {
          preference: toSide(v),
          strength: v.gap / MAX_GAP,
          ...(v.explanation !== undefined && { reasoning: v.explanation }),
        };
      }
      const usage: Partial<UsageMetrics> = {};
      for (const r of results.values()) addUsage(usage, r.agent.usage);
      const first = results.values().next().value!;
      return {
        preference: toSide(overall),
        strength: overall.gap / MAX_GAP,
        ...(overall.explanation !== undefined && {
          reasoning: overall.explanation,
        }),
        ...(Object.keys(dimensions).length > 0 && { dimensions }),
        usage,
        provider: first.agent.runtime,
        ...(first.agent.model !== undefined && { model: first.agent.model }),
        version,
        metadata: {
          judge: bundle.name,
          // Which slot held the candidate: recorded after judging, never shown to it.
          slotA: candidateIsA ? 'candidate' : 'baseline',
          verdicts: Object.fromEntries(
            [...results].flatMap(([id, r]) =>
              r.verdict
                ? [[id, { preferred: r.verdict.preferred, gap: r.verdict.gap }]]
                : []
            )
          ),
          agent: {
            runtime: first.agent.runtime,
            // Only what a step is for audit: never what it read or returned.
            stages: [...results].map(([id, r]) => ({
              id,
              ...(r.agent.turns !== undefined && { turns: r.agent.turns }),
              steps: r.agent.steps.map(({ tool, isError }) => ({
                tool,
                ...(isError !== undefined && { isError }),
              })),
            })),
            ...(config.keepWorkspace && { workspace: workspace.root }),
          },
        },
      };
    } finally {
      await workspace.dispose();
    }
  }

  return {
    ...(bundle.description !== undefined && {
      description: bundle.description,
    }),
    schema: optionsSchema({}),
    version,
    ...(bundle.requires.length > 0 && { requires: bundle.requires }),
    // A randomized bundle hides the order itself; one call per rep.
    swapPositions: bundle.order.mode !== 'randomized',
    preflight: (options) => preflightRuntime(settings(spec, options).runtime),
    compare,
  };
}
