import fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import {
  loadEvalDatasetFromObject,
  registerDatasetSource,
  type DatasetSourceContext,
  type EvalDataset,
  type EvalManifest,
  type ExtensionConfig,
  type MCPHostConfig,
} from '@gleanwork/mcp-server-tester';

const LegacyCaseSchema = z
  .object({
    id: z.string().min(1),
    description: z.string().optional(),
    tags: z.array(z.string()).optional(),
    scenario: z.string().min(1).optional(),
    expected_tool: z.string().min(1).optional(),
    tool: z.string().min(1).optional(),
    reference: z.string().optional(),
    iterations: z.number().int().positive().optional(),
    accuracyThreshold: z.number().min(0).max(1).optional(),
  })
  .passthrough();
const LegacyDatasetSchema = z.object({
  name: z.string().min(1).optional(),
  description: z.string().optional(),
  cases: z.array(LegacyCaseSchema).min(1),
});
type RawEvalset = z.infer<typeof LegacyDatasetSchema>;
export type LegacyFormat = 'tool-selection' | 'tool-call' | 'e2e-quality';

// Transport and legacy policy are explicitly selected, never inferred from the
// first case. This module can be copied to an organization's plugin directory.
const LegacySourceSchema = z
  .object({
    type: z.literal('glean-legacy'),
    format: z.enum(['tool-selection', 'tool-call', 'e2e-quality']),
    transport: z.discriminatedUnion('type', [
      z.object({ type: z.literal('file'), path: z.string().min(1) }).strict(),
      z
        .object({
          type: z.literal('gcs'),
          uri: z.string().regex(/^gs:\/\/[^/]+\/.+/),
        })
        .strict(),
    ]),
  })
  .strict();

function extensionName(extension: ExtensionConfig): string {
  return extension.name ?? extension.type;
}

const LEGACY_QUALITY_JUDGES = new Set([
  'glean-completeness',
  'glean-correctness',
  'task-completion',
  'glean-rate-limit',
  'glean-timeout',
]);

function enabledJudges(
  manifest: EvalManifest,
  source: string
): Map<string, number> {
  const judges = new Map(
    (manifest.judges ?? []).map((judge) => [
      extensionName(judge),
      z
        .number()
        .min(0)
        .max(1)
        .parse(judge.threshold ?? 0.5),
    ])
  );
  const unsupported = [...judges.keys()].filter(
    (name) => source !== 'e2e-quality' || !LEGACY_QUALITY_JUDGES.has(name)
  );
  if (unsupported.length > 0) {
    throw new Error(
      `Legacy ${source} datasets cannot apply manifest judges: ${unsupported.join(', ')}. ` +
        'Use canonical EvalDataset cases with expect.passesJudge or a custom dataset source.'
    );
  }
  return judges;
}

function buildJudges(
  scenario: string,
  reference: string | undefined,
  judges: Map<string, number>
): Array<Record<string, unknown>> {
  const result: Array<Record<string, unknown>> = [];
  if (judges.has('glean-completeness')) {
    result.push({
      judge: 'glean-completeness',
      reference: scenario,
      threshold: 0.5,
    });
  }
  if (judges.has('glean-correctness') && !reference) {
    throw new Error(
      'Legacy e2e-quality datasets require a reference for glean-correctness. ' +
        'Use canonical EvalDataset cases with explicit expect.passesJudge to select judges per case.'
    );
  }
  if (judges.has('glean-correctness')) {
    result.push({
      judge: 'glean-correctness',
      reference: JSON.stringify({ question: scenario, answer: reference }),
      threshold: 0.5,
    });
  }
  if (judges.has('task-completion')) {
    result.push({
      judge: 'task-completion',
      reference: scenario,
      threshold: 0.5,
    });
  }
  for (const signalJudge of ['glean-rate-limit', 'glean-timeout'] as const) {
    if (judges.has(signalJudge)) {
      result.push({ judge: signalJudge, reference: scenario, threshold: 0.5 });
    }
  }
  return result.map((assertion) => ({
    ...assertion,
    threshold: judges.get(String(assertion.judge)),
  }));
}

