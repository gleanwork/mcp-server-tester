import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';

/** Evaluation modes supported by the tester. */
export const EvalConfigModeSchema = z.enum([
  'tool-selection',
  'tool-call',
  'e2e-quality',
  'mcp-host',
  'sxs',
  'direct',
  'all',
]);

export type EvalConfigMode = z.infer<typeof EvalConfigModeSchema>;

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

const NativeMcpServerConfigSchema = z.object({
  name: z.string().min(1),
  url: z.string().url(),
  tokenEnv: z.string().optional(),
  headers: z.record(z.string(), z.string()).optional(),
  alwaysWriteTools: z.array(z.string()).optional(),
  readOnlyTools: z.array(z.string()).optional(),
  expectedMinTools: z.number().int().nonnegative().optional(),
  plannedWriteKey: z.string().optional(),
});

export type EvalPluginRef = z.infer<typeof EvalPluginRefSchema>;
export type NativeMcpServerConfig = z.infer<typeof NativeMcpServerConfigSchema>;

/** Complete JSON contract for one tester evaluation run. */
export const EvalConfigSchema = z
  .object({
    name: z.string().min(1),
    mode: EvalConfigModeSchema,
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
    serverBTokenEnv: z.string().optional(),
    nativeServers: z.array(NativeMcpServerConfigSchema).optional(),
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

/** Mode behavior supplied by the execution implementation. */
export interface ResolvedEvalModeConfig {
  filterTags: string[];
  requiresJudges: boolean;
  isServerComparison: boolean;
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
  if (options.skipEvalsetValidation) return config;

  for (const evalsetPath of resolveEvalsetPaths(config, options.rootDir)) {
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
