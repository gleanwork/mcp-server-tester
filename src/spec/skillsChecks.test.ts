import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  closeMCPClient,
  createMCPClientForConfig,
} from '../mcp/clientFactory.js';
import { createMCPFixture } from '../mcp/fixtures/mcpFixture.js';
import { runConformanceChecks } from './conformanceChecks.js';
import type { MCPConformanceResult } from './conformanceChecks.js';
import type { ProtocolSetting } from '../types/index.js';

/**
 * Integration tests for the SEP-2640 skills checks against the dual-era mock
 * (tests/mocks/mockSkills.ts), in both eras. MOCK_SKILL_FAULTS switches on
 * one violation at a time.
 */
const mock = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../tests/mocks/dualEraServer.ts'
);

const SKILLS_CHECKS = [
  'skills_extension_declares_resources',
  'skills_list_succeeds',
  'skills_entries_valid',
  'skills_within_limits',
  'skills_get_matches_list',
  'skills_get_unknown_uri',
  'skills_content_verified',
  'skill_md_resource_metadata',
  'skills_directory_read',
];

async function check(
  protocol: ProtocolSetting,
  faults: string[] = [],
  options: Parameters<typeof runConformanceChecks>[1] = {},
  variants: string[] = []
): Promise<MCPConformanceResult> {
  const client = await createMCPClientForConfig({
    transport: 'stdio',
    command: process.execPath,
    args: ['--import', 'tsx', mock],
    env: {
      MOCK_SKILL_FAULTS: faults.join(','),
      MOCK_SKILL_VARIANTS: variants.join(','),
    },
    quiet: true,
    protocol,
  });
  try {
    return await runConformanceChecks(createMCPFixture(client), options);
  } finally {
    await closeMCPClient(client);
  }
}

function named(result: MCPConformanceResult, name: string) {
  const found = result.checks.find((c) => c.name === name);
  if (!found) throw new Error(`check ${name} not reported`);
  return found;
}

describe.each(['legacy', '2026-07-28'] as const)(
  'skills checks on %s',
  (protocol) => {
    it('a conformant skills server passes every skills check', async () => {
      const result = await check(protocol, [], {
        skills: { verifyFiles: 'all' },
      });
      for (const name of SKILLS_CHECKS) {
        const found = named(result, name);
        expect(found.pass, `${name}: ${found.message}`).toBe(true);
        expect(found.skipped, name).toBeFalsy();
      }
      expect(
        result.checks.some((c) => c.name === 'skills_list_cache_hints')
      ).toBe(protocol !== 'legacy');
      expect(result.pass).toBe(true);
    }, 30_000);

    it.each([
      ['bad-digest', 'skills_content_verified', 'must'],
      ['wrong-size', 'skills_content_verified', 'must'],
      ['frontmatter-mismatch', 'skills_content_verified', 'must'],
      ['name-mismatch', 'skills_entries_valid', 'must'],
      ['unlisted-skill-md', 'skills_entries_valid', 'must'],
      ['get-differs', 'skills_get_matches_list', 'should'],
      ['no-resources', 'skills_extension_declares_resources', 'must'],
      ['list-error', 'skills_list_succeeds', 'must'],
      ['invalid-entry', 'skills_entries_valid', 'must'],
      ['dir-unknown-ok', 'skills_directory_read', 'must'],
      ['get-unknown-ok', 'skills_get_unknown_uri', 'must'],
      ['bad-mime', 'skill_md_resource_metadata', 'should'],
      ['dir-accepts-files', 'skills_directory_read', 'must'],
    ] as const)(
      'fault %s fails %s (%s)',
      async (fault, name, severity) => {
        const result = await check(protocol, [fault]);
        const failed = named(result, name);
        expect(failed.pass).toBe(false);
        expect(failed.severity).toBe(severity);
        expect(result.pass).toBe(severity === 'should');
      },
      30_000
    );
  }
);

describe.each(['legacy', '2026-07-28'] as const)(
  'SEP-legal skill variations pass on %s',
  (protocol) => {
    it.each([['blob'], ['dynamic'], ['paginate'], ['get-extra']])(
      'variant %s passes every skills check',
      async (variant) => {
        const result = await check(protocol, [], {}, [variant]);
        const notPassing = result.checks.filter(
          (c) => c.name.startsWith('skill') && !c.pass
        );
        expect(notPassing, JSON.stringify(notPassing, null, 2)).toEqual([]);
        expect(named(result, 'skills_content_verified').skipped).toBeFalsy();
      },
      30_000
    );

    it('reports a listing cut off at maxPages instead of failing it', async () => {
      const result = await check(protocol, [], { skills: { maxPages: 1 } }, [
        'paginate',
      ]);
      const listed = named(result, 'skills_list_succeeds');
      expect(listed.pass).toBe(true);
      expect(listed.message).toContain('stopped after 1 page(s)');
    }, 30_000);

    it('a malformed entry fails skills_entries_valid without hiding the rest', async () => {
      const result = await check(protocol, ['invalid-entry']);
      expect(named(result, 'skills_list_succeeds').pass).toBe(true);
      expect(named(result, 'skills_entries_valid').message).toContain(
        'malformed entry'
      );
      expect(named(result, 'skills_content_verified').pass).toBe(true);
    }, 30_000);
  }
);

describe('skills checks, era-specific and options', () => {
  it('requires cache hints on skills/list for 2026-07-28', async () => {
    const result = await check('2026-07-28', ['no-cache-hints']);
    expect(named(result, 'skills_list_cache_hints').pass).toBe(false);
    expect(result.pass).toBe(false);
  }, 30_000);

  it('does not require cache hints on legacy', async () => {
    const result = await check('legacy', ['no-cache-hints']);
    expect(
      result.checks.some((c) => c.name === 'skills_list_cache_hints')
    ).toBe(false);
    expect(result.pass).toBe(true);
  }, 30_000);

  it('skills: false turns the skills checks off', async () => {
    const result = await check('legacy', [], { skills: false });
    for (const name of SKILLS_CHECKS) {
      expect(
        result.checks.some((c) => c.name === name),
        name
      ).toBe(false);
    }
  }, 30_000);

  it('verifies only SKILL.md by default', async () => {
    const result = await check('legacy');
    expect(named(result, 'skills_content_verified').message).toMatch(/^1 file/);
  }, 30_000);
});
