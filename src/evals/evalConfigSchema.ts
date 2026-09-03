import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import type { NativeMcpServerDefinition } from './nativeMcpServers.js';

/**
 * Scio-era eval campaign modes. These map to MST runner behavior via
 * {@link resolveEvalModeConfig}.
 */
export const EvalCampaignModeSchema = z.enum([
  'tool-selection',
  'tool-call',
  'e2e-quality',
  'mcp-host',
  'sxs',
  'direct',
  'all',
]);

export type EvalCampaignMode = z.infer<typeof EvalCampaignModeSchema>;

export const MetricSpecSchema = z.union([
  z.string(),
  z.object({
    metric: z.string(),
    name: z.string().optional(),
    params: z.record(z.string(), z.unknown()).optional(),
  }),
]);

export type MetricSpec = z.infer<typeof MetricSpecSchema>;

export const EvalPluginRefSchema = z.object({
  name: z.string(),
  dir: z.string(),
  mcpUrl: z.string().url().optional(),
});

const NativeMcpServerDefinitionSchema = z.object({
  name: z.string().min(1),
  url: z.string().url(),
  tokenEnv: z.string().optional(),
  token: z.string().optional(),
  headers: z.record(z.string(), z.string()).optional(),
  alwaysWriteTools: z.array(z.string()).optional(),
  readOnlyTools: z.array(z.string()).optional(),
  expectedMinTools: z.number().int().nonnegative().optional(),
  plannedWriteKey: z.string().optional(),
});

export type EvalPluginRef = z.infer<typeof EvalPluginRefSchema>;
export type EvalNativeMcpServerDefinition = NativeMcpServerDefinition;

/**
 * JSON config for a single eval campaign run.
 *
 * Derived from scio `.github/mcp_tests/configs/weekly/*.json` and designed
 * to be the contract for `mcp-server-tester run`.
 */
export const EvalConfigSchema = z
  .object({
    name: z.string().min(1),
    mode: EvalCampaignModeSchema,
    evalsetFilePaths: z.array(z.string()).optional(),
    localEvalsets: z.string().optional(),
    model: z.string().optional(),
    clientHost: z.string().optional(),
    mcpUrl: z.string().url().optional(),
    concurrency: z.number().int().positive().optional(),
    maxCases: z.number().int().positive().optional(),
    timeout: z.number().int().positive().optional(),
    provider: z.string().optional(),
    env: z.record(z.string(), z.string()).optional(),
    metrics: z.array(MetricSpecSchema).optional(),
    iterations: z.number().int().nonnegative().optional(),
    maxToolCalls: z.number().int().nonnegative().optional(),
    judges: z.array(z.string()).optional(),
    version: z.string().optional(),
    plugins: z.array(EvalPluginRefSchema).optional(),
    useOAuth: z.boolean().optional(),
    tools: z.string().optional(),
    serverB: z.string().url().optional(),
    serverBToken: z.string().optional(),
    nativeServers: z.array(NativeMcpServerDefinitionSchema).optional(),
    nativeConnectors: z
      .union([z.array(z.string()), z.record(z.string(), z.string())])
      .optional(),
  })
  .superRefine((config, ctx) => {
    const hasEvalsets =
      (config.evalsetFilePaths?.length ?? 0) > 0 || !!config.localEvalsets;
    if (!hasEvalsets && config.mode !== 'direct') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          'evalsetFilePaths or localEvalsets is required for this eval mode',
        path: ['evalsetFilePaths'],
      });
    }

    if (config.mode === 'sxs' && !config.serverB) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'serverB is required when mode is sxs',
        path: ['serverB'],
      });
    }
  });

export type EvalConfig = z.infer<typeof EvalConfigSchema>;

export interface ResolvedEvalModeConfig {
  /** Dataset tag filter passed to runEvalDataset. */
  filterTags: string[];
  /** Whether the campaign needs custom judge registrations. */
  requiresJudges: boolean;
  /** Whether this mode compares two MCP servers. */
  isServerComparison: boolean;
}

const MODE_TAG_MAP: Record<EvalCampaignMode, ResolvedEvalModeConfig> = {
  'tool-selection': {
    filterTags: ['mcp_host'],
    requiresJudges: false,
    isServerComparison: false,
  },
  'tool-call': {
    filterTags: ['tool_call'],
    requiresJudges: false,
    isServerComparison: false,
  },
  'e2e-quality': {
    filterTags: ['e2e_quality'],
    requiresJudges: true,
    isServerComparison: false,
  },
  'mcp-host': {
    filterTags: ['mcp_host'],
    requiresJudges: false,
    isServerComparison: false,
  },
  sxs: {
    filterTags: [],
    requiresJudges: false,
    isServerComparison: true,
  },
  direct: {
    filterTags: [],
    requiresJudges: false,
    isServerComparison: false,
  },
  all: {
    filterTags: [],
    requiresJudges: true,
    isServerComparison: false,
  },
};

export function resolveEvalModeConfig(
  mode: EvalCampaignMode
): ResolvedEvalModeConfig {
  return MODE_TAG_MAP[mode];
}

export interface LoadEvalConfigOptions {
  /** Base directory for resolving relative evalset paths. */
  rootDir?: string;
  /** Skip filesystem checks for evalset paths (useful for --dry-run). */
  skipEvalsetValidation?: boolean;
}

export function resolveEvalsetPaths(
  config: EvalConfig,
  rootDir = process.cwd()
): string[] {
  if (config.evalsetFilePaths?.length) {
    return config.evalsetFilePaths.map((p) =>
      path.isAbsolute(p) ? p : path.resolve(rootDir, p)
    );
  }
  if (config.localEvalsets) {
    const local = config.localEvalsets;
    return [path.isAbsolute(local) ? local : path.resolve(rootDir, local)];
  }
  return [];
}

export function loadEvalConfigFromObject(
  value: unknown,
  options: LoadEvalConfigOptions = {}
): EvalConfig {
  const config = EvalConfigSchema.parse(value);
  if (options.skipEvalsetValidation) {
    return config;
  }
  const evalsetPaths = resolveEvalsetPaths(config, options.rootDir);
  for (const evalsetPath of evalsetPaths) {
    if (!fs.existsSync(evalsetPath)) {
      throw new Error(`Evalset path not found: ${evalsetPath}`);
    }
  }
  return config;
}

export function loadEvalConfig(
  configPath: string,
  options: LoadEvalConfigOptions = {}
): EvalConfig {
  const absPath = path.isAbsolute(configPath)
    ? configPath
    : path.resolve(process.cwd(), configPath);
  if (!fs.existsSync(absPath)) {
    throw new Error(`Eval config not found: ${absPath}`);
  }
  const raw = JSON.parse(fs.readFileSync(absPath, 'utf8')) as unknown;
  const rootDir = options.rootDir ?? path.dirname(absPath);
  return loadEvalConfigFromObject(raw, { ...options, rootDir });
}
