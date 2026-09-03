import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';

/** Evaluation modes supported by the tester. */
export const EvalModeSchema = z.enum([
  'tool-selection',
  'tool-call',
  'e2e-quality',
  'mcp-host',
  'sxs',
  'direct',
  'all',
]);

export type EvalMode = z.infer<typeof EvalModeSchema>;

export const EvalPluginRefSchema = z.object({
  name: z.string(),
  dir: z.string(),
  mcpUrl: z.string().url().optional(),
});

export type EvalPluginRef = z.infer<typeof EvalPluginRefSchema>;

/** JSON config for a tester evaluation run. */
export const EvalConfigSchema = z.object({
  name: z.string().min(1),
  mode: EvalModeSchema,
  evalsetFilePaths: z.array(z.string()).optional(),
  localEvalsets: z.string().optional(),
  plugins: z.array(EvalPluginRefSchema).optional(),
});

export type EvalConfig = z.infer<typeof EvalConfigSchema>;

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
