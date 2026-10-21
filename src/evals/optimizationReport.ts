/**
 * What a stored tool optimization shows: the evidence a proposer may read
 * before the next round (`mst optimize evidence`), and the recommendation
 * it ends with (`recommendation.md`).
 */
import type { Tool } from '@modelcontextprotocol/client';
import type {
  EvalCaseResult,
  PairedChange,
  TrialResult,
} from '../types/reporter.js';
import type { EvalRunnerResult, ToolMetadataOverride } from './evalRunner.js';
import type { OptimizationRecord } from './optimizationFormat.js';
import { isInfraTrial } from './runFormat.js';
import type { ListedServerTools } from './toolSurface.js';
import type {
  OptimizationState,
  ToolOptimizationResult,
  VariantCandidateResult,
} from './toolOptimization.js';
import {
  caseGrouper,
  caseTags,
  meanCasePassRate,
} from './variantComparison.js';

/** Longest argument value shown in a failed trial's calls. */
const MAX_ARGUMENT_CHARS = 120;
/** Longest grader message shown for a failed trial. */
const MAX_GRADER_CHARS = 200;

/** One case's results, as a proposer sees them. */
interface CaseEvidence {
  id: string;
  group: 'capability' | 'regression';
  input?: string;
  /** What the case's assertions expect, in words. */
  expected: string;
  passedTrials: number;
  trials: number;
  /** Each failed trial: its calls in order, missed tools, failed graders. */
  failedTrials: string[];
  /** On a candidate's case: the baseline's trials passed, when they differ. */
  baseline?: { passedTrials: number; trials: number };
}

/** A served tool, as the optimization shows it. */
interface ToolEvidence {
  server?: string;
  name: string;
  editable: boolean;
  title?: string;
  description?: string;
  inputSchema: Tool['inputSchema'];
}

/** One earlier candidate, as a proposer sees it. */
interface CandidateEvidence {
  round: number;
  id: string;
  description?: string;
  tools: Record<string, ToolMetadataOverride>;
  value: number;
  delta: number;
  disqualified: boolean;
  /** Regression cases it clearly broke. */
  brokenCaseIds: string[];
  /** Its results on cases that didn't pass every trial, or changed from the baseline. */
  cases: CaseEvidence[];
}

/**
 * What a proposer may see before the next round: no held-out cases, no
 * tool responses, no final answers.
 */
export interface OptimizationEvidence {
  id: string;
  metric: string;
  better: 'higher' | 'lower';
  baseVariant: string;
  budget: { maxVariants?: number; tried: number; left?: number };
  /** Undefined: every tool is editable. */
  editableTools?: string[];
  /** Held-out cases the evidence leaves out. */
  heldOutCases: number;
  tools: ToolEvidence[];
  baseline: { value: number; cases: CaseEvidence[] };
  candidates: CandidateEvidence[];
  bestSoFar?: string;
  /** The round the next candidates run as. */
  nextRound: number;
}

