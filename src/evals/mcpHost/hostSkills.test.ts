import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  closeMCPClient,
  createMCPClientForConfig,
} from '../../mcp/clientFactory.js';
import { createMCPFixture } from '../../mcp/fixtures/mcpFixture.js';
import { getWireTap } from '../../mcp/wireTap.js';
import type { MCPFixtureApi } from '../../mcp/fixtures/mcpFixture.js';
import type { ProtocolSetting } from '../../types/index.js';
import { createHostSkillsSession, withSkillEvents } from './hostSkills.js';
import type { HostEvent } from '../evalFrameworkTypes.js';

const mock = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../tests/mocks/dualEraServer.ts'
);
const SKILL = 'skill://weather-report/SKILL.md';

async function withFixture<T>(
  protocol: ProtocolSetting,
  run: (mcp: MCPFixtureApi) => Promise<T>,
  faults: string[] = []
): Promise<T> {
  const client = await createMCPClientForConfig({
    transport: 'stdio',
    command: process.execPath,
    args: ['--import', 'tsx', mock],
    env: { MOCK_SKILL_FAULTS: faults.join(',') },
    quiet: true,
    protocol,
  });
  try {
    return await run(createMCPFixture(client));
  } finally {
    await closeMCPClient(client);
  }
}

function resourceReads(mcp: MCPFixtureApi): string[] {
  return (getWireTap(mcp.client)?.exchanges() ?? [])
    .filter((exchange) => exchange.method === 'resources/read')
    .map((exchange) =>
      String((exchange.request.params as { uri: string }).uri)
    );
}

