import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  createMCPClientForConfig,
  closeMCPClient,
} from '../../../src/mcp/clientFactory.js';
import type { HostEvent } from '../../../src/evals/evalFrameworkTypes.js';
import {
  createDesktopEvalFixture,
  type DesktopEvalFixture,
} from '../../fixtures/desktop-evals/fixture.js';
import { createDesktopEvalDataset } from '../../fixtures/desktop-evals/dataset.js';
import { assertDesktopLedgerEvidence } from '../../fixtures/desktop-evals/ledger.js';

const fixtures: DesktopEvalFixture[] = [];
afterEach(async () => {
  for (const fixture of fixtures.splice(0)) await fixture.dispose();
});

describe('independent desktop fixture ledger', () => {
  it('rejects a decoy exchange even when a native event claims the primary server', async () => {
    const fixture = await createDesktopEvalFixture();
    fixtures.push(fixture);
    const evalCase = createDesktopEvalDataset(fixture.oracle).cases[0]!;
    const args = {
      namespace: 'releases',
      reference: fixture.oracle.direct.reference,
    };
    const client = await createMCPClientForConfig(fixture.servers[1]);
    try {
      await client.callTool({ name: 'lookup_record', arguments: args });
      const entries = await fixture.readLedger();
      expect(() =>
        assertDesktopLedgerEvidence(fixture.oracle, evalCase, entries, [
          {
            kind: 'tool_call',
            source: 'mcp',
            server: 'desktop_records',
            name: 'lookup_record',
            arguments: args,
            id: 'claimed-native-event',
          },
        ])
      ).toThrow(/request server provenance/);
    } finally {
      await closeMCPClient(client);
    }
  });
  it.each(['dependent-lookup', 'missing-recovery'])(
    'checks %s using references from real results and rejects reversed native events',
    async (caseId) => {
      const fixture = await createDesktopEvalFixture();
      fixtures.push(fixture);
      const evalCase = createDesktopEvalDataset(fixture.oracle).cases.find(
        (item) => item.id === caseId
      )!;
      const client = await createMCPClientForConfig(fixture.servers[0]);
      try {
        const results: unknown[] = [];
        if (caseId === 'missing-recovery') {
          const missing = await client.callTool({
            name: 'lookup_record',
            arguments: {
              namespace: 'releases',
              reference: 'missing-release',
            },
          });
          expect(missing.isError).toBe(true);
          results.push(missing);
        }
        const search = await client.callTool({
          name: 'search_records',
          arguments: {
            namespace: 'releases',
            query:
              caseId === 'missing-recovery'
                ? 'recovery release'
                : 'dependent release',
          },
        });
        results.push(search);
        const { matches } = z
          .object({ matches: z.array(z.object({ reference: z.string() })) })
          .parse(search.structuredContent);
        results.push(
          await client.callTool({
            name: 'lookup_record',
            arguments: {
              namespace: 'releases',
              reference: matches[0]!.reference,
            },
          })
        );
        const entries = await fixture.waitForLedger((ledger) => {
          const requests = ledger.filter(
            (entry) =>
              entry.direction === 'request' &&
              'method' in entry.message &&
              entry.message.method === 'tools/call' &&
              'id' in entry.message
          );
          return (
            requests.length === results.length &&
            requests.every((request) =>
              ledger.some(
                (entry) =>
                  entry.direction === 'response' &&
                  entry.sessionId === request.sessionId &&
                  'id' in entry.message &&
                  'id' in request.message &&
                  entry.message.id === request.message.id
              )
            )
          );
        });
        const events: HostEvent[] = evalCase.expect!.toolsTriggered!.calls.map(
          (call, index) => ({
            kind: 'tool_call',
            source: 'mcp',
            server: call.server,
            name: call.name,
            arguments: call.arguments,
            id: `native-${index}`,
            output: JSON.stringify(results[index]),
          })
        );
        assertDesktopLedgerEvidence(fixture.oracle, evalCase, entries, events);
        expect(() =>
          assertDesktopLedgerEvidence(
            fixture.oracle,
            evalCase,
            entries,
            [...events].reverse()
          )
        ).toThrow(/native event/);
        if (caseId === 'missing-recovery') {
          const changed = structuredClone(entries);
          const error = changed.find(
            (entry) =>
              'result' in entry.message && entry.message.result.isError === true
          )!;
          const changedEvents = structuredClone(events);
          if ('result' in error.message) {
            error.message.result.isError = false;
            changedEvents[0]!.output = JSON.stringify(error.message.result);
          }
          expect(() =>
            assertDesktopLedgerEvidence(
              fixture.oracle,
              evalCase,
              changed,
              changedEvents
            )
          ).toThrow(/result error status/);
        }
      } finally {
        await closeMCPClient(client);
      }
    }
  );

  it('records invalid arguments and unknown tools even when SDK validation rejects dispatch', async () => {
    const fixture = await createDesktopEvalFixture();
    fixtures.push(fixture);
    const client = await createMCPClientForConfig(fixture.servers[0]);
    try {
      for (const request of [
        {
          name: 'lookup_record',
          arguments: {
            namespace: 'not-releases',
            reference: fixture.oracle.direct.reference,
          },
        },
        {
          name: 'delete_record',
          arguments: { reference: fixture.oracle.direct.reference },
        },
      ]) {
        expect(await client.callTool(request)).toMatchObject({ isError: true });
      }
      const entries = await fixture.waitForLedger(
        (ledger) =>
          ledger.filter(
            (entry) =>
              entry.direction === 'response' &&
              'result' in entry.message &&
              entry.message.result.isError === true
          ).length === 2
      );
      const requests = entries.filter(
        (entry) =>
          entry.direction === 'request' &&
          'method' in entry.message &&
          entry.message.method === 'tools/call'
      );
      expect(requests).toHaveLength(2);
      expect(requests[0]?.message).toMatchObject({
        params: { arguments: { namespace: 'not-releases' } },
      });
      expect(requests[1]?.message).toMatchObject({
        params: { name: 'delete_record' },
      });
      const results = entries.filter(
        (entry) =>
          entry.direction === 'response' &&
          'result' in entry.message &&
          entry.message.result.isError === true
      );
      expect(results).toHaveLength(2);
    } finally {
      await closeMCPClient(client);
    }
  });
  it('checks real wire results against canonical events without comparing native IDs to wire IDs', async () => {
    const fixture = await createDesktopEvalFixture();
    fixtures.push(fixture);
    const evalCase = createDesktopEvalDataset(fixture.oracle).cases[0]!;
    const args = {
      namespace: 'releases',
      reference: fixture.oracle.direct.reference,
    };
    // An event contract example, not a fake host or a claim of model success.
    const events: HostEvent[] = [
      {
        kind: 'tool_call',
        source: 'mcp',
        server: 'desktop_records',
        name: 'lookup_record',
        arguments: args,
        id: 'native-id-is-not-a-wire-id',
      },
    ];
    expect(() =>
      assertDesktopLedgerEvidence(fixture.oracle, evalCase, [], events)
    ).toThrow(/request count/);
    const client = await createMCPClientForConfig(fixture.servers[0]);
    try {
      const toolResult = await client.callTool({
        name: 'lookup_record',
        arguments: args,
      });
      events[0]!.output = JSON.stringify(toolResult);
      const entries = await fixture.waitForLedger((ledger) =>
        ledger.some(
          (entry) =>
            entry.direction === 'response' &&
            'result' in entry.message &&
            entry.message.result.isError === false
        )
      );
      expect(() =>
        assertDesktopLedgerEvidence(fixture.oracle, evalCase, entries, events)
      ).not.toThrow();
      expect(() =>
        assertDesktopLedgerEvidence(fixture.oracle, evalCase, entries, [
          { ...events[0]!, server: 'desktop_decoy' },
        ])
      ).toThrow(/event provenance/);
      expect(() =>
        assertDesktopLedgerEvidence(fixture.oracle, evalCase, entries, [])
      ).toThrow(/event count/);
      expect(() =>
        assertDesktopLedgerEvidence(
          fixture.oracle,
          evalCase,
          entries.slice(0, -1),
          events
        )
      ).toThrow(/result count/);
      const corrupted = structuredClone(entries);
      const result = corrupted.at(-1)!;
      if ('result' in result.message)
        result.message.result = {
          isError: false,
          content: [],
          structuredContent: { record: { verificationCode: 'fabricated' } },
        };
      const corruptedEvents = structuredClone(events);
      if ('result' in result.message)
        corruptedEvents[0]!.output = JSON.stringify(result.message.result);
      expect(() =>
        assertDesktopLedgerEvidence(
          fixture.oracle,
          evalCase,
          corrupted,
          corruptedEvents
        )
      ).toThrow(/result payload/);
      expect(() =>
        assertDesktopLedgerEvidence(
          { ...fixture.oracle, runId: 'a-different-run' },
          evalCase,
          entries,
          events
        )
      ).toThrow(/run provenance/);
    } finally {
      await closeMCPClient(client);
    }
  });
});
