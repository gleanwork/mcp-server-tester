import { test, expect } from '../src/fixtures/mcp.js';
import { runConformanceChecks } from '../src/spec/conformanceChecks.js';
import { runCrossEraChecks } from '../src/spec/crossEra.js';
import type { MCPConfig } from '../src/config/mcpConfig.js';

/** Modern checks every conformant server must pass on any transport. */
const MODERN_CHECKS = [
  'discover_succeeds',
  'discover_server_info',
  'tools_list_deterministic',
  'tools_list_stable_across_connections',
  'unknown_tool_protocol_error',
  'unsupported_version_rejected',
  'missing_meta_rejected',
  'result_type_present',
  'cache_hints_present',
  'result_server_info',
  'reserved_error_codes',
];

/** Modern checks that only run over Streamable HTTP. */
const MODERN_HTTP_CHECKS = [
  'header_mismatch_rejected',
  'unknown_method_not_found',
  'no_session_id',
];

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

  test('passes the conformance checks for its era', async ({
    mcp,
  }, testInfo) => {
    const result = await runConformanceChecks(mcp, {}, testInfo);
    const byName = new Map(result.checks.map((c) => [c.name, c]));

    const notPassing = result.checks.filter((c) => !c.pass && !c.skipped);
    expect(notPassing, JSON.stringify(notPassing, null, 2)).toEqual([]);
    expect(result.pass).toBe(true);
    expect(result.protocol).toEqual(mcp.protocol);

    const isHttp = testInfo.project.name.startsWith('dual-http');
    if (mcp.protocol.era === 'modern') {
      for (const name of MODERN_CHECKS) {
        expect(byName.get(name)?.skipped, name).toBeFalsy();
      }
      for (const name of MODERN_HTTP_CHECKS) {
        expect(Boolean(byName.get(name)?.skipped), name).toBe(!isHttp);
      }
    } else {
      // Legacy connections run exactly the pre-2.0 check set.
      for (const name of [...MODERN_CHECKS, ...MODERN_HTTP_CHECKS]) {
        expect(byName.has(name), name).toBe(false);
      }
    }
  });

  // eslint-disable-next-line no-empty-pattern
  test('serves legacy and 2026-07-28 clients identically', async ({}, testInfo) => {
    // Once per transport is enough; the matrix already covers the eras.
    test.skip(
      !/^dual-(stdio|http)@legacy$/.test(testInfo.project.name),
      'cross-era checks run in the @legacy project of each transport'
    );
    const { mcpConfig } = testInfo.project.use as { mcpConfig: MCPConfig };
    const result = await runCrossEraChecks(mcpConfig, {}, testInfo);
    const notPassing = result.checks.filter((c) => !c.pass);
    expect(notPassing, JSON.stringify(notPassing, null, 2)).toEqual([]);
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
