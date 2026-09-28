import { z } from 'zod';
import { test, expect } from '../src/fixtures/mcp.js';

/**
 * The fixture's resources, extension-request, and skills helpers, in every
 * protocol-matrix project.
 */
test.describe('Fixture: discovery, resources, and skills', () => {
  test('discover() returns the DiscoverResult only on modern connections', async ({
    mcp,
  }) => {
    const discover = await mcp.discover();
    if (mcp.protocol.era === 'modern') {
      expect(discover?.supportedVersions).toContain(mcp.protocol.negotiated);
    } else {
      expect(discover).toBeNull();
    }
  });

  test('lists and reads resources', async ({ mcp }) => {
    const resources = await mcp.listResources();
    expect(resources.map((r) => r.uri)).toContain(
      'skill://weather-report/SKILL.md'
    );
    const read = await mcp.readResource(
      'skill://weather-report/references/STYLE.md'
    );
    expect(read.contents[0]).toMatchObject({ mimeType: 'text/markdown' });
  });

  test('request() calls extension methods with a result schema', async ({
    mcp,
  }) => {
    const result = await mcp.request(
      'skills/list',
      {},
      z.object({ skills: z.array(z.object({ uri: z.string() })) })
    );
    expect(result.skills.map((s) => s.uri)).toEqual([
      'skill://weather-report/SKILL.md',
    ]);
  });

  test('skills: list, get, and verified reads', async ({ mcp }) => {
    expect(mcp.skills.supported()).toBe(true);
    expect(mcp.skills.settings()).toEqual({ directoryRead: true });

    const [entry] = await mcp.skills.list();
    expect(entry?.frontmatter.name).toBe('weather-report');
    expect(await mcp.skills.get(entry!.uri)).toEqual(entry);

    const skillMd = await mcp.skills.read(entry!.uri);
    expect(skillMd.verified).toBe(true);
    expect(skillMd.text).toContain('# Weather report');

    const style = await mcp.skills.read(
      'skill://weather-report/references/STYLE.md'
    );
    expect(style.verified).toBe(true);
  });

  test('skills.read() reports a mismatch against a stale entry', async ({
    mcp,
  }) => {
    const [entry] = await mcp.skills.list();
    const stale = {
      ...entry!,
      frontmatter: { ...entry!.frontmatter, description: 'old text' },
    };
    const read = await mcp.skills.read(entry!.uri, { entry: stale });
    expect(read.verified).toBe(false);
    expect(read.problems.join(' ')).toContain('frontmatter');
  });
});
