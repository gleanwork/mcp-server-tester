import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runCrossEraChecks } from './crossEra.js';
import type { MCPConfig } from '../config/mcpConfig.js';

const mock = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../tests/mocks/dualEraServer.ts'
);

function mockConfig(env: Record<string, string>): MCPConfig {
  return {
    transport: 'stdio',
    command: process.execPath,
    args: ['--import', 'tsx', mock],
    env,
    quiet: true,
  };
}

function check(
  result: Awaited<ReturnType<typeof runCrossEraChecks>>,
  name: string
) {
  return result.checks.find((c) => c.name === name);
}

describe('runCrossEraChecks', () => {
  it('passes for a dual-era server that serves both eras identically', async () => {
    const result = await runCrossEraChecks(mockConfig({ MOCK_ERA: 'dual' }));

    expect(result.checks.filter((c) => !c.pass)).toEqual([]);
    expect(result.pass).toBe(true);
    expect(result.connections.map((c) => c.info?.era)).toEqual([
      'legacy',
      'modern',
    ]);
    expect(check(result, 'cross_era_tools_match')?.pass).toBe(true);
    expect(check(result, 'cross_era_tool_definitions_match')?.pass).toBe(true);
    expect(check(result, 'auto_selects_modern')?.pass).toBe(true);
  }, 60_000);

  it('fails when the server exposes different tools per era', async () => {
    const result = await runCrossEraChecks(
      mockConfig({ MOCK_ERA: 'dual', MOCK_DIVERGE: '1' })
    );

    expect(result.pass).toBe(false);
    const tools = check(result, 'cross_era_tools_match');
    expect(tools?.pass).toBe(false);
    expect(tools?.message).toContain('modern_only');
  }, 60_000);

  it('fails to connect a legacy-only server on 2026-07-28', async () => {
    const result = await runCrossEraChecks(mockConfig({ MOCK_ERA: 'legacy' }));

    expect(result.pass).toBe(false);
    const connect = check(result, 'cross_era_connect');
    expect(connect?.pass).toBe(false);
    expect(connect?.message).toContain('2026-07-28');
    // auto is only checked when a modern connection succeeded.
    expect(check(result, 'auto_selects_modern')).toBeUndefined();
  }, 60_000);

  it('fails to connect a modern-only server on legacy', async () => {
    const result = await runCrossEraChecks(mockConfig({ MOCK_ERA: 'modern' }));

    const connect = check(result, 'cross_era_connect');
    expect(connect?.pass).toBe(false);
    expect(connect?.message).toMatch(/^legacy: /);
  }, 60_000);

  it('compares any protocols it is given', async () => {
    const result = await runCrossEraChecks(mockConfig({ MOCK_ERA: 'dual' }), {
      protocols: ['2025-06-18', '2025-11-25', '2026-07-28'],
      checkAuto: false,
    });

    expect(result.pass).toBe(true);
    expect(result.connections.map((c) => c.info?.negotiated)).toEqual([
      '2025-06-18',
      '2025-11-25',
      '2026-07-28',
    ]);
    expect(check(result, 'auto_selects_modern')).toBeUndefined();
  }, 60_000);

  it('rejects fewer than two protocols', async () => {
    await expect(
      runCrossEraChecks(mockConfig({}), { protocols: ['legacy'] })
    ).rejects.toThrow(/at least two/);
  });
});
