import type { EvalCampaignMode } from './evalConfigSchema.js';
import type { EvalConfig } from './evalConfigSchema.js';
import type { EvalDataset } from './datasetTypes.js';
import type { MCPHostConfig } from './mcpHost/mcpHostTypes.js';
import { loadEvalDatasetFromObject } from './datasetLoader.js';

type RawEvalset = {
  name?: string;
  description?: string;
  cases: RawEvalCase[];
};

type RawEvalCase = Record<string, unknown>;

function isPrebuiltDataset(data: unknown): data is EvalDataset {
  if (!data || typeof data !== 'object' || !('cases' in data)) {
    return false;
  }
  const cases = (data as { cases: unknown[] }).cases;
  if (!cases?.length) {
    return false;
  }
  const first = cases[0];
  if (!first || typeof first !== 'object') {
    return false;
  }
  return (
    'mode' in first ||
    ('expect' in first &&
      typeof (first as { expect?: unknown }).expect === 'object')
  );
}

function fixtureIterations(config: EvalConfig): number {
  if (config.iterations && config.iterations > 0) {
    return config.iterations;
  }
  const raw = process.env.EVAL_ITERATIONS;
  return raw ? parseInt(raw, 10) : 5;
}

function enabledJudges(config: EvalConfig): Set<string> {
  if (config.judges?.length) {
    return new Set(config.judges);
  }
  const raw = process.env.EVAL_JUDGES ?? '';
  return new Set(raw.split(',').map((j) => j.trim()).filter(Boolean));
}

function buildJudges(
  scenario: string,
  reference: string | undefined,
  judges: Set<string>,
): Array<Record<string, unknown>> {
  const result: Array<Record<string, unknown>> = [];
  if (judges.has('glean-completeness')) {
    result.push({
      judge: 'glean-completeness',
      reference: scenario,
      threshold: 0.5,
    });
  }
  if (judges.has('glean-correctness') && reference) {
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
      result.push({
        judge: signalJudge,
        reference: scenario,
        threshold: 0.5,
      });
    }
  }
  return result;
}

function buildToolSelectionDataset(
  evalset: RawEvalset,
  hostConfig: MCPHostConfig,
  config: EvalConfig,
): EvalDataset {
  const iterations = fixtureIterations(config);
  const cases = evalset.cases.map((case_) => {
    const expectedTool = String(case_.expected_tool);
    const scenario = String(case_.scenario);
    const tags = Array.isArray(case_.tags)
      ? (case_.tags as string[])
      : [];
    return {
      id: String(case_.id),
      description:
        typeof case_.description === 'string'
          ? case_.description
          : `Tool selection: should trigger ${expectedTool}`,
      toolName: expectedTool,
      mode: 'mcp_host' as const,
      scenario,
      mcpHostConfig: hostConfig,
      tags: ['mcp_host', 'tool_selection', ...tags],
      iterations,
      accuracyThreshold: iterations === 1 ? 1.0 : 0.8,
      expect: {
        toolsTriggered: {
          calls: [{ name: expectedTool, required: true }],
        },
      },
    };
  });

  return loadEvalDatasetFromObject({
    name: evalset.name ?? 'tool-selection',
    description:
      evalset.description ?? 'Tool selection evaluation.',
    cases,
  });
}

function buildToolCallDataset(
  evalset: RawEvalset,
  hostConfig: MCPHostConfig,
): EvalDataset {
  const cases = evalset.cases.map((case_) => {
    const tool = String(case_.tool);
    const tags = Array.isArray(case_.tags)
      ? (case_.tags as string[])
      : [];
    const fixtureCase: Record<string, unknown> = {
      id: String(case_.id),
      description:
        typeof case_.description === 'string'
          ? case_.description
          : `Tool call: ${tool}`,
      toolName: tool,
      tags: ['tool_call', ...tags],
      expect:
        case_.expect ??
        ({
          isError: false,
          responseSize: { minBytes: 50 },
        } as const),
    };
    if (case_.args !== undefined) {
      fixtureCase.args = case_.args;
    }
    for (const key of [
      'mode',
      'scenario',
      'iterations',
      'accuracyThreshold',
    ] as const) {
      if (case_[key] !== undefined) {
        fixtureCase[key] = case_[key];
      }
    }
    if (case_.mode === 'mcp_host') {
      fixtureCase.mcpHostConfig = hostConfig;
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
  hostConfig: MCPHostConfig,
  config: EvalConfig,
): EvalDataset {
  const judges = enabledJudges(config);
  const cases = evalset.cases.map((case_) => {
    const scenario = String(case_.scenario);
    const reference =
      typeof case_.reference === 'string' ? case_.reference : undefined;
    const tags = Array.isArray(case_.tags)
      ? (case_.tags as string[])
      : [];
    const fixtureCase: Record<string, unknown> = {
      id: String(case_.id),
      description:
        typeof case_.description === 'string'
          ? case_.description
          : `E2E quality: ${scenario.slice(0, 80)}`,
      mode: 'mcp_host',
      scenario,
      mcpHostConfig: hostConfig,
      tags: ['e2e_quality', ...tags],
      iterations: 1,
    };
    const judgeList = buildJudges(scenario, reference, judges);
    if (judgeList.length > 0) {
      fixtureCase.expect = { passesJudge: judgeList };
    }
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

const BUILDERS: Record<
  EvalCampaignMode,
  | ((
      evalset: RawEvalset,
      hostConfig: MCPHostConfig,
      config: EvalConfig,
    ) => EvalDataset)
  | null
> = {
  'tool-selection': buildToolSelectionDataset,
  'tool-call': (evalset, hostConfig) => buildToolCallDataset(evalset, hostConfig),
  'e2e-quality': buildE2eQualityDataset,
  'mcp-host': buildToolSelectionDataset,
  direct: null,
  sxs: null,
  all: null,
};

export function buildEvalDataset(
  raw: unknown,
  mode: EvalCampaignMode,
  hostConfig: MCPHostConfig,
  config: EvalConfig,
): EvalDataset {
  if (isPrebuiltDataset(raw)) {
    return loadEvalDatasetFromObject(raw);
  }

  const builder = BUILDERS[mode];
  if (!builder) {
    throw new Error(`Cannot build dataset for mode "${mode}" from raw evalset`);
  }

  const evalset = raw as RawEvalset;
  if (!Array.isArray(evalset.cases)) {
    throw new Error('Evalset must contain a cases array');
  }

  let dataset = builder(evalset, hostConfig, config);
  if (config.maxCases && dataset.cases.length > config.maxCases) {
    dataset = {
      ...dataset,
      cases: dataset.cases.slice(0, config.maxCases),
    };
  }
  return dataset;
}
