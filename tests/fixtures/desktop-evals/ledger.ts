import assert from 'node:assert/strict';
import {
  CallToolRequestSchema,
  CallToolResultSchema,
} from '@modelcontextprotocol/sdk/types.js';
import type {
  EvalCase,
  EvalExpectBlock,
} from '../../../src/evals/datasetTypes.js';
import type { HostEvent } from '../../../src/evals/evalFrameworkTypes.js';
import type { DesktopEvalOracle } from './fixture.js';
import type { DesktopLedgerEntry } from './contract.js';

/**
 * Check a single case's ledger slice against the evaluator's canonical case and
 * native host events. Never generate host events from this ledger. Native IDs
 * are deliberately ignored: only the ledger pairs wire IDs within a session.
 */
export function assertDesktopLedgerEvidence(
  oracle: DesktopEvalOracle,
  evalCase: EvalCase,
  entries: DesktopLedgerEntry[],
  events: HostEvent[]
): void {
  const expectedCalls = evalCase.expect?.toolsTriggered?.calls;
  assert(expectedCalls?.length, 'Expected canonical tool-call assertions');
  const sequences = new Map<string, number>();
  for (const entry of entries) {
    assert.equal(entry.runId, oracle.runId, 'ledger run provenance');
    const identity = [oracle.primary, oracle.decoy].find(
      (server) => server.serverLabel === entry.serverLabel
    );
    assert.equal(
      entry.serverName,
      identity?.serverName,
      'ledger server provenance'
    );
    const previous = sequences.get(entry.sessionId);
    if (previous !== undefined)
      assert.equal(entry.sequence, previous + 1, 'ledger sequence');
    sequences.set(entry.sessionId, entry.sequence);
  }
  const requests = entries.filter(
    (entry) =>
      entry.direction === 'request' &&
      'method' in entry.message &&
      entry.message.method === 'tools/call'
  );
  assert.equal(requests.length, expectedCalls.length, 'ledger request count');
  assert.equal(events.length, expectedCalls.length, 'native event count');
  const records = [oracle.direct, oracle.dependent, oracle.recovery];
  for (const [index, entry] of requests.entries()) {
    const expected: NonNullable<
      EvalExpectBlock['toolsTriggered']
    >['calls'][number] = expectedCalls[index]!;
    const request = CallToolRequestSchema.parse(entry.message);
    assert.equal(
      entry.serverLabel,
      expected.server,
      'request server provenance'
    );
    assert.equal(request.params.name, expected.name, 'request tool order');
    assert.deepEqual(
      request.params.arguments,
      expected.arguments,
      'request arguments'
    );
    const event = events[index]!;
    assert.deepEqual(
      {
        kind: event.kind,
        source: event.source,
        server: event.server,
        name: event.name,
      },
      {
        kind: 'tool_call',
        source: 'mcp',
        server: expected.server,
        name: expected.name,
      },
      'native event provenance/order'
    );
    assert.deepEqual(
      event.arguments,
      expected.arguments,
      'native event arguments'
    );
    assert('id' in entry.message, 'tool request needs a wire ID');
    const wireId = entry.message.id;
    const responses = entries.filter(
      (candidate) =>
        candidate.direction === 'response' &&
        candidate.sessionId === entry.sessionId &&
        'id' in candidate.message &&
        candidate.message.id === wireId
    );
    assert.equal(responses.length, 1, 'ledger result count');
    const response = responses[0]!;
    assert.equal(
      response.serverLabel,
      entry.serverLabel,
      'result server provenance'
    );
    assert(
      entries.indexOf(response) > entries.indexOf(entry),
      'result must follow request'
    );
    const next = requests[index + 1];
    if (next)
      assert(
        entries.indexOf(response) < entries.indexOf(next),
        'result must precede dependent request'
      );
    assert(
      'result' in response.message,
      'Expected tool result, not a protocol error'
    );
    assert.equal(event.error, undefined, 'native event protocol error shape');
    assert.equal(typeof event.output, 'string', 'native event result shape');
    assert.deepEqual(
      JSON.parse(event.output!),
      response.message.result,
      'native result must match the independent ledger'
    );
    const result = CallToolResultSchema.parse(response.message.result);
    const args = request.params.arguments ?? {};
    const record = records.find((item) => item.reference === args.reference);
    let structuredContent: Record<string, unknown>;
    let isError = false;
    if (request.params.name === 'lookup_record') {
      isError = !record;
      structuredContent = record
        ? { serverLabel: oracle.primary.serverLabel, record }
        : {
            serverLabel: oracle.primary.serverLabel,
            code: 'NOT_FOUND',
            reference: args.reference,
            recovery:
              'Search releases by title, then look up a returned reference.',
          };
    } else {
      assert.equal(
        request.params.name,
        'search_records',
        'Unsupported fixture tool'
      );
      structuredContent = {
        serverLabel: oracle.primary.serverLabel,
        matches: records
          .filter((item) => item.title.toLowerCase() === args.query)
          .map(({ reference, title }) => ({ reference, title })),
      };
    }
    assert.equal(result.isError, isError, 'result error status');
    assert.deepEqual(
      result.structuredContent,
      structuredContent,
      'result payload'
    );
    assert.deepEqual(
      result.content,
      [{ type: 'text', text: JSON.stringify(structuredContent) }],
      'result text payload'
    );
  }
}
