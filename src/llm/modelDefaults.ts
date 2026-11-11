/**
 * The models MST uses when a client, judge or planner names none.
 *
 * MST ships a built-in table (`BUILTIN_MODELS`). A repo or a person replaces
 * any of its entries without a new MST release, in `models` of an
 * `mst.config.json` or an eval config (ADR 0015):
 *
 * ```json
 * {
 *   "models": {
 *     "api": { "anthropic": "…", "openai": "…" },
 *     "judge": { "openai": "…" },
 *     "agentJudge": { "codex": "…" },
 *     "computerUse": "…"
 *   }
 * }
 * ```
 *
 * Layers merge entry by entry: a later layer replaces only the entries it
 * sets. An eval run resolves its layers once, into the eval config's
 * `models`; the Playwright fixtures resolve theirs into the process value
 * (`setProcessModelDefaults`), which matchers and `runEvalDataset` read.
 */
import { z } from 'zod';
import { ProviderSchema } from '../evals/mstClient/clientOptions.js';
import {
  JUDGE_PROVIDER_KINDS,
  type ProviderKind,
} from '../judge/judgeTypes.js';
import {
  AGENT_JUDGE_RUNTIMES,
  type AgentJudgeRuntimeId,
} from '../judge/agentic/runtimeIds.js';

const ModelIdSchema = z.string().min(1);

/** The `models` block of an `mst.config.json` or an eval config. */
export const ModelDefaultsSchema = z
  .object({
    api: z
      .partialRecord(ProviderSchema, ModelIdSchema)
      .optional()
      .describe(
        "The api client's model by provider, when no case, variant or eval config names one."
      ),
    judge: z
      .partialRecord(z.enum(JUDGE_PROVIDER_KINDS), ModelIdSchema)
      .optional()
      .describe(
        "LLM judges' model by judge provider, when the judge's options name none."
      ),
    agentJudge: z
      .partialRecord(z.enum(AGENT_JUDGE_RUNTIMES), ModelIdSchema)
      .optional()
      .describe(
        "Agentic judges' model by runtime, when neither the judge's options nor the judge name one."
      ),
    computerUse: ModelIdSchema.optional().describe(
      "The macOS Computer Use planner's model (Cowork, ChatGPT, Codex app), when computerUseModel is unset."
    ),
  })
  .strict()
  .describe(
    "Default models, entry by entry over the user's and the repo's mst.config.json (ADR 0015)."
  );

export type ModelDefaults = z.infer<typeof ModelDefaultsSchema>;

type LLMProviderName = z.infer<typeof ProviderSchema>;

/**
 * The models MST falls back on. A built-in judge's version hashes its
 * entries, so changing one makes those judges new judges.
 */
export const BUILTIN_MODELS = {
  api: {
    anthropic: 'claude-sonnet-4-20250514',
    openai: 'gpt-4o',
    google: 'gemini-2.0-flash',
    mistral: 'mistral-large-latest',
  },
  judge: {
    anthropic: 'claude-sonnet-4-6',
    'vertex-anthropic': 'claude-sonnet-4-6',
    'anthropic-agent-sdk': 'claude-sonnet-4-6',
    openai: 'gpt-4o',
    google: 'gemini-2.0-flash',
  },
  agentJudge: {
    'claude-agent': 'claude-sonnet-4-5',
    codex: 'gpt-5.5',
  },
  computerUse: 'claude-sonnet-4-6',
} as const satisfies {
  api: Partial<Record<LLMProviderName, string>>;
  judge: Record<ProviderKind, string>;
  agentJudge: Record<AgentJudgeRuntimeId, string>;
  computerUse: string;
};

/**
 * The models `mst init` writes into a new project's `mst.config.json`, so
 * the project owns them from the start instead of relying on the built-in
 * ones. The api client gets a small model: the scaffold's eval is an example.
 */
export const INIT_MODELS = {
  api: { anthropic: 'claude-haiku-4-5' },
  judge: { anthropic: BUILTIN_MODELS.judge.anthropic },
} as const satisfies ModelDefaults;

/**
 * The layers merged in order, entry by entry: a later layer replaces only
 * the entries it sets. Undefined when no layer sets any.
 */
export function mergeModelDefaults(
  ...layers: ReadonlyArray<ModelDefaults | undefined>
): ModelDefaults | undefined {
  const merged: ModelDefaults = {};
  for (const layer of layers) {
    if (!layer) continue;
    if (layer.api) merged.api = { ...merged.api, ...layer.api };
    if (layer.judge) merged.judge = { ...merged.judge, ...layer.judge };
    if (layer.agentJudge)
      merged.agentJudge = { ...merged.agentJudge, ...layer.agentJudge };
    if (layer.computerUse !== undefined) merged.computerUse = layer.computerUse;
  }
  return Object.keys(merged).length > 0 ? merged : undefined;
}

/** One entry of the `models` block: where one default model is set. */
export type ModelSlot =
  | { kind: 'api'; key: LLMProviderName }
  | { kind: 'judge'; key: ProviderKind }
  | { kind: 'agentJudge'; key: AgentJudgeRuntimeId }
  | { kind: 'computerUse' };

/** The slots a judge's model comes from. */
export type JudgeModelSlot = Extract<
  ModelSlot,
  { kind: 'judge' | 'agentJudge' }
>;

/** Where a slot is set, as a person writes it: `models.judge.openai`. */
function modelSlotSetting(slot: ModelSlot): string {
  return slot.kind === 'computerUse'
    ? 'models.computerUse'
    : `models.${slot.kind}.${slot.key}`;
}