function requireHostConfig(
  hostConfig: MCPHostConfig | undefined,
  source: string
): MCPHostConfig {
  if (!hostConfig) {
    throw new Error(
      `Dataset source "${source}" requires a resolved host configuration.`
    );
  }
  return hostConfig;
}

function buildToolSelectionDataset(
  evalset: RawEvalset,
  hostConfig: MCPHostConfig | undefined,
  manifest: EvalManifest
): EvalDataset {
  enabledJudges(manifest, 'tool-selection');
  const resolvedHostConfig = requireHostConfig(hostConfig, 'tool-selection');
  const cases = evalset.cases.map((case_) => {
    const iterations = case_.iterations ?? manifest.iterations ?? 5;
    const expectedTool = String(case_.expected_tool);
    const scenario = String(case_.scenario);
    const tags = case_.tags ?? [];
    return {
      id: String(case_.id),
      description:
        typeof case_.description === 'string'
          ? case_.description
          : `Tool selection: should trigger ${expectedTool}`,
      toolName: expectedTool,
      mode: 'mcp_host' as const,
      scenario,
      mcpHostConfig: resolvedHostConfig,
      tags: ['mcp_host', 'tool_selection', ...tags],
      iterations,
      accuracyThreshold:
        case_.accuracyThreshold ?? (iterations === 1 ? 1.0 : 0.8),
      expect: {
        toolsTriggered: {
          calls: [{ name: expectedTool, required: true }],
        },
      },
    };
  });

  return loadEvalDatasetFromObject({
    name: evalset.name ?? 'tool-selection',
    description: evalset.description ?? 'Tool selection evaluation.',
    cases,
  });
}

function buildToolCallDataset(
  evalset: RawEvalset,
  hostConfig: MCPHostConfig | undefined,
  manifest: EvalManifest
): EvalDataset {
  enabledJudges(manifest, 'tool-call');
  const cases = evalset.cases.map((case_) => {
    const tool = String(case_.tool);
    const tags = case_.tags ?? [];
    const fixtureCase: Record<string, unknown> = {
      id: String(case_.id),
      description:
        typeof case_.description === 'string'
          ? case_.description
          : `Tool call: ${tool}`,
      toolName: tool,
      tags: ['tool_call', ...tags],
      expect: case_.expect ?? {
        isError: false,
        responseSize: { minBytes: 50 },
      },
    };
    if (case_.args !== undefined) fixtureCase.args = case_.args;
    for (const key of [
      'mode',
      'scenario',
      'iterations',
      'accuracyThreshold',
    ] as const) {
      if (case_[key] !== undefined) fixtureCase[key] = case_[key];
    }
    if (case_.mode === 'mcp_host') {
      fixtureCase.mcpHostConfig = requireHostConfig(hostConfig, 'tool-call');
      fixtureCase.iterations = case_.iterations ?? manifest.iterations;
    }
    return fixtureCase;
  });

  return loadEvalDatasetFromObject({
    name: evalset.name ?? 'tool-call',
    description: evalset.description ?? 'Tool call evaluation.',
    cases,
  });
}

function buildE2eQualityDataset(
  evalset: RawEvalset,
  hostConfig: MCPHostConfig | undefined,
  manifest: EvalManifest
): EvalDataset {
  const judges = enabledJudges(manifest, 'e2e-quality');
  const resolvedHostConfig = requireHostConfig(hostConfig, 'e2e-quality');
  const cases = evalset.cases.map((case_) => {
    const scenario = String(case_.scenario);
    const reference =
      typeof case_.reference === 'string' ? case_.reference : undefined;
    const tags = case_.tags ?? [];
    const fixtureCase: Record<string, unknown> = {
      id: String(case_.id),
      description:
        typeof case_.description === 'string'
          ? case_.description
          : `E2E quality: ${scenario.slice(0, 80)}`,
      mode: 'mcp_host',
      scenario,
      mcpHostConfig: resolvedHostConfig,
      tags: ['e2e_quality', ...tags],
      iterations: case_.iterations ?? manifest.iterations ?? 1,
      accuracyThreshold: case_.accuracyThreshold,
    };
    const judgeList = buildJudges(scenario, reference, judges);
    if (judgeList.length > 0) fixtureCase.expect = { passesJudge: judgeList };
    return fixtureCase;
  });

  const withRef = evalset.cases.filter((c) => c.reference).length;
  return loadEvalDatasetFromObject({
    name: evalset.name ?? 'e2e-quality',
    description:
      evalset.description ??
      `E2E quality evaluation. ${cases.length} cases (${withRef} with correctness judge).`,
    cases,
  });
}

