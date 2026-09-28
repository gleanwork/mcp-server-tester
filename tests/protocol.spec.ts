import { test, expect } from '../src/fixtures/mcp.js';

/**
 * Runs in every protocol-matrix project and checks the connection negotiated
 * what the project asked for.
 */
test.describe('Protocol negotiation', () => {
  test('negotiates the requested protocol', async ({ mcp }) => {
    const { requested, negotiated, era } = mcp.protocol;

    if (requested === 'legacy') {
      expect(era).toBe('legacy');
    } else if (requested === 'auto') {
      // The dual-era mock supports 2026-07-28, so auto lands on modern.
      expect(era).toBe('modern');
    } else {
      expect(negotiated).toBe(requested);
    }
  });

  test('serves the same tools in every era', async ({ mcp }) => {
    const tools = await mcp.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      'calculate',
      'echo',
      'get_city_info',
      'get_weather',
    ]);
  });
});
