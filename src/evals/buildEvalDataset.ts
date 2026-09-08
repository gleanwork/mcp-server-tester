import type { EvalDataset } from './datasetTypes.js';
import type { EvalManifest, ExtensionConfig } from './evalManifest.js';
import type { MCPHostConfig } from './mcpHost/mcpHostTypes.js';
import { loadEvalDatasetFromObject } from './datasetLoader.js';

type RawEvalset = {
  name?: string;
  description?: string;
  cases: RawEvalCase[];
};

type RawEvalCase = Record<string, unknown>;

function isPrebuiltDataset(data: unknown): data is EvalDataset {
  if (!data || typeof data !== 'object' || !('cases' in data)) return false;
  const cases = (data as { cases: unknown[] }).cases;
  if (!cases?.length) return false;
  const first = cases[0];
  if (!first || typeof first !== 'object') return false;
  return (
    'mode' in first ||
    ('expect' in first &&
      typeof (first as { expect?: unknown }).expect === 'object')
  );
}

function fixtureIterations(manifest: EvalManifest): number {
  if (manifest.iterations && manifest.iterations > 0) {
    return manifest.iterations;
  }
  const raw = process.env.EVAL_ITERATIONS;
  return raw ? parseInt(raw, 10) : 5;
}

function extensionName(extension: ExtensionConfig): string {
  return extension.name ?? extension.type;
}

function enabledJudges(manifest: EvalManifest): Set<string> {
  return new Set((manifest.judges ?? []).map(extensionName));
}

function buildJudges(
  scenario: string,
  reference: string | undefined,
  judges: Set<string>
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
      result.push({ judge: signalJudge, reference: scenario, threshold: 0.5 });
    }
  }
  return result;
}

function buildToolSelectionDataset(
  evalset: RawEvalset,
  hostConfig: MCPHostConfig,
  manifest: EvalManifest
): EvalDataset {
  const iterations = fixtureIterations(manifest);
  const cases = evalset.cases.map((case_) => {
    const expectedTool = String(case_.expected_tool);
    const scenario = String(case_.scenario);
    const tags = Array.isArray(case_.tags) ? (case_.tags as string[]) : [];
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
    description: evalset.description ?? 'Tool selection evaluation.',
    cases,
  });
}

function buildToolCallDataset(
  evalset: RawEvalset,
  hostConfig: MCPHostConfig
): EvalDataset {
  const cases = evalset.cases.map((case_) => {
    const tool = String(case_.tool);
    const tags = Array.isArray(case_.tags) ? (case_.tags as string[]) : [];
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
    if (case_.mode === 'mcp_host') fixtureCase.mcpHostConfig = hostConfig;
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
  manifest: EvalManifest
): EvalDataset {
  const judges = enabledJudges(manifest);
  const cases = evalset.cases.map((case_) => {
    const scenario = String(case_.scenario);
    const reference =
      typeof case_.reference === 'string' ? case_.reference : undefined;
    const tags = Array.isArray(case_.tags) ? (case_.tags as string[]) : [];
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

/**
 * Convert a tagged dataset source into the canonical EvalDataset model.
 * Legacy fixture shapes are inferred from their fields; configuration does not
 * need a second top-level evaluation mode.
 */
export function buildEvalDataset(
  raw: unknown,
  hostConfig: MCPHostConfig,
  manifest: EvalManifest
): EvalDataset {
  if (isPrebuiltDataset(raw)) {
    let dataset = loadEvalDatasetFromObject(raw);
    if (manifest.maxCases && dataset.cases.length > manifest.maxCases) {
      dataset = {
        ...dataset,
        cases: dataset.cases.slice(0, manifest.maxCases),
      };
    }
    return dataset;
  }

  if (
    !raw ||
    typeof raw !== 'object' ||
    !Array.isArray((raw as RawEvalset).cases)
  ) {
    throw new Error('Dataset must contain a cases array');
  }
  const evalset = raw as RawEvalset;
  const firstCase = evalset.cases[0] ?? {};
  let dataset: EvalDataset;
  if ('expected_tool' in firstCase) {
    dataset = buildToolSelectionDataset(evalset, hostConfig, manifest);
  } else if ('tool' in firstCase) {
    dataset = buildToolCallDataset(evalset, hostConfig);
  } else if ('scenario' in firstCase) {
    dataset = buildE2eQualityDataset(evalset, hostConfig, manifest);
  } else {
    throw new Error(
      'Unable to infer dataset shape; provide canonical EvalDataset cases.'
    );
  }

  if (manifest.maxCases && dataset.cases.length > manifest.maxCases) {
    dataset = { ...dataset, cases: dataset.cases.slice(0, manifest.maxCases) };
  }
  return dataset;
}