/** Explicit migration entry point; all organization policy lives in this adapter. */
export function convertLegacyGleanDataset(
  raw: unknown,
  format: LegacyFormat,
  hostConfig: MCPHostConfig | undefined,
  manifest: EvalManifest
): EvalDataset {
  const evalset = LegacyDatasetSchema.parse(raw);
  for (const case_ of evalset.cases) {
    if (format !== 'tool-call' && case_.expect !== undefined) {
      throw new Error(
        `Legacy ${format} cannot apply case expect assertions. Use canonical EvalDataset with explicit expect.passesJudge instead.`
      );
    }
    const required =
      format === 'tool-selection'
        ? ['expected_tool', 'scenario']
        : format === 'tool-call'
          ? ['tool']
          : ['scenario'];
    for (const key of required) {
      if (typeof case_[key] !== 'string' || !case_[key]) {
        throw new Error(`Legacy ${format} case "${case_.id}" requires ${key}.`);
      }
    }
  }
  let dataset: EvalDataset;
  switch (format) {
    case 'tool-selection':
      dataset = buildToolSelectionDataset(evalset, hostConfig, manifest);
      break;
    case 'tool-call':
      dataset = buildToolCallDataset(evalset, hostConfig, manifest);
      break;
    case 'e2e-quality':
      dataset = buildE2eQualityDataset(evalset, hostConfig, manifest);
      break;
  }
  return manifest.maxCases && dataset.cases.length > manifest.maxCases
    ? { ...dataset, cases: dataset.cases.slice(0, manifest.maxCases) }
    : dataset;
}

interface GCSStorage {
  bucket(name: string): {
    file(name: string): { download(): Promise<[Buffer]> };
  };
}

/** Source-only JSON transport; deliberately unrelated to result upload/storage. */
async function readLegacyJSON(
  transport: z.infer<typeof LegacySourceSchema>['transport'],
  context: DatasetSourceContext
): Promise<unknown> {
  if (transport.type === 'file') {
    return JSON.parse(
      await fs.readFile(path.resolve(context.rootDir, transport.path), 'utf8')
    ) as unknown;
  }
  const match = /^gs:\/\/([^/]+)\/(.+)$/.exec(transport.uri)!;
  let Storage: new () => GCSStorage;
  try {
    // Variable import keeps this copyable plugin independent of the optional
    // package's type declarations. Only GCS users need to install it.
    const packageName = '@google-cloud/storage';
    ({ Storage } = (await import(packageName)) as {
      Storage: new () => GCSStorage;
    });
  } catch (error) {
    throw new Error(
      'glean-legacy GCS transport requires the optional @google-cloud/storage package.',
      { cause: error }
    );
  }
  const [buffer] = await new Storage()
    .bucket(match[1]!)
    .file(match[2]!)
    .download();
  return JSON.parse(buffer.toString('utf8')) as unknown;
}

/** Plugin loader hook. Merely importing this example does not register it. */
export function register(): void {
  registerDatasetSource({
    name: 'glean-legacy',
    schema: LegacySourceSchema,
    async load(config, context) {
      const source = LegacySourceSchema.parse(config);
      return convertLegacyGleanDataset(
        await readLegacyJSON(source.transport, context),
        source.format,
        context.hostConfig,
        context.manifest
      );
    },
  });
}
