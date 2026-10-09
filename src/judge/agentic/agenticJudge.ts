/**
 * Agentic judges: pointwise and pairwise judges that run an agent over a
 * workspace of the run's evidence instead of one prompt.
 *
 * A plugin describes the judge (what it needs, which files and helper
 * commands to add, the prompt, how to read the answer). MST builds the
 * workspace, runs the configured runtime confined to it, checks the result
 * and removes the workspace. The runtime is chosen by options, so the same
 * judge runs on Codex or the Claude Agent SDK without code changes.
 */

import { z, type ZodType } from 'zod';
import type { JudgeDefinition } from '../../evals/evalFrameworkTypes.js';
import type {
  JudgeCase,
  JudgeInput,
  JudgeTrial,
  JudgeScore,
} from '../judgeContract.js';
import type {
  PairwiseJudgeDefinition,
  PairwiseJudgeInput,
  PairwisePreference,
} from '../pairwiseContract.js';
import { claudeRuntime } from './claudeRuntime.js';
import { codexRuntime } from './codexRuntime.js';
import { loadJudgeSdk, requireJudgeCredential } from '../adapterSupport.js';
import type {
  AgentJudgeResult,
  AgentJudgeRuntime,
  WorkspaceCommand,
} from './runtime.js';
import {
  createWorkspace,
  trialArtifacts,
  trialFiles,
  type WorkspaceArtifacts,
  type WorkspaceFile,
} from './workspace.js';

/** Built-in runtime ids. */
export const AGENT_JUDGE_RUNTIMES = ['codex', 'claude-agent'] as const;
export type AgentJudgeRuntimeId = (typeof AGENT_JUDGE_RUNTIMES)[number];

/** Runtime settings, from the judge's defaults and then its options. */
export const AgentJudgeOptionsSchema = z
  .object({
    runtime: z.enum(AGENT_JUDGE_RUNTIMES).optional(),
    model: z.string().min(1).optional(),
    effort: z.string().min(1).optional(),
    maxTurns: z.number().int().positive().optional(),
    maxBudgetUsd: z.number().positive().optional(),
    timeoutMs: z.number().int().positive().optional(),
    /** Keep the workspace for debugging. Its path is in the result's metadata. */
    keepWorkspace: z.boolean().optional(),
  })
  .strict();
export type AgentJudgeOptions = z.infer<typeof AgentJudgeOptionsSchema>;

const DEFAULTS = {
  // Confined to the workspace; Codex's read-only sandbox can read the disk.
  runtime: 'claude-agent',
  maxTurns: 20,
  timeoutMs: 15 * 60_000,
} as const satisfies AgentJudgeOptions;

/** What `buildPrompt` returns. */
export interface AgentJudgePrompt {
  system?: string;
  prompt: string;
}

/** What `parseScore` and `parsePreference` receive. */
export interface AgentJudgeOutput extends AgentJudgeResult {
  /** Workspace root the agent ran in; removed after parsing. */
  workspace: string;
}

interface AgenticBase<Input> {
  /** Paths in the input the judge needs; missing ones skip the judge. */
  requires?: readonly string[];
  /** Runtime settings used when options do not set them. */
  defaults?: AgentJudgeOptions;
  /** Extra workspace files, such as helper scripts or deliverables. */
  files?: (input: Input) => WorkspaceFile[] | Promise<WorkspaceFile[]>;
  /** Helper programs the agent may run from the workspace. */
  commands?: readonly WorkspaceCommand[];
  /** The prompt. `workspace` is the root path, for prompts that name files. */
  buildPrompt: (
    input: Input,
    context: { workspace: string }
  ) => AgentJudgePrompt | Promise<AgentJudgePrompt>;
  /** JSON Schema of the final answer, enforced where the runtime can. */
  outputSchema?: Record<string, unknown>;
  /** Plugin-specific options, merged with the runtime settings. */
  schema?: z.ZodObject;
  /** A version recorded with every score or preference, such as a frozen prompt hash. */
  version?: string;
}

export interface AgenticJudgeSpec extends AgenticBase<JudgeInput> {
  /** The judge's score, from what the agent answered. */
  parseScore: (
    output: AgentJudgeOutput,
    input: JudgeInput,
    options: Record<string, unknown>
  ) => JudgeScore;
}

export interface AgenticPairwiseJudgeSpec extends AgenticBase<PairwiseJudgeInput> {
  /** The judge's preference, from what the agent answered. */
  parsePreference: (
    output: AgentJudgeOutput,
    input: PairwiseJudgeInput,
    options: Record<string, unknown>
  ) => PairwisePreference;
  /** Default true, as for any pairwise judge. */
  swapPositions?: boolean;
}

/** Runtime ids to runtimes: only the built-in ones, chosen by name. */
const RUNTIMES: Readonly<Record<AgentJudgeRuntimeId, () => AgentJudgeRuntime>> =
  {
    codex: () => codexRuntime(),
    'claude-agent': () => claudeRuntime(),
  };

/**
 * Fails, naming what to install or set, unless the runtime's SDK loads and
 * its credential is configured: checked before a run starts any client.
 */
