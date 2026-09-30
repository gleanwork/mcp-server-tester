import { describe, it, expect } from 'vitest';
import { protocolMatrix } from './protocolMatrix.js';
import type { MCPConfig } from './mcpConfig.js';

const mcpConfig: MCPConfig = {
  transport: 'stdio',
  command: 'node',
  args: ['server.js'],
};

describe('protocolMatrix', () => {
  it('creates one named project per protocol', () => {
    const projects = protocolMatrix(
      { name: 'docs', testMatch: /.*\.spec\.ts/, use: { mcpConfig } },
      ['legacy', '2026-07-28']
    );

    expect(projects.map((p) => p.name)).toEqual([
      'docs@legacy',
      'docs@2026-07-28',
    ]);
    expect(projects[0]?.testMatch).toEqual(/.*\.spec\.ts/);
  });

  it('sets both the fixture option and mcpConfig.protocol', () => {
    const [project] = protocolMatrix({ name: 'docs', use: { mcpConfig } }, [
      '2026-07-28',
    ]);

    expect(project?.use?.mcpProtocol).toBe('2026-07-28');
    expect(project?.use?.mcpConfig).toEqual({
      ...mcpConfig,
      protocol: '2026-07-28',
    });
  });

  it('does not mutate the source project', () => {
    const source = { name: 'docs', use: { mcpConfig } };
    protocolMatrix(source, ['auto']);
    expect(source.use.mcpConfig).toEqual(mcpConfig);
  });

  it('works without an mcpConfig and defaults the name', () => {
    const [project] = protocolMatrix({ use: { other: true } }, ['legacy']);
    expect(project?.name).toBe('mcp@legacy');
    expect(project?.use).toEqual({ other: true, mcpProtocol: 'legacy' });
  });

  it('rejects empty and duplicate lists', () => {
    expect(() => protocolMatrix({ name: 'x' }, [])).toThrow(/at least one/);
    expect(() => protocolMatrix({ name: 'x' }, ['legacy', 'legacy'])).toThrow(
      /duplicate/
    );
  });
});
