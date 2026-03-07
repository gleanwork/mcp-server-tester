import type { StdioMCPConfig } from '@gleanwork/mcp-server-tester';

export function getStdioConfig(): StdioMCPConfig {
  return {
    transport: 'stdio',
    command: 'node',
    args: ['server.js'],
    env: {
      NODE_ENV: 'test',
    },
  };
}