/** The model `models` sets for a slot, if any. */
export function configuredModel(
  slot: ModelSlot,
  models: ModelDefaults | undefined
): string | undefined {
  if (!models) return undefined;
  switch (slot.kind) {
    case 'api':
      return models.api?.[slot.key];
    case 'judge':
      return models.judge?.[slot.key];
    case 'agentJudge':
      return models.agentJudge?.[slot.key];
    case 'computerUse':
      return models.computerUse;
  }
}

/** MST's built-in model for a slot, if it has one. */
export function builtinModel(slot: ModelSlot): string | undefined {
  switch (slot.kind) {
    case 'api':
      return (BUILTIN_MODELS.api as Partial<Record<string, string>>)[slot.key];
    case 'judge':
      return BUILTIN_MODELS.judge[slot.key];
    case 'agentJudge':
      return BUILTIN_MODELS.agentJudge[slot.key];
    case 'computerUse':
      return BUILTIN_MODELS.computerUse;
  }
}

/**
 * The api client's model for `provider` when nothing names one: the
 * configured default, else the built-in one. Throws for a provider with
 * neither (Azure deployments, gateways), naming where to set it.
 */
export function defaultApiModel(
  provider: string,
  models: ModelDefaults | undefined
): string {
  const slot = { kind: 'api', key: provider as LLMProviderName } as const;
  const model = configuredModel(slot, models) ?? builtinModel(slot);
  if (model !== undefined) return model;
  throw new Error(
    `The api client has no default model for provider "${provider}". Set \`model\`, or \`${modelSlotSetting(slot)}\` in mst.config.json.`
  );
}

/**
 * The api client's slot when nothing names its model and `models` sets none
 * for its provider: it runs on MST's built-in model. Undefined otherwise.
 */
export function apiBuiltinSlot(
  options: { model?: unknown; provider?: unknown },
  models: ModelDefaults | undefined
): Extract<ModelSlot, { kind: 'api' }> | undefined {
  if (options.model !== undefined) return undefined;
  // As the api client: without a model, the provider, else Anthropic.
  const provider =
    typeof options.provider === 'string' ? options.provider : 'anthropic';
  const slot = { kind: 'api', key: provider as LLMProviderName } as const;
  return configuredModel(slot, models) === undefined &&
    builtinModel(slot) !== undefined
    ? slot
    : undefined;
}

/**
 * A built-in model a run uses because nothing set one: where to set it, the
 * model, and what used it (`api client`, `judge rubric`). `run.json` records
 * these as `builtinModels`.
 */
export interface BuiltinModelUse {
  setting: string;
  model: string;
  usedBy: string[];
}

/** Collects built-in model uses, one entry per setting. */
export class BuiltinModelUses {
  readonly #uses = new Map<string, BuiltinModelUse>();

  add(slot: ModelSlot, user: string): void {
    const model = builtinModel(slot);
    if (model === undefined) return;
    const setting = modelSlotSetting(slot);
    const use = this.#uses.get(setting);
    if (!use) this.#uses.set(setting, { setting, model, usedBy: [user] });
    else if (!use.usedBy.includes(user)) use.usedBy.push(user);
  }

  /** The uses, by setting, each user once and sorted. */
  list(): BuiltinModelUse[] {
    return [...this.#uses.values()]
      .map((use) => ({ ...use, usedBy: [...use.usedBy].sort() }))
      .sort((a, b) => a.setting.localeCompare(b.setting));
  }
}

const warnedSettings = new Set<string>();

/**
 * Warns, once per process for each setting, that MST used its built-in
 * model where nothing set one, naming where to set it. Built-in models go
 * stale between MST releases; a project pins its own in `mst.config.json`.
 */
export function warnBuiltinModels(
  uses: readonly BuiltinModelUse[],
  warn: (message: string) => void = console.warn
): void {
  const fresh = uses.filter((use) => !warnedSettings.has(use.setting));
  if (fresh.length === 0) return;
  for (const use of fresh) warnedSettings.add(use.setting);
  warn(
    [
      `[mst] No model is set for ${fresh.length === 1 ? 'this' : 'these'}, so MST uses its built-in default${fresh.length === 1 ? '' : 's'}. Set ${fresh.length === 1 ? 'it' : 'them'} in mst.config.json ("models") to choose your own:`,
      ...fresh.map(
        (use) => `  ${use.setting}: ${use.model} (${use.usedBy.join(', ')})`
      ),
    ].join('\n')
  );
}

/** As `warnBuiltinModels`, for slots that `user` runs on. */
export function warnBuiltinSlots(
  slots: ReadonlyArray<ModelSlot | undefined>,
  user: string
): void {
  const uses = new BuiltinModelUses();
  for (const slot of slots) if (slot) uses.add(slot, user);
  warnBuiltinModels(uses.list());
}

/** Forgets which settings were warned about (tests only). */
export function resetBuiltinModelWarningsForTests(): void {
  warnedSettings.clear();
}

let processModels: ModelDefaults | undefined;

/**
 * Sets the model defaults for code that runs outside an eval config: the
 * matchers, validators and `runEvalDataset`. The Playwright fixtures set it
 * for each test. An eval run uses its eval config's `models` instead.
 */
export function setProcessModelDefaults(
  models: ModelDefaults | undefined
): void {
  processModels = models;
}

/** The model defaults `setProcessModelDefaults` set, if any. */
export function processModelDefaults(): ModelDefaults | undefined {
  return processModels;
}