/** What `buildEvidence` reads. */
interface EvidenceSource {
  record: OptimizationRecord;
  state: OptimizationState;
  servedTools: readonly ListedServerTools[];
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** The trials of a case result. */
function trialsOf(result: EvalCaseResult): Array<TrialResult | EvalCaseResult> {
  return result.trialResults?.length ? result.trialResults : [result];
}

/** What a case's assertions expect, in words a proposer can act on. */
export function describeExpectation(
  assertions: Record<string, unknown> | undefined
): string {
  if (!assertions) return 'no assertions';
  const parts: string[] = [];
  const count = assertions.toolCallCount as
    | { min?: number; max?: number }
    | undefined;
  const triggered = assertions.toolsTriggered as
    | {
        calls?: Array<{
          name: string;
          required?: boolean;
          arguments?: unknown;
        }>;
        exclusive?: boolean;
        order?: string;
      }
    | undefined;
  if (count?.max === 0) parts.push('no tool call at all');
  if (triggered?.calls?.length) {
    const required = triggered.calls.filter((c) => c.required !== false);
    const optional = triggered.calls.filter((c) => c.required === false);
    if (required.length)
      parts.push(
        `must call ${required
          .map((c) =>
            c.arguments === undefined
              ? c.name
              : `${c.name} with ${JSON.stringify(c.arguments)}`
          )
          .join(
            ' and '
          )}${triggered.order === 'strict' ? ', in that order' : ''}`
      );
    if (optional.length)
      parts.push(`may call ${optional.map((c) => c.name).join(', ')}`);
    if (triggered.exclusive) parts.push('any other tool fails');
  }
  if (count && count.max !== 0) {
    if (count.min !== undefined && count.max !== undefined)
      parts.push(`${count.min} to ${count.max} tool calls`);
    else if (count.min !== undefined)
      parts.push(`at least ${count.min} tool calls`);
    else if (count.max !== undefined)
      parts.push(`at most ${count.max} tool calls`);
  }
  const others = Object.keys(assertions).filter(
    (key) => key !== 'toolsTriggered' && key !== 'toolCallCount'
  );
  if (others.length) parts.push(`also checked: ${others.join(', ')}`);
  return parts.length ? parts.join('; ') : 'no assertions';
}

/** One failed trial, in one line. */
function describeTrial(trial: TrialResult | EvalCaseResult): string {
  const calls = trial.toolCallTrace?.calls ?? [];
  const parts: string[] = [];
  parts.push(
    calls.length
      ? calls
          .map((call) => {
            const args = Object.fromEntries(
              Object.entries(call.arguments ?? {}).map(([key, value]) => [
                key,
                typeof value === 'string'
                  ? truncate(value, MAX_ARGUMENT_CHARS)
                  : value,
              ])
            );
            return `${call.name}(${truncate(JSON.stringify(args), MAX_ARGUMENT_CHARS * 2)})${call.status === 'unexpected' ? ' [unexpected]' : ''}`;
          })
          .join(' -> ')
      : '(no tool calls)'
  );
  const missed = trial.toolCallTrace?.missed ?? [];
  if (missed.length)
    parts.push(`missed ${missed.map((call) => call.name).join(', ')}`);
  const failedGraders = Object.entries(trial.scores ?? {}).filter(
    ([grader, score]) =>
      score &&
      !score.pass &&
      grader !== 'toolsTriggered' &&
      grader !== 'toolCallCount'
  );
  for (const [grader, score] of failedGraders)
    parts.push(
      `${grader} failed${score?.details || score?.reasoning ? `: ${truncate(score.details ?? score.reasoning ?? '', MAX_GRADER_CHARS)}` : ''}`
    );
  if (trial.error)
    parts.push(`error: ${truncate(trial.error, MAX_GRADER_CHARS)}`);
  return parts.join('; ');
}

function caseEvidence(
  result: EvalCaseResult,
  group: 'capability' | 'regression'
): CaseEvidence {
  const counted = trialsOf(result).filter((trial) => !isInfraTrial(trial));
  return {
    id: result.id,
    group,
    ...(result.request?.input !== undefined
      ? { input: result.request.input }
      : {}),
    expected: describeExpectation(result.request?.assertions),
    passedTrials: counted.filter((trial) => trial.pass).length,
    trials: counted.length,
    failedTrials: counted
      .filter((trial) => !trial.pass)
      .map((trial) => describeTrial(trial)),
  };
}

/** The evidence a proposer may see before the next round. */
export function buildEvidence(source: EvidenceSource): OptimizationEvidence {
  const { record, state, servedTools } = source;
  const groupOf = state.grouping
    ? caseGrouper(state.grouping)
    : () => 'capability' as const;
  const editable = record.editableTools;
  const multi = servedTools.length > 1;
  const tools: ToolEvidence[] = servedTools.flatMap(({ server, tools }) =>
    tools.map((tool) => ({
      ...(server !== undefined && multi ? { server } : {}),
      name: tool.name,
      editable:
        !editable ||
        editable.some(
          (entry) =>
            entry === tool.name ||
            (server !== undefined && entry === `${server}.${tool.name}`)
        ),
      ...(tool.title ? { title: tool.title } : {}),
      ...(tool.description !== undefined
        ? { description: tool.description }
        : {}),
      inputSchema: tool.inputSchema,
    }))
  );
  const baselineCases = new Map(
    state.seenBaseline.caseResults.map((c) => [
      c.id,
      caseEvidence(c, groupOf(c)),
    ])
  );
  const tried = state.rounds.reduce((n, r) => n + r.candidates.length, 0);
  const candidates: CandidateEvidence[] = state.proposerHistory.flatMap(
    (round) =>
      round.candidates.map((candidate) => ({
        round: round.round,
        id: candidate.variant.id,
        ...(candidate.variant.description !== undefined
          ? { description: candidate.variant.description }
          : {}),
        tools: candidate.variant.tools,
        value: candidate.metricValue,
        delta: candidate.metricDelta,
        disqualified: candidate.disqualified,
        brokenCaseIds: candidate.measurement.brokenCaseIds,
        cases: candidate.result.caseResults.flatMap((c) => {
          const entry = caseEvidence(c, groupOf(c));
          const base = baselineCases.get(c.id);
          const changed =
            base !== undefined &&
            base.passedTrials / Math.max(base.trials, 1) !==
              entry.passedTrials / Math.max(entry.trials, 1);
          if (!changed && entry.passedTrials === entry.trials) return [];
          return [
            changed
              ? {
                  ...entry,
                  baseline: {
                    passedTrials: base.passedTrials,
                    trials: base.trials,
                  },
                }
              : entry,
          ];
        }),
      }))
  );
  return {
    id: record.id,
    metric: record.metric,
    better: record.better,
    baseVariant: record.baseVariant,
    budget: {
      ...(record.maxVariants !== undefined
        ? {
            maxVariants: record.maxVariants,
            left: Math.max(0, record.maxVariants - tried),
          }
        : {}),
      tried,
    },
    ...(editable ? { editableTools: [...editable] } : {}),
    heldOutCases:
      state.baseline.caseResults.length - state.seenBaseline.caseResults.length,
    tools,
    baseline: {
      value: state.baselineValue,
      cases: [...baselineCases.values()],
    },
    candidates,
    ...(state.bestSoFar ? { bestSoFar: state.bestSoFar.variant.id } : {}),
    nextRound: state.rounds.length,
  };
}

function formatValue(metric: string, value: number): string {
  return metric === 'passRate' || metric === 'trialPassRate'
    ? `${(value * 100).toFixed(1)}%`
    : Number.isInteger(value)
      ? String(value)
      : value.toFixed(3);
}

function formatDelta(metric: string, delta: number): string {
  const sign = delta >= 0 ? '+' : '−';
  const size = Math.abs(delta);
  return metric === 'passRate' || metric === 'trialPassRate'
    ? `${sign}${(size * 100).toFixed(1)} pts`
    : `${sign}${Number.isInteger(size) ? size : size.toFixed(3)}`;
}

/** A tool's parameters and their descriptions, one per line. */
function describeParameters(schema: Tool['inputSchema']): string[] {
  const properties = (schema.properties ?? {}) as Record<
    string,
    { type?: unknown; description?: unknown }
  >;
  const required = new Set(schema.required ?? []);
  const typeOf = (type: unknown): string | undefined =>
    typeof type === 'string'
      ? type
      : Array.isArray(type) && type.every((t) => typeof t === 'string')
        ? type.join('|')
        : undefined;
  return Object.entries(properties).map(([name, property]) => {
    const notes = [
      typeOf(property.type),
      required.has(name) ? 'required' : undefined,
    ].filter((note): note is string => note !== undefined);
    return `- \`${name}\`${notes.length ? ` (${notes.join(', ')})` : ''}${typeof property.description === 'string' ? `: ${property.description}` : ''}`;
  });
}

function renderCase(entry: CaseEvidence): string[] {
  const lines = [
    `- \`${entry.id}\` [${entry.group}] ${entry.passedTrials}/${entry.trials} trials passed${entry.baseline ? ` (baseline ${entry.baseline.passedTrials}/${entry.baseline.trials})` : ''}.${entry.input !== undefined ? ` Input: ${JSON.stringify(entry.input)}.` : ''} Expected: ${entry.expected}.`,
  ];
  for (const trial of entry.failedTrials)
    lines.push(`  - failed trial: ${trial}`);
  return lines;
}

/** The evidence as Markdown, for an agent or a person to read. */
export function renderEvidence(evidence: OptimizationEvidence): string {
  const { metric } = evidence;
  const lines: string[] = [];
  lines.push(`# Tool optimization ${evidence.id}`, '');
  lines.push(
    `Metric: ${metric} (${evidence.better} is better). Base variant: \`${evidence.baseVariant}\`. ` +
      `Candidates tried: ${evidence.budget.tried}${evidence.budget.maxVariants !== undefined ? ` of ${evidence.budget.maxVariants} (${evidence.budget.left} left)` : ''}. ` +
      (evidence.heldOutCases
        ? `${evidence.heldOutCases === 1 ? '1 held-out case is' : `${evidence.heldOutCases} held-out cases are`} left out, so the winner can be checked on cases nobody tuned it to.`
        : 'No case is held out.')
  );
  lines.push(
    '',
    "A candidate may change only editable tools: their name, description, and the description and title text inside their input schema. `mst optimize evidence --json` has each tool's full input schema to copy.",
    ''
  );
  lines.push('## Tools the servers serve', '');
  for (const tool of evidence.tools) {
    lines.push(
      `### ${tool.server ? `${tool.server}.` : ''}${tool.name}${tool.editable ? ' (editable)' : ''}`,
      ''
    );
    lines.push(tool.description ?? '(no description)', '');
    if (tool.editable) {
      const parameters = describeParameters(tool.inputSchema);
      if (parameters.length) lines.push('Parameters:', '', ...parameters, '');
    }
  }
  lines.push(
    `## Baseline: ${formatValue(metric, evidence.baseline.value)}`,
    ''
  );
  for (const entry of evidence.baseline.cases) lines.push(...renderCase(entry));
  let round = -1;
  for (const candidate of evidence.candidates) {
    if (candidate.round !== round) {
      round = candidate.round;
      lines.push('', `## Round ${round}`);
    }
    lines.push(
      '',
      `### ${candidate.id}: ${formatValue(metric, candidate.value)} (${formatDelta(metric, candidate.delta)} vs baseline)${candidate.disqualified ? `, disqualified${candidate.brokenCaseIds.length ? `: broke ${candidate.brokenCaseIds.join(', ')}` : ': broke regression cases'}` : ''}`,
      ''
    );
    if (candidate.description) lines.push(`Idea: ${candidate.description}`, '');
    for (const [tool, override] of Object.entries(candidate.tools)) {
      lines.push(`Tool \`${tool}\`:`);
      if (override.name) lines.push(`- name: \`${override.name}\``);
      if (override.description !== undefined)
        lines.push(
          '- description:',
          '',
          '  ```text',
          ...override.description.split('\n').map((line) => `  ${line}`),
          '  ```'
        );
      if (override.inputSchema) lines.push('- input schema text changed');
      lines.push('');
    }
    if (candidate.cases.length) {
      lines.push('Cases that failed a trial or changed from the baseline:', '');
      for (const entry of candidate.cases) lines.push(...renderCase(entry));
    } else {
      lines.push('Every case passed every trial.');
    }
  }
  lines.push('');
  lines.push(
    evidence.bestSoFar
      ? `Best so far: \`${evidence.bestSoFar}\`. Build on what worked; drop what didn't.`
      : 'No candidate has run yet.'
  );
  lines.push(
    '',
    `Next: write round ${evidence.nextRound}'s candidates to a JSON file ([{ "id", "description", "tools": { "<tool>": { "description" } } }]) and run mst optimize try <file>, or end with mst optimize finish.`,
    ''
  );
  return lines.join('\n');
}

/** Why an optimization ended, in words. */
const ENDINGS: Record<ToolOptimizationResult['reason'], string> = {
  finished: 'It ended when it was finished',
  'max-rounds': 'It ended after its last round',
  'max-variants': 'It ended when the variant budget ran out',
  'no-variants': 'It ended with no candidates to run',
  'no-improvement': 'It ended when a round stopped improving',
  'threshold-met': 'It ended when a candidate met the target',
};

/** What `renderRecommendation` reads. */
interface RecommendationSource {
  record: OptimizationRecord;
  result: ToolOptimizationResult;
  servedTools: readonly ListedServerTools[];
}

/** Mean per-case pass rate over the cases `keep` selects, or undefined when none. */
function passRateWhere(
  result: EvalRunnerResult,
  keep: (c: EvalCaseResult) => boolean
): { rate: number; cases: number } | undefined {
  const caseResults = result.caseResults.filter(keep);
  if (caseResults.length === 0) return undefined;
  return {
    rate: meanCasePassRate({ ...result, caseResults }),
    cases: caseResults.length,
  };
}

function formatThreshold(tried: number): string {
  return String(Number((0.025 / Math.max(tried, 1)).toPrecision(3)));
}

function percent(value: number): string {
  return `${Math.round(value * 100)}%`;
}

function describeChange(change: PairedChange | undefined): string {
  if (!change) return '';
  const pts = (value: number) =>
    `${value >= 0 ? '+' : '−'}${Math.round(Math.abs(value) * 100)}`;
  const p = change.mean < 0 ? change.pWorse : change.pBetter;
  return ` (${pts(change.mean)} pts, 95% range ${pts(change.lower)} to ${pts(change.upper)}, p = ${p < 0.001 ? '<0.001' : p.toFixed(3)})`;
}

function verdictOf(
  candidate: VariantCandidateResult,
  winnerId?: string
): string {
  if (candidate.metricUnavailable) return 'no value for the metric';
  if (candidate.disqualified) return 'disqualified: broke regression cases';
  if (candidate.variant.id === winnerId)
    return candidate.fixes
      ? '**winner**, clearly better'
      : '**best**, not clearly better';
  return candidate.fixes ? 'clearly better' : 'not clearly better';
}

function originalTool(
  key: string,
  servedTools: readonly ListedServerTools[]
): Tool | undefined {
  for (const { server, tools } of servedTools)
    for (const tool of tools)
      if (tool.name === key || `${server}.${tool.name}` === key) return tool;
  return undefined;
}

/** Each parameter whose description a candidate's input schema changes. */
function parameterChanges(
  original: Tool | undefined,
  schema: Record<string, unknown>
): string[] {
  const before = (original?.inputSchema.properties ?? {}) as Record<
    string,
    { description?: unknown }
  >;
  const after = (schema.properties ?? {}) as Record<
    string,
    { description?: unknown }
  >;
  return Object.entries(after)
    .filter(
      ([name, property]) => property?.description !== before[name]?.description
    )
    .map(
      ([name, property]) =>
        `- \`${name}\`: ${typeof property?.description === 'string' ? property.description : '(no description)'}`
    );
}

/** The optimization's recommendation as Markdown (`recommendation.md`). */
export function renderRecommendation(source: RecommendationSource): string {
  const { record, result, servedTools } = source;
  const { metric } = result;
  const proposal = result.proposal;
  const candidates = result.rounds.flatMap((round) =>
    round.candidates.map((candidate) => ({ round: round.round, candidate }))
  );
  const tried = candidates.length;
  const chosen = proposal
    ? candidates.find(
        ({ candidate }) => candidate.variant.id === proposal.variantId
      )?.candidate
    : undefined;
  const lines: string[] = [];
  const headline = !proposal
    ? 'no candidates ran'
    : proposal.recommendation === 'apply'
      ? `apply \`${proposal.variantId}\``
      : proposal.recommendation === 'reject'
        ? `reject: the best candidate, \`${proposal.variantId}\`, breaks cases that work today`
        : `inconclusive: no candidate is clearly better than the current metadata`;
  lines.push(`# Tool optimization ${record.id}: ${headline}`, '');
  const rounds = result.rounds.length;
  lines.push(
    `Eval \`${record.evalName}\`, base variant \`${record.baseVariant}\`, metric ${metric} (${record.better} is better). ${tried === 1 ? '1 candidate' : `${tried} candidates`} in ${rounds === 1 ? '1 round' : `${rounds} rounds`}. ${ENDINGS[result.reason]}.`,
    ''
  );
  if (chosen) {
    const heldOutTag = record.rules.heldOutTag;
    const groupOf = caseGrouper(
      result.grouping === 'declared'
        ? { source: 'declared', tag: record.rules.regressionTag }
        : {
            source: 'grouping-run',
            run: result.groupingBaseline ?? result.baseline,
          }
    );
    const isHeldOut = (c: EvalCaseResult) => caseTags(c).includes(heldOutTag);
    const rows: Array<
      [string, (c: EvalCaseResult) => boolean, PairedChange | undefined]
    > = [
      [
        'Capability cases',
        (c) => groupOf(c) === 'capability',
        chosen.measurement.capability.change,
      ],
      [
        'Regression cases',
        (c) => groupOf(c) === 'regression',
        chosen.measurement.regression.change,
      ],
      [
        'Held-out capability cases',
        (c) => isHeldOut(c) && groupOf(c) === 'capability',
        chosen.measurement.capability.heldOutChange,
      ],
    ];
    lines.push(
      `| | Current | \`${chosen.variant.id}\` |`,
      '| --- | --- | --- |'
    );
    for (const [label, keep, change] of rows) {
      const before = passRateWhere(result.baseline, keep);
      const after = passRateWhere(chosen.result, keep);
      if (!before || !after) continue;
      const heldOut = label.startsWith('Held-out')
        ? 0
        : result.baseline.caseResults.filter((c) => keep(c) && isHeldOut(c))
            .length;
      lines.push(
        `| ${label} (${before.cases}${heldOut ? `, ${heldOut} held out` : ''}) | ${percent(before.rate)} | ${percent(after.rate)}${describeChange(change)} |`
      );
    }
    lines.push(
      `| ${metric}, held-out excluded | ${formatValue(metric, result.proposal!.baselineValue)} | ${formatValue(metric, chosen.metricValue)} (${formatDelta(metric, chosen.metricDelta)}) |`,
      `| Cases improved / regressed | | ${proposal!.improvedCaseIds.length} / ${proposal!.regressedCaseIds.length} |`,
      ''
    );
    lines.push(
      `A candidate is clearly better when the paired sign-flip test over its capability cases gives p < ${formatThreshold(tried)} (0.025, divided by the ${tried} candidates tried). The held-out p-value needs no division: candidates were never ranked on those cases.`,
      ''
    );
    lines.push(
      proposal!.recommendation === 'apply'
        ? '## The tool metadata to apply'
        : `## \`${chosen.variant.id}\`'s tool metadata`,
      ''
    );
    for (const [key, override] of Object.entries(chosen.variant.tools)) {
      const original = originalTool(key, servedTools);
      lines.push(`### ${key}`, '');
      if (override.name && override.name !== original?.name)
        lines.push(`Rename to \`${override.name}\`.`, '');
      if (
        override.description !== undefined &&
        override.description !== original?.description
      )
        lines.push(
          'Description:',
          '',
          '```text',
          override.description,
          '```',
          ''
        );
      if (override.inputSchema) {
        const changes = parameterChanges(original, override.inputSchema);
        if (changes.length)
          lines.push('Parameter descriptions:', '', ...changes, '');
      }
    }
  }
  lines.push('## Every candidate', '');
  lines.push(
    `| Round | Candidate | ${metric} | vs current | Verdict |`,
    '| --- | --- | --- | --- | --- |'
  );
  lines.push(
    `| | current metadata | ${formatValue(metric, proposal?.baselineValue ?? result.rounds[0]?.candidates[0]?.metricValue ?? 0)} | | |`
  );
  const winnerId = result.winner?.variant.id;
  for (const { round, candidate } of candidates)
    lines.push(
      `| ${round} | \`${candidate.variant.id}\`${candidate.variant.description ? `: ${candidate.variant.description.replaceAll('|', '\\|')}` : ''} | ${formatValue(metric, candidate.metricValue)} | ${formatDelta(metric, candidate.metricDelta)} | ${verdictOf(candidate, winnerId)} |`
    );
  lines.push('', '## Runs', '');
  lines.push(`- Baseline: \`${record.baseline.runId}\``);
  if (record.grouping.runId)
    lines.push(
      `- Grouping run (the cases it passed are regression cases): \`${record.grouping.runId}\``
    );
  for (const round of record.rounds)
    if (round.runId) lines.push(`- Round ${round.round}: \`${round.runId}\``);
  lines.push(
    '',
    'Open a run with mst open <run-id>. MST changes nothing on the server or in the eval config: apply the metadata on the server, and the next optimization starts from it.',
    ''
  );
  return lines.join('\n');
}