describe.each(['legacy', '2026-07-28'] as const)(
  'host skills session (%s)',
  (protocol) => {
    it('catalog: lists skills without fetching any skill file', async () => {
      await withFixture(protocol, async (mcp) => {
        const session = await createHostSkillsSession(mcp, 'catalog', {
          countToolCalls: () => 0,
        });
        expect(session?.system).toContain('<name>weather-report</name>');
        expect(session?.system).toContain(`<uri>${SKILL}</uri>`);
        expect(session?.system).toContain('<server>mcp</server>');
        expect(session?.system).toContain('untrusted');
        expect(Object.keys(session!.tools).sort()).toEqual([
          'read_resource',
          'read_skill',
        ]);
        // SEP-2640: no retrieval ahead of need.
        expect(resourceReads(mcp)).toEqual([]);
      });
    }, 30_000);

    it('read_skill loads and verifies SKILL.md, then relative files resolve', async () => {
      await withFixture(protocol, async (mcp) => {
        let toolCalls = 0;
        const session = (await createHostSkillsSession(mcp, 'catalog', {
          countToolCalls: () => toolCalls,
        }))!;

        const skill = await session.tools.read_skill!.execute({
          server: 'mcp',
          uri: SKILL,
        });
        expect(skill).toContain('<skill name="weather-report" server="mcp"');
        expect(skill).toContain('# Weather report');

        toolCalls = 1;
        const style = await session.tools.read_resource!.execute({
          server: 'mcp',
          uri: 'references/STYLE.md',
        });
        expect(style).toContain('# Report style');

        expect(session.loads).toEqual([
          expect.objectContaining({
            name: 'weather-report',
            uri: SKILL,
            kind: 'skill',
            via: 'read_skill',
            verified: true,
            afterToolCalls: 0,
          }),
          expect.objectContaining({
            uri: 'skill://weather-report/references/STYLE.md',
            kind: 'file',
            verified: true,
            afterToolCalls: 1,
          }),
        ]);
        expect(resourceReads(mcp)).toEqual([
          SKILL,
          'skill://weather-report/references/STYLE.md',
        ]);
      });
    }, 30_000);

    it('rejects other servers and files outside the loaded skill', async () => {
      await withFixture(protocol, async (mcp) => {
        const session = (await createHostSkillsSession(mcp, 'catalog', {
          countToolCalls: () => 0,
        }))!;
        expect(
          await session.tools.read_skill!.execute({
            server: 'other',
            uri: SKILL,
          })
        ).toMatch(/^Error: unknown server "other"/);

        await session.tools.read_skill!.execute({ server: 'mcp', uri: SKILL });
        expect(
          await session.tools.read_resource!.execute({
            server: 'mcp',
            uri: 'skill://weather-report/references/UNLISTED.md',
          })
        ).toMatch(/not part of the loaded skill/);
        expect(session.loads.at(-1)).toMatchObject({ verified: false });

        expect(
          await session.tools.read_skill!.execute({
            server: 'mcp',
            uri: 'skill://nope/SKILL.md',
          })
        ).toMatch(/is not a skill served by "mcp"/);
      });
    }, 30_000);

    it('refuses a skill whose content does not match its digest', async () => {
      await withFixture(
        protocol,
        async (mcp) => {
          const session = (await createHostSkillsSession(mcp, 'catalog', {
            countToolCalls: () => 0,
          }))!;
          const output = await session.tools.read_skill!.execute({
            server: 'mcp',
            uri: SKILL,
          });
          expect(output).toMatch(/failed verification and was not loaded/);
          expect(output).not.toContain('# Weather report');
          expect(session.loads).toEqual([
            expect.objectContaining({ kind: 'skill', verified: false }),
          ]);
          // A refused skill does not unlock its supporting files.
          const style = await session.tools.read_resource!.execute({
            server: 'mcp',
            uri: 'references/STYLE.md',
          });
          expect(style).toMatch(/^Error:/);
        },
        ['bad-digest']
      );
    }, 30_000);

    it('preload: puts verified SKILL.md content in the system prompt', async () => {
      await withFixture(protocol, async (mcp) => {
        const session = (await createHostSkillsSession(mcp, 'preload', {
          countToolCalls: () => 0,
        }))!;
        expect(session.system).toContain('# Weather report');
        expect(Object.keys(session.tools)).toEqual(['read_resource']);
        expect(session.loads).toEqual([
          expect.objectContaining({ via: 'preload', verified: true }),
        ]);
      });
    }, 30_000);

    it('returns null when skills are off', async () => {
      await withFixture(protocol, async (mcp) => {
        expect(
          await createHostSkillsSession(mcp, 'off', { countToolCalls: () => 0 })
        ).toBeNull();
        expect(
          await createHostSkillsSession(mcp, undefined, {
            countToolCalls: () => 0,
          })
        ).toBeNull();
      });
    }, 30_000);
  }
);

describe('withSkillEvents', () => {
  const tool = (name: string): HostEvent => ({
    kind: 'tool_call',
    source: 'mcp',
    name,
  });

  it('places skill events after the tool calls that preceded them', () => {
    const events = withSkillEvents(
      [tool('a'), tool('b')],
      [
        {
          name: 's1',
          uri: 'skill://s1/SKILL.md',
          server: 'mcp',
          kind: 'skill',
          via: 'read_skill',
          verified: true,
          afterToolCalls: 0,
        },
        {
          name: 'file',
          uri: 'skill://s1/x.md',
          server: 'mcp',
          kind: 'file',
          via: 'read_resource',
          verified: true,
          afterToolCalls: 1,
        },
        {
          name: 's2',
          uri: 'skill://s2/SKILL.md',
          server: 'mcp',
          kind: 'skill',
          via: 'read_skill',
          verified: false,
          afterToolCalls: 1,
        },
        {
          name: 's3',
          uri: 'skill://s3/SKILL.md',
          server: 'mcp',
          kind: 'skill',
          via: 'read_skill',
          verified: true,
          afterToolCalls: 2,
        },
      ]
    );
    expect(events.map((e) => `${e.kind}:${e.name}`)).toEqual([
      'skill:s1',
      'tool_call:a',
      'tool_call:b',
      'skill:s3',
    ]);
  });
});
