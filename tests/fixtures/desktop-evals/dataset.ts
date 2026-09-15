import { z } from 'zod';
import {
  EvalDatasetSchema,
  type EvalDataset,
  type EvalExpectBlock,
} from '../../../src/evals/datasetTypes.js';
import type { DesktopEvalOracle } from './fixture.js';
import type { DesktopRecord } from './contract.js';

function parseJson(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  const trimmed = value.trim();
  const fenced = /^```(?:json)?\s*\n([\s\S]*?)\n```$/i.exec(trimmed);
  const candidate = fenced?.[1] ?? trimmed;
  try {
    return JSON.parse(candidate) as unknown;
  } catch {
    return value;
  }
}

function answerSchema(
  oracle: DesktopEvalOracle,
  record: DesktopRecord,
  recovered = false
) {
  const answer = z
    .object({
      status: z.literal(recovered ? 'recovered' : 'found'),
      reference: z.literal(record.reference),
      verificationCode: z.literal(record.verificationCode),
      serverLabel: z.literal(oracle.primary.serverLabel),
      ...(recovered
        ? { requestedReference: z.literal('missing-release') }
        : {}),
    })
    .strict();
  // hostTraceToExecution keeps the final text in the response envelope.
  return z.object({
    response: z
      .string()
      .refine(
        (text) => answer.safeParse(parseJson(text)).success,
        'Expected the requested JSON answer with evaluator-known values'
      ),
  });
}

/** Offline SDK smoke checks. These do not claim desktop/model coverage. */
export function createDesktopSmokeDataset(
  oracle: DesktopEvalOracle
): EvalDataset {
  return EvalDatasetSchema.parse({
    name: 'desktop-fixture-smoke',
    cases: [
      {
        id: 'smoke-direct',
        mode: 'direct',
        toolName: 'lookup_record',
        args: { namespace: 'releases', reference: oracle.direct.reference },
        expect: {
          isError: false,
          containsText: oracle.direct.verificationCode,
        },
      },
      {
        id: 'smoke-search',
        mode: 'direct',
        toolName: 'search_records',
        args: { namespace: 'releases', query: 'dependent release' },
        expect: { isError: false, containsText: oracle.dependent.reference },
      },
      {
        id: 'smoke-missing',
        mode: 'direct',
        toolName: 'lookup_record',
        args: { namespace: 'releases', reference: 'missing-release' },
        expect: {
          isError: true,
          containsText: ['NOT_FOUND', 'missing-release'],
        },
      },
    ],
  });
}

/** Canonical dataset; only scenario strings and server configs go to the host. */
export function createDesktopEvalDataset(
  oracle: DesktopEvalOracle
): EvalDataset {
  function lookup(reference: string) {
    return {
      name: 'lookup_record',
      kind: 'tool_call' as const,
      source: 'mcp' as const,
      server: oracle.primary.serverLabel,
      arguments: { namespace: 'releases', reference },
      required: true,
    };
  }
  function search(query: string) {
    return {
      name: 'search_records',
      kind: 'tool_call' as const,
      source: 'mcp' as const,
      server: oracle.primary.serverLabel,
      arguments: { namespace: 'releases', query },
      required: true,
    };
  }
  function expectations(
    schema: string,
    calls: NonNullable<EvalExpectBlock['toolsTriggered']>['calls']
  ): EvalExpectBlock {
    return {
      schema,
      isError: false,
      toolsTriggered: { calls, order: 'strict', exclusive: true },
      toolCallCount: { exact: calls.length },
    };
  }
  const common = `Use only the read-only MCP server ${oracle.primary.serverLabel}, not desktop_decoy. Use namespace "releases". Do not use workspace files, commands, or other tools. `;
  const json =
    'Reply with only one JSON object with keys status ("found"), reference, verificationCode, and serverLabel from the lookup result. Do not invent values.';
  const dataset = EvalDatasetSchema.parse({
    name: 'representative-desktop-evals',
    description:
      'Fresh synthetic records; evaluator-held answers and independent MCP request evidence.',
    cases: [
      {
        id: 'direct-lookup',
        mode: 'host',
        scenario: `${common}Look up reference "${oracle.direct.reference}" with lookup_record. ${json}`,
        expect: expectations('DesktopDirectAnswer', [
          lookup(oracle.direct.reference),
        ]),
      },
      {
        id: 'dependent-lookup',
        mode: 'host',
        scenario: `${common}Search with search_records for the exact title "dependent release". Then use lookup_record with the reference returned by that search. ${json}`,
        expect: expectations('DesktopDependentAnswer', [
          search('dependent release'),
          lookup(oracle.dependent.reference),
        ]),
      },
      {
        id: 'missing-recovery',
        mode: 'host',
        scenario: `${common}First look up "missing-release" with lookup_record. If the result is NOT_FOUND, search_records for "recovery release", then look up the reference returned by that search. Reply with only one JSON object with keys status ("recovered"), requestedReference ("missing-release"), reference, verificationCode, and serverLabel from the recovered lookup. Do not invent values.`,
        expect: expectations('DesktopRecoveryAnswer', [
          lookup('missing-release'),
          search('recovery release'),
          lookup(oracle.recovery.reference),
        ]),
      },
    ],
  });
  return {
    ...dataset,
    schemas: {
      DesktopDirectAnswer: answerSchema(oracle, oracle.direct),
      DesktopDependentAnswer: answerSchema(oracle, oracle.dependent),
      DesktopRecoveryAnswer: answerSchema(oracle, oracle.recovery, true),
    },
  };
}
