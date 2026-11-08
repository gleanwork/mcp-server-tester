import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { test, expect } from '../../src/fixtures/mcp.js';
import { runConformanceChecks } from '../../src/spec/conformanceChecks.js';

/**
 * The docs site's MCP endpoint (website/api/mcp.mjs on the built bundle),
 * tested with MST itself, in both protocol eras. Run with `npm run test:site`
 * after building the site.
 */

/** The skills in the repo's skills/ directory: the ones the site must serve. */
const repoSkills = readdirSync(
  fileURLToPath(new URL('../../skills/', import.meta.url)),
  { withFileTypes: true }
)
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort();

test.describe('Docs site MCP server', () => {
  test('passes the conformance checks', async ({ mcp }, testInfo) => {
    const result = await runConformanceChecks(mcp, {}, testInfo);
    expect(result.pass).toBe(true);
    expect(result.raw.serverInfo?.name).toBe('mcp-server-tester');
  });

  test('serves the docs tools', async ({ mcp }) => {
    const tools = await mcp.listTools();
    expect(tools.map((tool) => tool.name)).toEqual(
      expect.arrayContaining(['docs_search', 'docs_fetch'])
    );
  });

  test('docs_search finds a page by an API name', async ({ mcp }) => {
    const result = await mcp.callTool('docs_search', {
      query: 'toContainToolText',
    });
    expect(result).not.toBeToolError();
    expect(result).toContainToolText('/docs/assertions');
  });

  test('docs_fetch returns a page as Markdown', async ({ mcp }) => {
    const result = await mcp.callTool('docs_fetch', {
      url: '/docs/quickstart',
    });
    expect(result).not.toBeToolError();
    expect(result).toContainToolText('# Quick Start Guide');
  });

  test("serves every skill in the repo's skills/ directory", async ({
    mcp,
  }) => {
    for (const skill of repoSkills) {
      const result = await mcp.callTool('docs_fetch', {
        url: `skill://${skill}/SKILL.md`,
      });
      expect(result, skill).not.toBeToolError();
      expect(result, skill).toContainToolText(`name: ${skill}`);
    }
  });

  test('lists the skills through the skills extension', async ({ mcp }) => {
    test.skip(
      !mcp.skills.supported(),
      `The server doesn't declare the skills extension on ${mcp.protocol.negotiated}`
    );
    const entries = await mcp.skills.list();
    const names = entries.map((entry) => entry.frontmatter.name).sort();
    expect(names).toEqual([...repoSkills, 'docs-research'].sort());
    for (const entry of entries) {
      const read = await mcp.skills.read(entry.uri);
      expect(read.verified, entry.uri).toBe(true);
    }
  });
});
