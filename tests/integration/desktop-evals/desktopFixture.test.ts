import { afterEach, describe, expect, it } from 'vitest';
import { readdir, stat } from 'node:fs/promises';
import { z } from 'zod';
import {
  closeMCPClient,
  createMCPClientForConfig,
} from '../../../src/mcp/clientFactory.js';
import { createMCPFixture } from '../../../src/mcp/fixtures/mcpFixture.js';
import {
  createDesktopEvalFixture,
  type DesktopEvalFixture,
} from '../../fixtures/desktop-evals/fixture.js';

const fixtures: DesktopEvalFixture[] = [];

afterEach(async () => {
  for (const fixture of fixtures.splice(0)) await fixture.dispose();
});

describe('representative desktop MCP fixture', () => {
  it('distinguishes two servers with identical tool names and references using private provenance', async () => {
    const fixture = await createDesktopEvalFixture();
    fixtures.push(fixture);
    const clients = await Promise.all(
      fixture.servers.map((config) => createMCPClientForConfig(config))
    );
    try {
      expect(clients).toHaveLength(2);
      const responses = await Promise.all(
        clients.map((client) =>
          client.callTool({
            name: 'lookup_record',
            arguments: {
              namespace: 'releases',
              reference: fixture.oracle.direct.reference,
            },
          })
        )
      );
      expect(responses[0]?.structuredContent).toMatchObject({
        serverLabel: 'desktop_records',
        record: fixture.oracle.direct,
      });
      expect(responses[1]?.structuredContent).toMatchObject({
        serverLabel: 'desktop_decoy',
      });
      expect(JSON.stringify(responses[1])).not.toContain(
        fixture.oracle.direct.verificationCode
      );
      const calls = (await fixture.readLedger()).filter(
        (entry) =>
          entry.direction === 'request' &&
          'method' in entry.message &&
          entry.message.method === 'tools/call'
      );
      expect(new Set(calls.map((entry) => entry.serverName)).size).toBe(2);
      expect(new Set(calls.map((entry) => entry.sessionId)).size).toBe(2);
      // SDK clients reuse wire request IDs across connections. They are not global IDs.
      expect(calls[0]?.message).toHaveProperty(
        'id',
        calls[1] && 'id' in calls[1].message ? calls[1].message.id : null
      );
    } finally {
      await Promise.all(clients.map((client) => closeMCPClient(client)));
    }
  });
  it('returns a missing-record tool error and permits the requested recovery without changing records', async () => {
    const fixture = await createDesktopEvalFixture();
    fixtures.push(fixture);
    const client = await createMCPClientForConfig(fixture.servers[0]);
    try {
      const mcp = createMCPFixture(client);
      const missing = await mcp.callTool('lookup_record', {
        namespace: 'releases',
        reference: 'missing-release',
      });
      expect(missing.isError).toBe(true);
      expect(missing.structuredContent).toEqual({
        serverLabel: 'desktop_records',
        code: 'NOT_FOUND',
        reference: 'missing-release',
        recovery:
          'Search releases by title, then look up a returned reference.',
      });
      const search = await mcp.callTool('search_records', {
        namespace: 'releases',
        query: 'recovery release',
      });
      const matches = z
        .object({
          matches: z.array(z.object({ reference: z.string() })),
        })
        .parse(search.structuredContent).matches;
      expect(matches).toHaveLength(1);
      const recovered = await mcp.callTool('lookup_record', {
        namespace: 'releases',
        reference: matches[0]!.reference,
      });
      expect(recovered.isError).toBe(false);
      expect(recovered.structuredContent).toEqual({
        serverLabel: 'desktop_records',
        record: fixture.oracle.recovery,
      });
      expect(
        await mcp.callTool('lookup_record', {
          namespace: 'releases',
          reference: 'missing-release',
        })
      ).toEqual(missing);
      const ledger = await fixture.waitForLedger(
        (entries) =>
          entries.filter(
            (entry) =>
              entry.direction === 'response' &&
              'result' in entry.message &&
              typeof entry.message.result.isError === 'boolean'
          ).length === 4
      );
      expect(
        ledger
          .filter(
            (entry) =>
              entry.direction === 'response' && 'result' in entry.message
          )
          .map((entry) =>
            'result' in entry.message ? entry.message.result.isError : null
          )
          .filter((value) => typeof value === 'boolean')
      ).toEqual([true, false, false, true]);
    } finally {
      await closeMCPClient(client);
    }
  });
  it('requires the fresh reference returned by search before a dependent lookup', async () => {
    const fixture = await createDesktopEvalFixture();
    fixtures.push(fixture);
    const client = await createMCPClientForConfig(fixture.servers[0]);
    try {
      const mcp = createMCPFixture(client);
      const search = await mcp.callTool('search_records', {
        namespace: 'releases',
        query: 'dependent release',
      });
      expect(search.isError).toBe(false);
      const matches = z
        .object({
          matches: z.array(
            z.object({ reference: z.string(), title: z.string() })
          ),
        })
        .parse(search.structuredContent).matches;
      expect(matches).toEqual([
        {
          reference: fixture.oracle.dependent.reference,
          title: 'Dependent release',
        },
      ]);
      expect(JSON.stringify(search)).not.toContain(
        fixture.oracle.dependent.verificationCode
      );
      const response = await mcp.callTool('lookup_record', {
        namespace: 'releases',
        reference: matches[0]!.reference,
      });
      expect(response.structuredContent).toEqual({
        serverLabel: 'desktop_records',
        record: fixture.oracle.dependent,
      });
      const ledger = await fixture.readLedger();
      const calls = ledger.filter(
        (entry) =>
          entry.direction === 'request' &&
          'method' in entry.message &&
          entry.message.method === 'tools/call'
      );
      expect(
        calls.map((entry) =>
          'params' in entry.message ? entry.message.params?.name : null
        )
      ).toEqual(['search_records', 'lookup_record']);
      expect(ledger.map((entry) => entry.sequence)).toEqual(
        ledger.map((_, index) => index + 1)
      );
    } finally {
      await closeMCPClient(client);
    }
  });
  it('serves a fresh direct lookup through SDK stdio and records the actual exchange privately', async () => {
    const fixture = await createDesktopEvalFixture();
    fixtures.push(fixture);
    const client = await createMCPClientForConfig(fixture.servers[0]);
    try {
      const mcp = createMCPFixture(client);
      expect(mcp.getServerInfo()).toEqual({
        name: fixture.oracle.primary.serverName,
        version: '1.0.0',
      });
      expect(await mcp.listTools()).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            name: 'lookup_record',
            annotations: expect.objectContaining({
              readOnlyHint: true,
              destructiveHint: false,
              openWorldHint: false,
            }),
          }),
        ])
      );
      const response = await mcp.callTool('lookup_record', {
        namespace: 'releases',
        reference: fixture.oracle.direct.reference,
      });
      expect(response.isError).toBe(false);
      expect(response.structuredContent).toEqual({
        serverLabel: 'desktop_records',
        record: fixture.oracle.direct,
      });
      const ledger = await fixture.waitForLedger((entries) =>
        entries.some(
          (entry) =>
            entry.direction === 'response' &&
            'id' in entry.message &&
            entry.message.id === 2
        )
      );
      const request = ledger.find(
        (entry) =>
          entry.direction === 'request' &&
          'method' in entry.message &&
          entry.message.method === 'tools/call'
      );
      expect(request).toMatchObject({
        runId: fixture.oracle.runId,
        serverLabel: 'desktop_records',
        serverName: fixture.oracle.primary.serverName,
        message: {
          method: 'tools/call',
          params: {
            name: 'lookup_record',
            arguments: {
              namespace: 'releases',
              reference: fixture.oracle.direct.reference,
            },
          },
        },
      });
      expect(ledger.at(-1)).toMatchObject({
        direction: 'response',
        sessionId: request?.sessionId,
        message: {
          id: request && 'id' in request.message ? request.message.id : null,
          result: response,
        },
      });
      expect(await readdir(fixture.workspaceDir)).toEqual([]);
      expect(fixture.privateDir.startsWith(`${fixture.workspaceDir}/`)).toBe(
        false
      );
      expect((await stat(fixture.privateDir)).mode & 0o777).toBe(0o700);
      expect((await stat(fixture.ledgerPath)).mode & 0o777).toBe(0o600);
    } finally {
      await closeMCPClient(client);
    }
  });
});