async function preflightRuntime(runtime: AgentJudgeRuntimeId): Promise<void> {
  if (runtime === 'codex') {
    requireJudgeCredential('Codex agent', 'openai', {});
    await loadJudgeSdk(
      () => import('@openai/codex-sdk'),
      'Codex agent',
      '@openai/codex-sdk'
    );
  } else {
    requireJudgeCredential('Claude agent', 'anthropic', {});
    await loadJudgeSdk(
      () => import('@anthropic-ai/claude-agent-sdk'),
      'Claude agent',
      '@anthropic-ai/claude-agent-sdk'
    );
  }
}

function optionsSchema(spec: { schema?: z.ZodObject }): ZodType {
  return spec.schema
    ? spec.schema.extend(AgentJudgeOptionsSchema.shape).strict()
    : AgentJudgeOptionsSchema;
}

function settings(
  spec: { defaults?: AgentJudgeOptions },
  options: Record<string, unknown>
) {
  const merged = { ...DEFAULTS, ...spec.defaults };
  for (const key of Object.keys(AgentJudgeOptionsSchema.shape))
    if (options[key] !== undefined)
      (merged as Record<string, unknown>)[key] = options[key];
  return merged as AgentJudgeOptions & typeof DEFAULTS;
}

async function runAgent<Input>(
  spec: AgenticBase<Input>,
  input: Input,
  options: Record<string, unknown>,
  baseFiles: WorkspaceFile[],
  artifacts: readonly WorkspaceArtifacts[],
  parse: (output: AgentJudgeOutput) => JudgeScore | PairwisePreference
) {
  const config = settings(spec, options);
  const runtime = RUNTIMES[config.runtime]();
  const files = [...baseFiles, ...((await spec.files?.(input)) ?? [])];
  const workspace = await createWorkspace(files, {
    keep: config.keepWorkspace,
    artifacts,
  });
  try {
    const prompt = await spec.buildPrompt(input, { workspace: workspace.root });
    const result = await runtime.run({
      workspace: workspace.root,
      ...prompt,
      ...(config.model !== undefined && { model: config.model }),
      ...(config.effort !== undefined && { effort: config.effort }),
      maxTurns: config.maxTurns,
      ...(config.maxBudgetUsd !== undefined && {
        maxBudgetUsd: config.maxBudgetUsd,
      }),
      timeoutMs: config.timeoutMs,
      ...(spec.outputSchema !== undefined && {
        outputSchema: spec.outputSchema,
      }),
      ...(spec.commands !== undefined && { commands: spec.commands }),
    });
    const parsed = parse({ ...result, workspace: workspace.root });
    return {
      ...parsed,
      usage: { ...result.usage, ...parsed.usage },
      provider: parsed.provider ?? result.runtime,
      model: parsed.model ?? result.model,
      metadata: {
        ...parsed.metadata,
        agent: {
          runtime: result.runtime,
          turns: result.turns,
          // Only what a step is for audit: never what it read or returned.
          steps: result.steps.map(({ tool, isError }) => ({
            tool,
            ...(isError !== undefined && { isError }),
          })),
          ...(spec.version !== undefined && { version: spec.version }),
          ...(config.keepWorkspace && { workspace: workspace.root }),
        },
      },
    };
  } finally {
    await workspace.dispose();
  }
}

/** A pointwise judge that runs an agent over the run's evidence. */
export function agenticJudge(spec: AgenticJudgeSpec): JudgeDefinition {
  return {
    schema: optionsSchema(spec),
    ...(spec.requires !== undefined && { requires: spec.requires }),
    preflight: (options) => preflightRuntime(settings(spec, options).runtime),
    evaluate: (input, options) =>
      runAgent(
        spec,
        input,
        options,
        trialFiles(input.case, input.trial),
        trialArtifacts(input.trial),
        (out) => spec.parseScore(out, input, options)
      ) as Promise<JudgeScore>,
  };
}

/**
 * A pairwise judge that runs an agent over both runs' evidence: `a/` is
 * `input.baseline` and `b/` is `input.candidate`. `parsePreference` maps the
 * agent's A/B answer to `baseline`/`candidate`. To cancel position bias, MST
 * also calls the judge with the runs exchanged and maps that preference back.
 */
export function agenticPairwiseJudge(
  spec: AgenticPairwiseJudgeSpec
): PairwiseJudgeDefinition {
  return {
    schema: optionsSchema(spec),
    ...(spec.requires !== undefined && { requires: spec.requires }),
    ...(spec.swapPositions !== undefined && {
      swapPositions: spec.swapPositions,
    }),
    compare: (input, options) =>
      runAgent(
        spec,
        input,
        options,
        pairFiles(input.case, input.baseline, input.candidate),
        [
          ...trialArtifacts(input.baseline, 'a'),
          ...trialArtifacts(input.candidate, 'b'),
        ],
        (out) => spec.parsePreference(out, input, options)
      ) as Promise<PairwisePreference>,
  };
}

function pairFiles(
  evalCase: JudgeCase,
  baseline: JudgeTrial,
  candidate: JudgeTrial
): WorkspaceFile[] {
  // Both sides see the same case; it is written once at the root.
  return [
    ...trialFiles(evalCase, baseline, 'a').filter(
      (f) => f.path !== 'a/case.json'
    ),
    ...trialFiles(evalCase, candidate, 'b').filter(
      (f) => f.path !== 'b/case.json'
    ),
    { path: 'case.json', content: `${JSON.stringify(evalCase, null, 2)}\n` },
  ];
}
